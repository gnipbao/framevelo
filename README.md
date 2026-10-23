# FrameVelo

**Code the motion. Speed the render.**

A rendering accelerator for code-driven videos.

为代码生成的视频，加速每一帧。 · [中文说明](README.zh-CN.md)

---

FrameVelo renders videos written as code (HTML/CSS/GSAP compositions such as [HyperFrames](https://github.com/heygen-com/hyperframes), or Canvas 2D / WebGL scenes drawn as a pure function of time) to MP4, with as little time, CPU, and memory as the hardware allows.

Most code-video renderers capture each frame as a screenshot or PNG, ship it to Node as base64, decode it again in FFmpeg, convert RGB to YUV on the CPU, and encode it with x264 in software. FrameVelo keeps the frame on the GPU instead:

```
seek(t) ─► drawElementImage (DOM) / canvas ─► VideoFrame ─► WebCodecs VideoEncoder (hardware)
        ─► compressed H.264/HEVC chunks ─► stream-copy mux (no decode, no re-encode)
```

## Why: measured on an M3 Pro

The same GSAP composition (80 shadowed cards, gradients, text; 10 s, 300 frames), compared with the official `hyperframes render` 0.8.186 CLI:

| Scene | Pipeline | Wall time | CPU time | Peak memory |
|---|---|---:|---:|---:|
| 1080p30 | HyperFrames default (4 workers, screenshot + x264) | 20.3 s | 62.1 s | 2649 MB |
| 1080p30 | HyperFrames `--gpu` | 15.7 s | 29.1 s | 2232 MB |
| 1080p30 | **FrameVelo** | **7.5 s** | **13.7 s** | **1468 MB** |
| 4K30 | HyperFrames default | 47.5 s | 234 s | 3296 MB |
| 4K30 | HyperFrames `--gpu` | 37.3 s | 96.5 s | 2500 MB |
| 4K30 | **FrameVelo** | **9.7 s** | **18.3 s** | **1650 MB** |

FrameVelo rows were measured with the research prototype on an otherwise idle machine; the CLI matched or beat the prototype in back-to-back runs.

A pure Canvas 2D scene renders at 170 fps instead of 17 fps with a PNG + x264 pipeline. Quality at 1080p matches the official `--gpu` output (PSNR 42.9 dB vs 42.5 dB); the drawElement capture matches native Chrome screenshots at 57.8 dB PSNR / 0.998 SSIM.

Full method, data, and risks: [docs/research-render-acceleration.md](docs/research-render-acceleration.md) (Chinese). Reproducible benchmarks: [research/bench](research/bench).

## Requirements

- macOS on Apple silicon (other platforms are untested)
- Node.js 22.18 or later
- Google Chrome 151 or later for DOM capture (HTML-in-Canvas `drawElementImage`); any recent Chrome for canvas pages
- FFmpeg and FFprobe on `PATH`

## Install

FrameVelo is not on npm yet. Install it from GitHub:

```bash
npm install -g github:gnipbao/framevelo
```

Then check the machine:

```bash
framevelo doctor
```

`doctor` reports the Chrome it found, whether `drawElementImage` is available, which WebCodecs encoders run in hardware, and the FFmpeg/AAC setup.

## Quick start

```bash
framevelo render examples/dom-cards -o dom-cards.mp4
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --scale 2 --codec hevc
```

```bash
framevelo render my-film/ -o my-film.mp4 --audio score.wav --subframes 3
```

The input is an `.html` file or a directory with `index.html`. FrameVelo serves it on `127.0.0.1`, opens it in headless Chrome, and steps through time frame by frame.

## Make a page seekable

Each frame must be a pure function of time. FrameVelo looks for a time driver in this order:

1. `window.__framevelo = { seek(t), duration, fps }`. `seek` may return a promise. `duration` and `fps` are optional.
2. `window.__seek(t)`, with an optional `window.__duration`.
3. A paused GSAP timeline on `window.__timelines.main` (or the first key), the HyperFrames convention. The composition root's `data-duration`, `data-width`, `data-height`, and `data-fps` are read when present.

```html
<canvas id="scene" width="1920" height="1080"></canvas>
<script>
  const g = document.getElementById("scene").getContext("2d");
  function draw(t) {
    g.fillStyle = "#05060a";
    g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = "#6cf";
    g.fillRect(200 + 300 * t, 500, 120, 120);
  }
  window.__framevelo = { duration: 4, seek: draw };
</script>
```

Pages animated by `requestAnimationFrame`, CSS transitions, or wall-clock time cannot be seeked and are not supported.

### What gets captured

- **Canvas mode**: the `<canvas>` itself is the frame. Chosen automatically when the captured element is a canvas.
- **DOM mode**: the captured element (the HyperFrames root, `#root`, or `--selector`) is moved into a `<canvas layoutsubtree>` and drawn with `drawElementImage`. The canvas backing store is sized to the output, so `--scale 2` re-rasterizes a 1080p layout at 4K instead of upscaling it.

## CLI

```
framevelo render <input> [options]
```

| Option | Default | Meaning |
|---|---|---|
| `-o, --output <file>` | `<input name>.mp4` | Output MP4 |
| `--fps <n>` | page `fps` / `data-fps`, else 30 | Frame rate; integers and NTSC rates (29.97, 59.94) |
| `--duration <s>` | page duration | Seconds to render |
| `--frames <n>` | | Exact frame count (overrides `--duration`) |
| `--start <s>` | 0 | First frame time; the audio track is offset to match |
| `--width`, `--height <px>` | captured size × scale | Output size |
| `--scale <n>` | 1 | Resolution multiplier |
| `--viewport <WxH>` | `data-width`/`data-height`, viewport meta, or 1920x1080 | CSS viewport |
| `--mode <m>` | `auto` | `auto`, `canvas`, or `dom` |
| `--selector <css>` | | Element or canvas to capture |
| `--codec <c>` | `h264` | `h264` or `hevc` |
| `--bitrate <b>` | 0.2 bits/pixel/frame (H.264), 0.13 (HEVC) | Target bitrate, e.g. `12M` |
| `--audio <file>` | | Audio track, encoded to AAC (AudioToolbox when available) |
| `--subframes <n>` | 1 | Sub-frames averaged per frame for motion blur |
| `--shutter <f>` | 0.5 | Fraction of the frame interval the sub-frames span |
| `--background <css>` | page background | Color behind transparent DOM content |
| `--chrome <path>` | `FRAMEVELO_CHROME`, installed Chrome, Puppeteer cache | Chrome binary |
| `--json` | | Print the result as JSON |
| `-q, --quiet` | | No progress output |

Every render is written to a temporary file, checked with FFprobe (exact video packet count, size, audio present), then renamed into place. A failed render leaves no partial file. Output is tagged BT.709 SDR.

## API

```js
import { render } from "framevelo";

const result = await render({
  input: "examples/dom-cards",
  output: "dom-cards.mp4",
  scale: 2,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
console.log(result.wallMs, result.page.encodeWaitMs);
```

## Limitations

- HyperFrames support covers standalone compositions with one paused GSAP timeline. Clip visibility windows (`data-start`/`data-duration` on clips), sub-compositions, `<video>`/`<audio>` elements, and the official font mapping are handled by the HyperFrames runtime and are not yet reproduced; see the roadmap.
- `drawElementImage` is an Origin Trial API (through Chrome 160) that changed shape in Chrome 155. WebGL/WebGPU canvases inside a DOM capture freeze on their first frame. There is no automatic screenshot fallback yet.
- The single hardware video encoder is shared with other apps. Screen recorders and video calls running at the same time slow encoding down.
- Hardware encoders need about 1.2× the bitrate of x264 CRF 18 for the same quality.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 | CLI: seekable HTML pages and pure-canvas scenes → MP4 via WebCodecs, stream-copy mux, audio track, motion blur | Done |
| M1 | HyperFrames adapter: compiled compositions, sub-compositions, fonts, audio mix; parity tests against the official renderer | Next |
| M2 | Per-interval planner, sampled self-verification against screenshots, screenshot + VideoToolbox fallback, 60 fps / 4K / HEVC presets | |
| M3 | Video sources via hardware `VideoDecoder`, static-frame dedup, layer raster cache, GPU motion blur | |

## Development

```bash
npm install
npm test
npm run test:integration
npm run framevelo -- render examples/dom-cards -o out/dom.mp4
```

`npm test` runs the unit tests. `npm run test:integration` also renders the examples through Chrome and FFmpeg. The sources run directly on Node's TypeScript type stripping; `npm run build` emits `dist/`.

## License

[Apache-2.0](LICENSE)
