# Changelog

## 0.4.0

### Removed

- The code-video coupling: the `window.__comp` / `window.seek` time driver, serving the code-video
  skill at `/@skill/` (`CODE_VIDEO_SKILL_DIR`) and the `?render=1` query. Such pages can expose
  `window.__framevelo = { seek, duration, fps, audio }`, and `--mount` still serves extra
  directories. A declared soundtrack is now `window.__framevelo.audio`.
- The `research/bench` prototypes of the feasibility study (still in the first commit);
  `scripts/parity.ts` moved to `bench/parity.ts`.

### Benchmarks, docs and CI

- `bench/run.ts` measures FrameVelo against `hyperframes render` (a GSAP composition at 1080p and 4K
  against the official default and `--gpu`, the official regression fixtures fetched at the pinned
  tag, worker scaling, headless shell against Chrome); `bench/report.ts` writes
  [docs/benchmarks.md](docs/benchmarks.md) and light and dark charts.
- READMEs in English, Chinese and Japanese, with a cover that is itself a FrameVelo composition
  (`docs/assets/cover.html`).
- CI: unit tests on Node 22 and 24, smoke tests of the built CLI and MCP server, plugin manifest
  checks, and the integration tests on a macOS runner. Integration tests skip encoders the machine
  lacks.

### Fixes

- A page replaced after verification is now closed: it kept a second copy of the composition for the
  whole render (about 170 MB more peak memory on a 1080p DOM page).

- HyperFrames: the first frames could show the composition as it was at the last verified moment.
  Verification seeks quietly out of order, the HyperFrames runtime still runs callbacks at each
  target, and state written by a GSAP `onUpdate` (a camera driven by several keys on one state
  object) survived the quiet park before the first frame. Pages that verified now hand their range
  to fresh pages (about 0.4 s each). Found on a 161 s film whose frames 1–11 showed the camera of
  14 s; regression test `HyperFrames: verification leaves no callback state behind`.
- HyperFrames: the audio mix is held to −1 dBTP like `hyperframes render`. The plan only applies the
  official true-peak step with `chunksCarryAudio`, which FrameVelo now passes; before, a hot mix came
  out about 4 dB louder than the official render and peaked at +0.9 dBTP.

## 0.3.0

### For coding agents

- `framevelo mcp`: an MCP server on stdio with `render`, `doctor` and `install_browser` tools.
  `render` sends progress notifications, can be cancelled, runs renders one at a time and returns a
  short summary (output, frames, size, timings, warnings, last log lines); failures come back as
  readable tool errors.
- Claude Code plugin (`/plugin marketplace add gnipbao/framevelo`): the MCP server plus a skill with
  the render workflow, the page contract and what to do with each error. The launcher uses an
  installed `framevelo`; otherwise it installs once into `~/.cache/framevelo`, detached so a client
  that times out on the first start does not interrupt it, and later starts take about 0.2 s.
- `--json` failures print `{"error": ...}` on stdout as well as the message on stderr.
- `AGENTS.md` for agents working on the repository.

### API

- `render({ signal })`: aborting closes the browser and leaves no output file.

## 0.2.0

### HyperFrames projects (M1)

- A page with a `data-composition-id` root is compiled and served through the official HyperFrames
  pipeline (`@hyperframes/producer`, an optional peer dependency): fonts, sub-compositions, clip
  windows, the audio mix and `<video>` frames match `hyperframes render`. FrameVelo replaces capture
  and encoding only. `--no-hyperframes` renders the page as a plain page.
- `window.__hf` seek protocol with build-ready and sub-timeline readiness; virtual-time shim (ported
  from HyperFrames); page-side shader transitions; official video frame injector, served same-origin.
- Timeline side effects (GSAP `.call()`) fire once, in frame order: verification, sub-frame and
  repositioning seeks are quiet.
- `scripts/parity.ts` compares FrameVelo against the official CLI on any set of projects.

### Capture planning (M2)

- DOM captures are planned per interval: sampled frames are verified against native screenshots and
  intervals below `--verify-threshold` (30 dB) use screenshot capture, still through the same encoder.
- `--capture auto|dom|screenshot`; Chrome without `drawElementImage` falls back to screenshots.
- `--quality draft|standard|high` bitrate presets.
- Prefer `chrome-headless-shell` 151+: same frames at about half the CPU and memory of full Chrome.
  `framevelo browser install` installs one; `framevelo browser path` shows the choice.

### Performance and media (M3)

- Paint reuse: frames in which nothing visible changed reuse the previous paint (byte-identical).
- `<video data-start>` on plain pages is kept frame-exact on the composition clock; long-GOP sources
  get cached all-intra proxies encoded on VideoToolbox (`--no-video-proxy` to opt out).
- Static server supports HTTP byte ranges and mounts.
- Parallel pages for Node-driven frames (`--workers`): HyperFrames video frames and screenshot
  intervals are split into contiguous ranges rendered by separate pages and encoders, then
  concatenated; each range starts on a keyframe after a discarded warm-up frame. Verification
  samples are shared between the pages. On a 50 s video-heavy fixture the render stage drops from
  38 s to 13–15 s.
- Keyframes follow the video's own GOP grid rather than the count of frames since the encoder started.

### Fixes

- Audio is cut on its input to the video length; `-shortest` and an output `-t` dropped trailing
  video frames.
- Injected video frames settle for one rendering update before painting (no stale frames).
- Iframes reload when moved between capture routes: pages with iframes skip verification.
- Results report stage times, the Node-driven loop split, encoder chunk counts and the route plan.

## 0.1.0

- `framevelo render`: seekable HTML pages and pure canvas scenes to MP4 through `drawElementImage`
  and WebCodecs on the hardware encoder, stream-copy mux, audio track, motion blur, `doctor`.
