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

## Results

Apple M3 Pro (11 cores, 18 GB), macOS 27, chrome-headless-shell 154, FFmpeg 7.0.2, HyperFrames 0.8.186. Wall time, CPU time and peak memory cover the whole process tree, sampled every 200 ms; quality is per-frame PSNR against the reference render.

**GSAP composition, 10 s** ([research/bench/hfproj](research/bench/hfproj))

| Renderer | Wall | CPU | Peak memory | PSNR vs official |
|---|---:|---:|---:|---:|
| `hyperframes render`, 1080p | 17.4 s | 64.2 s | 2385 MB | |
| `hyperframes render --gpu`, 1080p | 15.4 s | 30.6 s | 2035 MB | |
| **FrameVelo, 1080p** | **7.8 s** | **7.8 s** | **797 MB** | 45.6 dB |
| `hyperframes render`, 4K | 34.7 s | 210.5 s | 3360 MB | |
| `hyperframes render --gpu`, 4K | 32.8 s | 91.2 s | 2489 MB | |
| **FrameVelo, 4K** | **9.3 s** | **11.5 s** | **903 MB** | 48.7 dB |

FrameVelo's files are larger (15.5 MB against 14.3 MB at 1080p, 56 MB against 37 MB at 4K): the hardware encoder needs more bits than x264 for the same quality.

**HyperFrames regression fixtures**: the 24 projects from the official `packages/producer/tests` render, 23 of them at 40 dB or more against `hyperframes render` (a page-side shader transition fixture averages 37.5 dB). In total, wall time drops from 366 s to 219 s (1.7× faster), CPU from 589 s to 265 s (2.2× less) and mean peak memory from 1858 MB to 926 MB (50% less). Motion graphics gain the most, 2.5–6×. Video-heavy fixtures gain less because their frames come from the official extraction and injector; `pip-video-late-host` is 5% slower.

<details>
<summary>Per fixture</summary>

| Fixture | Frames | PSNR avg / min | Wall HF → FV | CPU HF → FV | Peak memory HF → FV |
|---|---:|---:|---:|---:|---:|
| nested-subcomp-depth-3 | 60 | 49.7 / 49.3 dB | 13.0 → 3.3 s | 6.3 → 1.9 s | 1306 → 688 MB |
| css-spinner-render-compat | 150 | 55.7 / 54.9 dB | 11.1 → 2.1 s | 11.0 → 2.2 s | 1810 → 686 MB |
| raf-ball-render-compat | 150 | 62 / 60 dB | 7.3 → 1.9 s | 10.5 → 2.3 s | 1635 → 677 MB |
| gsap-letters-render-compat | 120 | 66.2 / 57.6 dB | 11.2 → 2.5 s | 13.0 → 2.0 s | 2335 → 704 MB |
| many-cuts | 168 | 60.4 / 51.4 dB | 16.9 → 8.6 s | 18.1 → 6.3 s | 2240 → 805 MB |
| speed-ramp | 120 | 47.6 / 45.8 dB | 8.1 → 4.5 s | 7.3 → 4.8 s | 1737 → 677 MB |
| animejs-adapter | 180 | 49.7 / 39.5 dB | 9.4 → 3.2 s | 12.4 → 2.1 s | 1900 → 711 MB |
| html-dir-rtl | 60 | 48.5 / 46.4 dB | 6.3 → 2.0 s | 2.7 → 1.5 s | 731 → 667 MB |
| transparency-regression | 30 | 55.1 / 54.9 dB | 5.8 → 0.9 s | 1.8 → 1.3 s | 675 → 609 MB |
| style-1-prod | 510 | 50.7 / 48.1 dB | 28.9 → 22.3 s | 57.5 → 43.2 s | 2577 → 1931 MB |
| style-5-prod | 572 | 50.8 / 46.9 dB | 33.9 → 19.1 s | 72.0 → 18.3 s | 2646 → 1628 MB |
| sub-composition-video | 390 | 49.3 / 48.4 dB | 29.6 → 21.3 s | 75.4 → 19.9 s | 2692 → 1564 MB |
| typegpu-adapter | 180 | 52.9 / 51.1 dB | 9.3 → 5.5 s | 17.7 → 2.8 s | 2259 → 731 MB |
| webgl-video-texture-render-compat | 60 | 45.8 / 42.3 dB | 50.9 → 48.4 s | 7.0 → 4.2 s | 1203 → 672 MB |
| iframe-render-compat | 150 | 61.4 / 56.1 dB | 6.1 → 1.7 s | 11.7 → 1.6 s | 1903 → 617 MB |
| pip-video-late-host | 180 | 51.7 / 47.7 dB | 15.0 → 15.8 s | 27.7 → 5.9 s | 1943 → 1160 MB |
| variables-prod | 90 | 62.2 / 53.1 dB | 8.3 → 2.7 s | 7.3 → 2.0 s | 1553 → 724 MB |
| hf2550-video-subcomposition-ghost | 1516 | 50.3 / 46 dB | 37.2 → 26.3 s | 145.7 → 118.1 s | 2885 → 2176 MB |
| nested-sequential-video-local-start | 60 | 100 / 100 dB | 6.4 → 2.7 s | 3.2 → 4.2 s | 714 → 632 MB |
| timed-descendant-visibility | 270 | 53.6 / 41.7 dB | 7.7 → 1.7 s | 5.9 → 1.8 s | 1652 → 647 MB |
| vignelli-stacking | 308 | 52.3 / 48.5 dB | 17.1 → 12.6 s | 41.7 → 9.7 s | 2383 → 1268 MB |
| page-side-shader-compositor-render-compat | 60 | 37.5 / 27.2 dB | 8.4 → 4.0 s | 5.2 → 4.1 s | 1184 → 792 MB |
| gsap-call-render-seek | 180 | 53.1 / 49.3 dB | 7.7 → 3.0 s | 14.3 → 2.2 s | 2237 → 717 MB |
| sub-comp-t0 | 180 | 58.4 / 47.6 dB | 10.9 → 2.7 s | 13.5 → 2.2 s | 2398 → 735 MB |

