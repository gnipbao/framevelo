import puppeteer from 'puppeteer-core';
const exe = process.argv[2];
const browser = await puppeteer.launch({ executablePath: exe, headless: true,
  args: ['--enable-features=CanvasDrawElement', '--enable-blink-features=CanvasDrawElement', '--use-angle=metal',
         '--disable-gpu-vsync', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage();
const { serve } = await import('./serve.mjs'); const srv = await serve(new URL('./www', import.meta.url).pathname); await page.goto(srv.url + '/probe.html');
const r = await page.evaluate(async () => {
  const out = { ua: navigator.userAgent };
  const c = document.getElementById('c'); const ctx = c.getContext('2d');
  out.drawElementImage = typeof ctx.drawElementImage; out.requestPaint = typeof c.requestPaint;
  out.captureElementImage = typeof c.captureElementImage; out.contentAttrIdl = 'content' in c;
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  out.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a';
  out.enc = {};
  for (const [name, codec] of [['h264', 'avc1.640033'], ['hevc', 'hvc1.1.6.L153.B0'], ['av1', 'av01.0.12M.08'], ['vp9', 'vp09.00.51.08']]) {
    for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
      for (const hw of ['prefer-hardware', 'prefer-software']) {
        try { const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 20e6, framerate: 30, hardwareAcceleration: hw, avc: codec.startsWith('avc') ? { format: 'annexb' } : undefined });
          out.enc[`${name} ${w}x${h} ${hw}`] = s.supported; } catch (e) { out.enc[`${name} ${w}x${h} ${hw}`] = 'ERR ' + e.message; }
      }
    }
  }
  // try a drawElementImage via paint event
  try {
    out.deTry = await new Promise((res) => {
      const t = setTimeout(() => res('no paint event within 2s'), 2000);
      c.addEventListener('paint', () => { try { ctx.drawElementImage(document.getElementById('d'), 0, 0); const p = ctx.getImageData(5,5,1,1).data; clearTimeout(t); res('ok pixel=' + Array.from(p)); } catch (e) { clearTimeout(t); res('throw ' + e.message); } }, { once: true });
      if (c.requestPaint) c.requestPaint();
    });
  } catch (e) { out.deTry = 'ERR ' + e.message; }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close(); srv.close();
