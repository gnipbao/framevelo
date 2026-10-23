# Render pipeline benchmarks

The scripts behind [docs/research-render-acceleration.md](../../docs/research-render-acceleration.md). They compare frame capture and encoding pipelines in headless Chrome on macOS and record wall time, CPU time, and peak memory of the whole process tree.

```bash
npm i && npm run setup
```

| File | Purpose |
|---|---|
| `bench.mjs` | Runs one pipeline: `shot-x264`, `shot-vt`, `de-jpeg-x264`, `de-jpeg-vt`, `de-wc`, `de-wc-hevc`, `de-wc-par`, `canvas-png-x264`, `canvas-wc` |
| `measure.mjs` | Wraps any command and reports wall time, summed CPU, and peak summed RSS of its process tree |
| `enc.sh` | FFmpeg encoder comparison (libx264, VideoToolbox H.264/HEVC/ProRes) at 1080p and 4K |
| `probe.mjs` | Reports `drawElementImage` and WebCodecs encoder support of a Chrome binary |
| `www/comp.html` | DOM composition driven by `window.__seek(t)` |
| `www/hf.html`, `www/hf-dom.html`, `hfproj/` | The same scene driven by a paused GSAP timeline, for FrameVelo and for `hyperframes render` |
| `www/canvas.html` | Canvas 2D scene drawn as a pure function of time |
| `www/capture.js` | Page-side capture helpers (drawElement, WebCodecs encode loop) |

Examples:

```bash
node bench.mjs de-wc 300 hf.html
```

```bash
SCALE=2 WC='{"bitrate":40000000}' node bench.mjs de-wc 300 hf.html
```

```bash
node measure.mjs official -- npx hyperframes@0.8.186 render hfproj -o official.mp4 --quiet
```