</details>

**code-video** (build-a-world, 20–30 s, 3 sub-frames): the skill's `render.mjs` takes 46.8 s, 115 s CPU and 3157 MB; FrameVelo 48.3 s, 12.3 s CPU and 1006 MB (41.5 dB). This three.js scene keeps the GPU busy on its own, so FrameVelo saves CPU and memory rather than time.

Reproduce with `node scripts/parity.ts <projects>` and `research/bench/measure.mjs`.

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

## Use with AI agents

FrameVelo has an MCP server, `framevelo mcp`, with three tools: `render`, `doctor` and `install_browser`. It also ships a [skill](plugin/skills/framevelo/SKILL.md) that teaches an agent the workflow: preview a slice, render, check the result, and fix each kind of failure.

**Claude Code**: the plugin installs both.

```
/plugin marketplace add gnipbao/framevelo
/plugin install framevelo@framevelo
```

The plugin uses an installed `framevelo` when there is one. Otherwise, on its first start, it installs FrameVelo and the HyperFrames packages into `~/.cache/framevelo` (about a minute), and later starts take a fraction of a second. If Claude Code stops waiting during that first install, the install keeps going; reconnect with `/mcp` once it has finished.

**Other MCP clients** (Codex, Cursor, Claude Desktop, ...): install once, then register `framevelo mcp`.

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8.186 @hyperframes/engine@0.8.186
```

```json
{ "mcpServers": { "framevelo": { "command": "framevelo", "args": ["mcp"] } } }
```

For Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.framevelo]
command = "framevelo"
args = ["mcp"]
```

To run it without installing, use `"command": "npx"` with `"args": ["-y", "-p", "github:gnipbao/framevelo", "-p", "@hyperframes/producer@0.8.186", "-p", "@hyperframes/engine@0.8.186", "framevelo", "mcp"]` and the environment `PUPPETEER_SKIP_DOWNLOAD=true`. The first start takes about half a minute, which can exceed a client's startup timeout.

`render` takes the CLI options as JSON (`input`, `output`, `frames`, `start`, `quality`, `scale`, `codec`, ...). It returns `output`, `frames`, `fps`, `width`, `height`, `bytes`, `audio`, `wallMs`, `stages`, `warnings` and the last log lines. While it renders, it sends progress notifications and can be cancelled. Failures come back as readable tool errors, and renders run one at a time.

**Shell-only agents**: `framevelo render <input> -o out.mp4 --json -q` prints the result as JSON on stdout. On failure it prints `{"error": "..."}` and exits with 1.

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
framevelo mcp
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

`onProgress(done, total)` reports frames, and an `AbortSignal` passed as `signal` stops a render without leaving a file.

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
