// usage: node bench.mjs <mode> [frames] [page]
// modes: shot-x264 | shot-vt | de-jpeg-x264 | de-jpeg-vt | de-wc | de-wc-hevc | de-wc-par | canvas-png-x264 | canvas-wc
// env: WC='{"bitrate":12e6,...}' encoder opts · SCALE=2 (4K) · LOSSLESS=1 (reference capture) · LITE=1 (no box-shadow)
//      PAR=N [MB=1] parallel segments (windows in one browser, or separate browsers) · OUT=file · CHROME=path
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const mode = process.argv[2];
const FRAMES = Number(process.argv[3] || 300);
const PAGE = process.argv[4] || (mode.startsWith('canvas') ? 'canvas.html' : 'comp.html');
const S = Number(process.env.SCALE || 1);
const FPS = 30, W = 1920 * S, H = 1080 * S;
const out = process.env.OUT || `out-${mode}.mp4`;

// ---- process-tree sampler: peak summed RSS + cumulative CPU of node + all descendants ----
const cpuSeen = new Map(); const roleOf = new Map(); let peakRss = 0;
function role(cmd) { if (cmd.includes('--type=gpu-process')) return 'gpu'; if (cmd.includes('--type=renderer')) return 'renderer';
  if (cmd.includes('--type=utility')) return 'utility'; if (/ffmpeg/.test(cmd)) return 'ffmpeg'; if (/Chrome|chrome/.test(cmd)) return 'browser'; if (/ps /.test(cmd)) return 'ps'; return 'node'; }
function parseCpu(s) { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }
function sample() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => l.trim().split(/\s+/)).map(([pid, ppid, rss, time, ...cmd]) => ({ pid: +pid, ppid: +ppid, rss: +rss, cpu: parseCpu(time), cmd: cmd.join(' ') }));
  const kids = new Map(); rows.forEach((r) => { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); });
  const tree = []; const stack = [rows.find((r) => r.pid === process.pid)];
  while (stack.length) { const r = stack.pop(); if (!r) continue; tree.push(r); (kids.get(r.pid) || []).forEach((k) => stack.push(k)); }
  let rss = 0; tree.forEach((r) => { rss += r.rss; cpuSeen.set(r.pid, Math.max(cpuSeen.get(r.pid) || 0, r.cpu)); if (!roleOf.has(r.pid)) roleOf.set(r.pid, role(r.cmd)); });
  peakRss = Math.max(peakRss, rss);
}
const sampler = setInterval(sample, 200);

function ffmpeg(args) {
  const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, no) => p.on('close', (c) => (c === 0 ? ok() : no(new Error('ffmpeg ' + c)))));
  return { p, done, write: (b) => (p.stdin.write(b) ? null : new Promise((r) => p.stdin.once('drain', r))) };
}
const enc = (vt) => process.env.LOSSLESS ? ['-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0'] : vt ? ['-c:v', 'h264_videotoolbox', '-q:v', '65'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];

const t0 = performance.now();
const srv = await serve(new URL('./www', import.meta.url).pathname);
const launchOpts = {
  executablePath: CHROME, headless: true, defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: process.env.DSF ? S : 1 },
  args: ['--enable-features=CanvasDrawElement', '--enable-blink-features=CanvasDrawElement', '--use-angle=metal',
    '--disable-gpu-vsync', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(process.env.XFLAGS ? process.env.XFLAGS.split(' ') : [])],
  protocolTimeout: 600000,
};
const browser = await puppeteer.launch(launchOpts);
const extraBrowsers = [];
const page = await browser.newPage();
const de = mode.startsWith('de');
await page.goto(`${srv.url}/${PAGE}?mode=${de ? 'de' : 'dom'}${process.env.LITE ? '&lite' : ''}&scale=${S}`);
const tReady = performance.now();
let bytes = 0;

