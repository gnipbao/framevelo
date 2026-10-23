# FrameVelo

**Code the motion. Speed the render.**

A rendering accelerator for code-driven videos.

为代码生成的视频，加速每一帧。 · [中文说明](README.zh-CN.md)

---

FrameVelo renders videos written as code to MP4: [HyperFrames](https://github.com/heygen-com/hyperframes) projects, [code-video](#code-video-compositions) compositions, and any HTML/CSS/GSAP or Canvas/WebGL page that is a pure function of time. It aims for as little time, CPU, and memory as the hardware allows.

Most code-video renderers capture each frame as a screenshot or PNG, ship it to Node as base64, decode it again in FFmpeg, convert RGB to YUV on the CPU, and encode it with x264. FrameVelo keeps the frame on the GPU:

```
seek(t) ─► drawElementImage (DOM) / canvas ─► VideoFrame ─► WebCodecs VideoEncoder (hardware)
        ─► compressed H.264/HEVC ─► stream-copy mux + audio ─► verified MP4
```

<!-- results -->

## Requirements

- macOS on Apple silicon (other platforms are untested)
- Node.js 22.18 or later
- FFmpeg and FFprobe on `PATH`
- Chrome 151 or later for DOM capture: `chrome-headless-shell` is preferred (`framevelo browser install`), an installed Google Chrome works
- For HyperFrames projects: `@hyperframes/producer` and `@hyperframes/engine` 0.8.x (optional peer dependencies)

## Install

FrameVelo is not on npm yet. Install it from GitHub, with the HyperFrames packages if you render HyperFrames projects:

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8 @hyperframes/engine@0.8
```

Install the lean browser and check the machine:

```bash
framevelo browser install
```

```bash
framevelo doctor
```

`doctor` reports the browser it will use, `drawElementImage` support, which WebCodecs encoders run in hardware, FFmpeg and AAC, and HyperFrames support.

## Quick start

```bash
framevelo render my-hyperframes-project/ -o film.mp4
```

```bash
framevelo render examples/dom-cards -o dom-cards.mp4 --scale 2
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --codec hevc --subframes 3
```

The input is an `.html` file or a directory with `index.html`.

## What it renders

### HyperFrames projects

A page with a `data-composition-id` root is compiled and served by the official HyperFrames pipeline: fonts, sub-compositions, clip windows, `<video>` frames, shader transitions and the audio mix behave as with `hyperframes render`. FrameVelo replaces only capture and encoding. Pass `--no-hyperframes` to render the page as a plain page instead.

### code-video compositions

Pages built with `defineComposition()` from the code-video skill render as they are: FrameVelo serves the skill at `/@skill/` (from `CODE_VIDEO_SKILL_DIR` or `~/.claude/skills/code-video`), seeks `window.seek(t)`, reads duration and fps from `window.__comp`, and muxes the declared soundtrack.

### Any seekable page

Each frame must be a pure function of time. FrameVelo looks for, in order:

1. `window.__framevelo = { seek(t), duration, fps }` (`seek` may return a promise)
2. `window.__seek(t)` with an optional `window.__duration`
3. A paused GSAP timeline on `window.__timelines.main` (or the first key)

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

Footage stays on the composition clock with `<video data-start="0.5">` (optional `data-media-start`, `data-duration`, `data-playback-rate`): FrameVelo seeks it frame-exactly on every frame. Sources whose keyframes are far apart get a cached all-intra proxy, encoded once on the hardware encoder, so each seek decodes one frame. `Math.random` is seeded so renders repeat.

Pages animated by `requestAnimationFrame` loops, CSS transitions or wall-clock time cannot be seeked.

## How capture works

- **Canvas pages**: the `<canvas>` is the frame.
- **DOM pages**: the captured element moves into a `<canvas layoutsubtree>` and is drawn with `drawElementImage`. The canvas backing store is the output size, so `--scale 2` re-rasterizes a 1080p layout at 4K.
- **Verification**: before encoding, the first and middle frame of every interval (split at clip boundaries, at most 2 s) are painted both ways and compared with a native screenshot. An interval below `--verify-threshold` (30 dB) is captured with screenshots, through the same encoder.
- **Paint reuse**: a frame in which nothing visible changed reuses the previous paint. Output is byte-identical with and without it.
- **Parallel pages**: frames that Node has to drive one by one (HyperFrames video frames, screenshot intervals) are bound by round-trip latency, not by the GPU. Long runs of them are split into contiguous ranges, each rendered by its own page and encoder; every range starts on a keyframe after a discarded warm-up frame, and the parts are concatenated before muxing. Verification samples are shared between the pages too.
- **Output**: frames are encoded by WebCodecs on the hardware encoder and stream-copied into the MP4 with BT.709 tags. The file is written under a temporary name, checked with ffprobe (frame count, size, audio) and renamed; a failed render leaves nothing.

Details and the ideas that were measured and dropped: [docs/architecture.md](docs/architecture.md).

## CLI

```
framevelo render <input> [options]
framevelo doctor
framevelo browser install [version] | framevelo browser path
```

| Option | Default | Meaning |
|---|---|---|
| `-o, --output <file>` | `<input name>.mp4` | Output MP4 |
| `--fps <n>` | page fps, else 30 | Frame rate; integers and NTSC rates (29.97, 59.94) |
| `--duration <s>`, `--frames <n>` | page duration | Length to render |
| `--start <s>` | 0 | First frame time; audio is offset to match |
| `--width`, `--height <px>`, `--scale <n>` | captured size | Output size |
| `--viewport <WxH>` | from the page, else 1920x1080 | CSS viewport |
| `--mode <m>` | `auto` | `auto`, `canvas` or `dom` |
| `--selector <css>` | | Element or canvas to capture |
| `--capture <c>` | `auto` | DOM pages: `auto` (verify and fall back per interval), `dom`, `screenshot` |
| `--verify-threshold <dB>` | 30 | Verification PSNR below which an interval uses screenshots |
| `--codec <c>` | `h264` | `h264` or `hevc` |
| `--quality <q>` | `standard` | `draft`, `standard` (about x264 CRF 18), `high` |
| `--bitrate <b>` | from size, fps and quality | Target bitrate, e.g. `12M` |
| `--audio <file>` | composition audio | Audio track (AAC) |
| `--subframes <n>`, `--shutter <f>` | 1, 0.5 | Motion blur by averaging sub-frames on the GPU |
| `--background <css>` | page background | Color behind transparent DOM content |
| `--mount <prefix>=<dir>` | | Serve another directory, e.g. `/@skill/=./skill` |
| `--no-hyperframes` | | Render a HyperFrames project as a plain page |
| `--no-paint-reuse` | | Repaint every frame |
| `--no-video-proxy` | | Seek video sources as they are |
| `--workers <n>` | from the CPU count (3 on an 11-core M3 Pro) | Most pages for Node-driven frames; one per 200 such frames; `1` turns it off |
| `--chrome <path>` | headless shell, then Chrome | Browser binary |
| `--json`, `-q, --quiet` | | Result as JSON (stage times, route plan, page stats); no progress |

## API

```js
import { render } from "framevelo";

const result = await render({ input: "examples/dom-cards", output: "dom-cards.mp4", scale: 2 });
console.log(result.wallMs, result.stages, result.plan);
```

## Limitations

- `drawElementImage` is an Origin Trial API (through Chrome 160) that changed shape in Chrome 155; verification guards against regressions, but a new Chrome should be checked with `scripts/parity.ts`.
- HyperFrames video frames go through the official extraction and injector, so video-heavy projects gain less than motion graphics: each frame with a new video frame costs about one rendering update, which parallel pages overlap at the cost of more memory.
- Layer raster caching is not implemented: `drawElementImage` cannot interleave cached layers with the rest of the composition.
- The single hardware video encoder is shared with other apps; screen recorders and video calls slow encoding down.
- Hardware encoders need about 1.2× the bitrate of x264 CRF 18 for the same quality.

## Development

```bash
npm install
npm test
npm run test:integration
node scripts/parity.ts path/to/hyperframes-project
```

`npm test` runs unit tests; `npm run test:integration` renders the examples through Chrome and FFmpeg; `scripts/parity.ts` compares FrameVelo with `hyperframes render` on the same machine. Sources run on Node's TypeScript type stripping; `npm run build` emits `dist/`. Research and benchmarks: [docs/research-render-acceleration.md](docs/research-render-acceleration.md) (Chinese), [research/bench](research/bench).

## License

[Apache-2.0](LICENSE). Portions derived from HyperFrames; see [NOTICE](NOTICE).
