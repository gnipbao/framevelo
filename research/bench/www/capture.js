// Page-side capture helpers shared by comp.html (DOM via drawElementImage) and canvas.html (pure canvas).
(() => {
  const cap = document.getElementById('cap');
  const isDE = cap && cap.hasAttribute('layoutsubtree');
  const S = Number(new URLSearchParams(location.search).get('scale') || 1);
  if (isDE && S !== 1) { cap.width = 1920 * S; cap.height = 1080 * S; }
  const ctx = isDE ? cap.getContext('2d') : null;
  const root = document.getElementById('root');
  const stats = { paintMs: 0, encodeWaitMs: 0, flushes: 0 };
  function paintAt(t) {
    const a = performance.now();
    if (!isDE) { window.__seek(t); stats.paintMs += performance.now() - a; return Promise.resolve(); }
    return new Promise((res, rej) => {
      cap.onpaint = () => {
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cap.width, cap.height); ctx.drawElementImage(root, 0, 0); stats.paintMs += performance.now() - a; res(); }
        catch (e) { rej(e); }
      };
      window.__seek(t);
      cap.requestPaint();
    });
  }
  window.__captureDataUrl = async (t, png) => { await paintAt(t); return cap.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92); };
  window.__renderWebCodecs = async (FRAMES, FPS, W, H, hevc, o = {}) => {
    let err = null, pending = [], pendingBytes = 0, chain = Promise.resolve();
    const flush = () => {
      if (!pending.length) return chain;
      const blob = new Blob(pending); pending = []; pendingBytes = 0; stats.flushes++;
      chain = chain.then(() => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); }))
        .then((u) => window.__chunk(u.slice(u.indexOf(',') + 1), o.seg || 0));
      return chain;
    };
    const enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pending.push(b); pendingBytes += b.length; if (pendingBytes > 2e6) flush(); },
      error: (e) => { err = e; },
    });
    enc.configure({ codec: hevc ? 'hvc1.1.6.L153.B0' : 'avc1.640033', width: W, height: H, bitrate: o.bitrate || 16e6, framerate: FPS, ...(o.bitrateMode ? { bitrateMode: o.bitrateMode } : {}),
      hardwareAcceleration: 'prefer-hardware', latencyMode: o.latency || 'quality', avc: { format: 'annexb' }, hevc: { format: 'annexb' } });
    for (let i = 0; i < FRAMES; i++) {
      if (err) throw err;
      const fi = i + (o.start || 0);
      if (!o.encodeOnly || i === 0) await paintAt(fi / FPS);
      const vf = new VideoFrame(cap, { timestamp: Math.round(fi * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % 60 === 0 }); vf.close();
      const a = performance.now();
      while (enc.encodeQueueSize > (o.q || 4)) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
      stats.encodeWaitMs += performance.now() - a;
    }
    await enc.flush(); await flush(); enc.close();
    if (err) throw err;
    return { paintMs: Math.round(stats.paintMs), encodeWaitMs: Math.round(stats.encodeWaitMs), flushes: stats.flushes };
  };
})();