if (mode.startsWith('shot')) {
  const cdp = await page.createCDPSession();
  const ff = ffmpeg(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', process.env.LOSSLESS ? 'png' : 'mjpeg', '-i', '-', ...enc(mode.endsWith('vt')), ...(process.env.LOSSLESS ? [] : ['-pix_fmt', mode.endsWith('vt') ? 'nv12' : 'yuv420p']), out]);
  for (let i = 0; i < FRAMES; i++) {
    await cdp.send('Runtime.evaluate', { expression: `__seek(${i / FPS})` });
    const { data } = await cdp.send('Page.captureScreenshot', process.env.LOSSLESS ? { format: 'png' } : { format: 'jpeg', quality: 92, optimizeForSpeed: true });
    const buf = Buffer.from(data, 'base64'); bytes += buf.length; await ff.write(buf);
  }
  ff.p.stdin.end(); await ff.done;
} else if (mode.startsWith('de-jpeg') || mode === 'canvas-png-x264') {
  const png = mode === 'canvas-png-x264';
  const ff = ffmpeg(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', png || process.env.LOSSLESS ? 'png' : 'mjpeg', '-i', '-', ...enc(mode.endsWith('vt')), ...(process.env.LOSSLESS ? [] : ['-pix_fmt', mode.endsWith('vt') ? 'nv12' : 'yuv420p']), out]);
  // batch of frames per evaluate to amortize CDP round trips, like the official worker-encode batching
  const B = 10;
  for (let s = 0; s < FRAMES; s += B) {
    const urls = await page.evaluate(async (s, n, FPS, png, lossless) => {
      const res = [];
      for (let i = s; i < s + n; i++) res.push(await window.__captureDataUrl(i / FPS, png || lossless));
      return res;
    }, s, Math.min(B, FRAMES - s), FPS, png, !!process.env.LOSSLESS);
    for (const u of urls) { const buf = Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'); bytes += buf.length; await ff.write(buf); }
  }
  ff.p.stdin.end(); await ff.done;
} else if (mode.endsWith('-par')) {
  // N pages in ONE browser, each renders a contiguous segment with its own encoder; stream-copy concat.
  const N = Number(process.env.PAR || 2), per = Math.ceil(FRAMES / N);
  const pages = [page, ...(await Promise.all(Array.from({ length: N - 1 }, async () => { const b = process.env.MB ? await puppeteer.launch(launchOpts) : browser; if (process.env.MB) extraBrowsers.push(b); const p = await (process.env.MB ? b.newPage() : b.newPage({ type: 'window' })); await p.setViewport({ width: 1920, height: 1080 }); await p.goto(`${srv.url}/${PAGE}?mode=${de ? 'de' : 'dom'}`); return p; })))];
  const files = Array.from({ length: N }, (_, k) => fs.createWriteStream(`seg-${k}.h264`));
  await Promise.all(pages.map((p) => p.exposeFunction('__chunk', (b64, seg) => { const b = Buffer.from(b64, 'base64'); bytes += b.length; files[seg].write(b); })));
  const sts = await Promise.all(pages.map((p, k) => p.evaluate(async (n, FPS, W, H, o) => window.__renderWebCodecs(n, FPS, W, H, false, o), Math.min(per, FRAMES - k * per), FPS, W, H, { start: k * per, seg: k })));
  console.error('page stats', JSON.stringify(sts));
  await Promise.all(files.map((f) => new Promise((r) => f.end(r))));
  // Each segment starts on an IDR with in-band SPS/PPS, so Annex-B segments concatenate byte-wise.
  fs.writeFileSync('segs.h264', Buffer.concat(files.map((_, k) => fs.readFileSync(`seg-${k}.h264`))));
  const ff = ffmpeg(['-f', 'h264', '-r', String(FPS), '-i', 'segs.h264', '-c', 'copy', out]);
  ff.p.stdin.end(); await ff.done;
} else if (mode.startsWith('de-wc') || mode === 'canvas-wc') {
  const hevc = mode.endsWith('hevc');
  const raw = fs.createWriteStream(`out-${mode}.${hevc ? 'h265' : 'h264'}`);
  await page.exposeFunction('__chunk', (b64, _seg) => { const b = Buffer.from(b64, 'base64'); bytes += b.length; raw.write(b); });
  const st = await page.evaluate(async (FRAMES, FPS, W, H, hevc, o) => window.__renderWebCodecs(FRAMES, FPS, W, H, hevc, o), FRAMES, FPS, W, H, hevc, JSON.parse(process.env.WC || '{}'));
  console.error('page stats', JSON.stringify(st));
  await new Promise((r) => raw.end(r));
  // stream-copy mux only: no decode, no re-encode
  const ff = ffmpeg(['-f', hevc ? 'hevc' : 'h264', '-r', String(FPS), '-i', `out-${mode}.${hevc ? 'h265' : 'h264'}`, '-c', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : []), out]);
  ff.p.stdin.end(); await ff.done;
}
const tDone = performance.now();
sample(); clearInterval(sampler);
await browser.close(); await Promise.all(extraBrowsers.map((b) => b.close())); srv.close();
const cpu = [...cpuSeen.values()].reduce((a, b) => a + b, 0);
const byRole = {}; for (const [pid, c] of cpuSeen) { const r = roleOf.get(pid); if (r !== 'ps') byRole[r] = +((byRole[r] || 0) + c).toFixed(1); }
const probe = execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_read_packets', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
const size = fs.statSync(out).size;
console.log(JSON.stringify({ mode, frames: FRAMES, startup_s: +((tReady - t0) / 1000).toFixed(2), render_s: +((tDone - tReady) / 1000).toFixed(2),
  fps: +(FRAMES / ((tDone - tReady) / 1000)).toFixed(1), cpu_s: +cpu.toFixed(1), peakRSS_MB: Math.round(peakRss / 1024), transfer_MB: +(bytes / 1e6).toFixed(1), out_MB: +(size / 1e6).toFixed(1), probe, cpu_by_role: byRole }));
