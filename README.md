<p align="center">
  <img src="docs/assets/cover.png" alt="FrameVelo: Code the motion. Speed the render." width="100%">
</p>

<p align="center">
  <a href="https://github.com/gnipbao/framevelo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/gnipbao/framevelo/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <img alt="macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-555">
  <a href="#use-with-ai-agents"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-7c5cff"></a>
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a></p>

**FrameVelo** is a rendering accelerator for code-driven videos. It renders [HyperFrames](https://github.com/heygen-com/hyperframes) projects, [Remotion](https://www.remotion.dev) projects and any HTML/CSS/GSAP or Canvas/WebGL page that is a pure function of time to MP4, using as little time, CPU and memory as the hardware allows.

Most code-video renderers take a screenshot of every frame, ship it to Node as base64, decode it again in FFmpeg, convert it to YUV on the CPU and encode it with x264. FrameVelo keeps the frame on the GPU:

```
seek(t) ─► drawElementImage (DOM) / canvas ─► VideoFrame ─► WebCodecs VideoEncoder (hardware)
        ─► H.264 / HEVC ─► stream-copy mux + audio ─► verified MP4
```

## Highlights

- **3.8× faster at 4K, 2.0× at 1080p** than `hyperframes render` on a 10-second GSAP composition, with 19× less CPU time and 76% less peak memory at 4K.
- **The same frames.** On the 24 official HyperFrames regression fixtures, 23 match the official render at 40 dB PSNR or more. In total they render 1.6× faster with 2.1× less CPU and 49% less peak memory.
- **HyperFrames through the official pipeline.** Fonts, sub-compositions, clip windows, `<video>` frames, shader transitions and the audio mix come from `@hyperframes/producer`; FrameVelo replaces only capture and encoding.
- **Remotion projects too.** On the same projects FrameVelo uses 2.6–7× less CPU and 69–84% less peak memory than `remotion render`, in about the same time (0.9–1.3×): Remotion spreads JPEG screenshots over many tabs and keeps the cores busy, FrameVelo leaves them free. Bundling, `<OffthreadVideo>` frames and the audio mix stay Remotion's own; the audio is sample-identical.
- **Verified output.** Each interval is checked against a native screenshot before encoding and falls back to screenshots when it differs; output is verified with ffprobe and written atomically.
- **Ready for agents.** An MCP server (`framevelo mcp`), a Claude Code plugin and a skill, and `--json` output for shell-only agents.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bench-gsap-dark.svg">
  <img alt="Wall time, CPU time and peak memory of a 10-second GSAP composition at 1080p and 4K: hyperframes render, hyperframes render --gpu and FrameVelo" src="docs/assets/bench-gsap-light.svg" width="100%">
</picture>

Measured on an Apple M3 Pro (11 cores, 18 GB), macOS 27.0.1, chrome-headless-shell 154, HyperFrames 0.8.186; median of 3 runs. Full tables, the per-fixture chart and the method: [docs/benchmarks.md](docs/benchmarks.md).

## Quick start

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8 @hyperframes/engine@0.8
```

```bash
framevelo browser install
```

```bash
framevelo render my-hyperframes-project/ -o film.mp4
```

FrameVelo is not on npm yet, so it installs from GitHub; the HyperFrames packages are only needed for HyperFrames projects. `framevelo browser install` downloads `chrome-headless-shell`, which uses about half the CPU and memory of full Chrome. `framevelo doctor` checks the machine: browser, `drawElementImage`, hardware encoders, FFmpeg and HyperFrames.

More examples (the input is an `.html` file or a directory with `index.html`):

```bash
framevelo render examples/dom-cards -o dom-cards.mp4 --scale 2
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --codec hevc --subframes 3
```

**Requirements:** macOS or Windows, Node.js 22.18+, FFmpeg and FFprobe on `PATH`, Chrome 151+ (`chrome-headless-shell` preferred). The numbers above are measured on macOS on Apple silicon. Windows runs the same integration tests in CI: H.264 is encoded on the GPU where it has an encoder and by Chrome's software encoder otherwise, and HEVC needs a hardware encoder. Linux runs the unit tests only. Remotion projects need their own dependencies installed (`npm install`).

## What it renders

### HyperFrames projects

A page with a `data-composition-id` root is compiled and served by the official HyperFrames pipeline, so it renders as `hyperframes render` would. Pass `--no-hyperframes` to render it as a plain page instead.

### Remotion projects

Point FrameVelo at a Remotion project, its directory or its entry file, and name the composition:

```bash
framevelo render my-remotion-project/ --composition MyComp -o out.mp4 --props '{"title":"Hello"}'
```

The project's own Remotion does the Remotion parts. Its CLI bundles the project, so `remotion.config.ts` applies; its renderer serves the bundle and the `<OffthreadVideo>` frames; its mixer makes the audio from what each frame plays. FrameVelo mounts the composition (with `calculateMetadata()` and the resolved props), drives it frame by frame, and replaces capture and encoding. The project's dependencies must be installed; Remotion 4 is supported (tested with 4.0.539). Remotion renders whole frames, so `--subframes` has no effect: blur inside the composition with `<CameraMotionBlur>`. Remotion's own license applies to the project as usual.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bench-remotion-dark.svg">
  <img alt="Wall time, CPU time and peak memory of remotion render and FrameVelo on Remotion projects" src="docs/assets/bench-remotion-light.svg" width="100%">
</picture>

### Any seekable page

Every frame must be a pure function of time. FrameVelo looks for, in order:

1. `window.__framevelo = { seek(t), duration, fps, audio }` (`seek` may return a promise; `audio` is a soundtrack URL to mux)
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

Footage stays on the composition clock with `<video data-start="0.5">` (optional `data-media-start`, `data-duration`, `data-playback-rate`): FrameVelo seeks it frame-exactly, and sources with distant keyframes get a cached all-intra proxy so that each seek decodes one frame. `Math.random` is seeded, so renders repeat. Pages animated by `requestAnimationFrame` loops, CSS transitions or wall-clock time cannot be seeked. The [cover above](docs/assets/cover.html) is such a page: `framevelo render docs/assets/cover.html` renders it as a 4-second clip.

## Use with AI agents

`framevelo mcp` is an MCP server with three tools: `render`, `doctor` and `install_browser`. A [skill](plugin/skills/framevelo/SKILL.md) teaches agents the workflow: preview a slice, render, check the result, fix each kind of failure.

**Claude Code** — the plugin bundles the server and the skill:

```
/plugin marketplace add gnipbao/framevelo
/plugin install framevelo@framevelo
```

It uses an installed `framevelo`, or installs FrameVelo into `~/.cache/framevelo` on its first start (about a minute; later starts take a fraction of a second). If Claude Code stops waiting during that install, reconnect with `/mcp` once it finishes.

**Codex, Cursor, Claude Desktop and other MCP clients** — install once (Quick start), then register the server:

```json
{ "mcpServers": { "framevelo": { "command": "framevelo", "args": ["mcp"] } } }
```

```toml
# ~/.codex/config.toml
[mcp_servers.framevelo]
command = "framevelo"
args = ["mcp"]
```

`render` takes the CLI options as JSON (`input`, `output`, `frames`, `start`, `quality`, `scale`, `composition` and `props` for Remotion, ...), sends progress notifications, can be cancelled, runs renders one at a time and returns the output path, frame count, size, timings and warnings. **Shell-only agents:** `framevelo render <input> -o out.mp4 --json -q` prints the result as JSON, or `{"error": "..."}` with exit code 1.

## How it works

- **Canvas pages**: the `<canvas>` is the frame.
- **DOM pages**: the captured element moves into a `<canvas layoutsubtree>` and is drawn with `drawElementImage`. The canvas backing store is the output size, so `--scale 2` re-rasterizes a 1080p layout at 4K.
- **Verification**: before encoding, sampled frames of every interval (split at clip boundaries) are painted both ways and compared with a native screenshot; an interval below `--verify-threshold` (30 dB) is captured with screenshots through the same encoder.
- **Paint reuse**: a frame in which nothing visible changed reuses the previous paint; output is byte-identical with and without it.
- **Parallel pages**: frames that Node drives one by one (HyperFrames video frames, screenshot intervals) are latency-bound, so long runs of them are split across pages, each with its own encoder, and concatenated before muxing.
- **Output**: WebCodecs encodes on the hardware encoder; FFmpeg only copies the stream into MP4 with BT.709 tags and the audio. The file is written under a temporary name, checked with ffprobe and renamed; a failed render leaves nothing.

Design notes and the ideas that were measured and dropped: [docs/architecture.md](docs/architecture.md).

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
| `--capture <c>` | `auto` | DOM pages: `auto` (verify, fall back per interval), `dom`, `screenshot` |
| `--verify-threshold <dB>` | 30 | Verification PSNR below which an interval uses screenshots |
| `--codec <c>` | `h264` | `h264` or `hevc` |
| `--quality <q>` | `standard` | `draft`, `standard` (about x264 CRF 18), `high` |
| `--bitrate <b>` | from size, fps and quality | Target bitrate, e.g. `12M` |
| `--audio <file>` | composition audio | Audio track |
| `--subframes <n>`, `--shutter <f>` | 1, 0.5 | Motion blur by averaging sub-frames on the GPU |
| `--background <css>` | page background | Color behind transparent DOM content |
| `--mount <prefix>=<dir>` | | Serve another directory, e.g. `/vendor/=./vendor` |
| `--workers <n>` | from the CPU count | Most pages for Node-driven frames; `1` turns parallel pages off |
| `--no-hyperframes` | | Render a HyperFrames project as a plain page |
| `--composition <id>` | the only one | Remotion projects: the composition to render |
| `--props <json\|file>` | default props | Remotion projects: input props, inline JSON or a `.json` file |
| `--no-paint-reuse` | | Repaint every frame |
| `--no-video-proxy` | | Seek video sources as they are |
| `--chrome <path>` | headless shell, then Chrome | Browser binary |
| `--json`, `-q, --quiet` | | Result as JSON; no progress |

## API

```js
import { render } from "framevelo";

const result = await render({ input: "examples/dom-cards", output: "dom-cards.mp4", scale: 2 });
console.log(result.wallMs, result.stages, result.warnings);
```

`onProgress(done, total)` reports frames; an `AbortSignal` passed as `signal` stops a render without leaving a file.

## Limitations

- `drawElementImage` is an Origin Trial API (through Chrome 160) that changed shape in Chrome 155. Verification guards against regressions; check a new Chrome with `node bench/parity.ts`.
- Video-heavy HyperFrames projects gain less than motion graphics: every new video frame costs about one rendering update, which parallel pages overlap at the cost of more memory.
- Remotion support follows Remotion 4's render-page protocol, which is internal to Remotion: a bundle that speaks another version is refused with a clear error rather than rendered wrong. Each `<OffthreadVideo>` frame still costs a fetch from Remotion's frame server.
- The hardware encoder is shared with other apps; screen recorders and video calls slow encoding down. It also needs more bits than x264 for the same quality, so files are larger.

## Development

```bash
npm install
npm test
npm run test:integration
```

`npm test` runs the unit and MCP protocol tests; `npm run test:integration` renders the examples through Chrome and FFmpeg. `node bench/run.ts` and `node bench/report.ts` reproduce the benchmarks ([bench/README.md](bench/README.md)). Sources run on Node's TypeScript type stripping; `npm run build` emits `dist/`. Coding agents: see [AGENTS.md](AGENTS.md). The original feasibility study (Chinese) is in [docs/research-render-acceleration.md](docs/research-render-acceleration.md).

## License

[Apache-2.0](LICENSE). Portions derived from HyperFrames; see [NOTICE](NOTICE).
