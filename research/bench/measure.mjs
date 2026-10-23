// usage: node measure.mjs <label> -- <cmd> [args...]   — wall time, summed CPU, peak summed RSS of the whole process tree
import { spawn, execFileSync } from 'node:child_process';
const i = process.argv.indexOf('--'); const label = process.argv[2]; const [cmd, ...args] = process.argv.slice(i + 1);
const cpuSeen = new Map(); let peak = 0;
const parseCpu = (s) => { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const t0 = performance.now();
const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
function sample() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([p, pp, r, t]) => ({ p: +p, pp: +pp, r: +r, c: parseCpu(t) }));
  const kids = new Map(); rows.forEach((r) => { if (!kids.has(r.pp)) kids.set(r.pp, []); kids.get(r.pp).push(r); });
  const st = [rows.find((r) => r.p === child.pid)]; let rss = 0;
  while (st.length) { const r = st.pop(); if (!r) continue; rss += r.r; cpuSeen.set(r.p, Math.max(cpuSeen.get(r.p) || 0, r.c)); (kids.get(r.p) || []).forEach((k) => st.push(k)); }
  peak = Math.max(peak, rss);
}
const iv = setInterval(sample, 200);
child.on('close', (code) => {
  clearInterval(iv);
  const cpu = [...cpuSeen.values()].reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ label, code, wall_s: +((performance.now() - t0) / 1000).toFixed(2), cpu_s: +cpu.toFixed(1), peakRSS_MB: Math.round(peak / 1024) }));
  if (code) console.log(log.slice(-3000));
  else if (process.env.SHOWLOG) console.log(log.slice(-1500));
});
