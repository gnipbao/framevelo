# Changelog

## Unreleased

### Fixes

- Paint reuse counted frames it did not reuse. Each requested paint left its handler on the capture
  canvas, which went on drawing the composition whenever Chrome painted it, and cleared the flag that
  reuse is decided on: a 1080×1920 Remotion render reported 6398 of its 6399 frames as reused while
  every frame changed. The frames were right, because the handler had drawn them, and that is now the
  design: one handler, set up with the canvas, draws in every paint event, and a frame requests a
  paint only for changes made after the last draw, or when an image was still loading at it. Following
  Chrome's paints took 32.6 s for 900 frames of that project, against 43.5 s requesting every paint.
- The stats say what each frame needed: `reusedPaints` (nothing changed), `followedPaints` (Chrome had
  painted the change), `requestedPaints`, and `paintWaitMs` for the time spent waiting.
- A draw that failed in a paint no frame had requested was lost; the next frame now requests a paint,
  which reports the error. `--no-paint-reuse` requests every paint.

## 0.6.0

### Remotion projects

- `framevelo render <remotion-project> --composition <id> [--props <json|file>]` renders a Remotion
  project (its directory, or its entry file) through the project's own Remotion: its CLI bundles the
  project (`remotion.config.ts` applies), its renderer serves the bundle and the `<OffthreadVideo>`
  frames, and its mixer makes the audio. FrameVelo mounts the composition (`calculateMetadata()`,
  resolved props), drives it with `remotion_setFrame`, and replaces capture and encoding. Remotion 4,
  tested with 4.0.539; the MCP `render` tool takes `composition` and `props`.
- A frame counts as done when the page is ready, its images have loaded and decoded, and that still
  holds when the page is idle: Remotion releases a frame on the next animation frame and expects
  React to be done by then, which without vsync it may not be, and `<OffthreadVideo>` reports ready
  for a moment between fetching a frame and showing it. Both captured empty video boxes before.
- The audio is Remotion's own mix of the media each frame reported, kept in M4A so that the AAC
  priming survives: sample-identical to `remotion render` on the test fixture.
- Against `remotion render` 4.0.539 on an M3 Pro (Remotion's hello-world template at 1080p and 4K, a
  3 s video-and-audio scene, a 20 s 1080p showcase): 2.4–7× less CPU and 65–84% less peak memory at
  1.0–1.3× the speed. Against `remotion render --color-space=bt709`, which converts colours with
  BT.709 as FrameVelo does (Remotion 4 defaults to BT.601): 2.9–12× less CPU at 1.1–1.6× the speed,
  with 45–57 dB average PSNR between the two.
- `bench/run.ts --suite remotion` measures `remotion render`, by default and in BT.709, against FrameVelo; `test/fixtures/remotion`
  is a Remotion project (a scene with `<OffthreadVideo>` and `<Audio>`, a 20 s showcase) with its own
  dependencies, prepared by `node scripts/remotion-fixture.ts` and rendered in CI.

### Fixes

- Windows: files are tagged with the colour range the encoder wrote. Chrome's software H.264 encoder
  there writes full-range BT.709, which FrameVelo tagged limited range since 0.5.0, so players
  stretched it: too much contrast and saturation, crushed shadows and clipped highlights. The muxer
  now tags range, matrix and primaries from the encoder's own report (`decoderConfig.colorSpace`), and
  the colour tests check what a player shows. Found by a new colour-patch test on the Windows runner.
- Parallel pages count only frames injected through the page (HyperFrames video). Chrome serializes
  screenshot work, so a second page gained about 6% on screenshot frames, and on the macOS CI runner
  two pages capturing at once stalled; screenshots now run one at a time, retried once on a fresh
  protocol session.
- Verification screenshots are taken at the element's CSS size. A screenshot scaled below 1x is
  rasterized at that scale, and on sharp content it failed verification against a full-size paint
  for no real difference, sending intervals to the slower screenshot route.

## 0.5.0

### Windows

- CI runs the unit tests and the integration tests on Windows (SwiftShader, Chrome's software H.264
  encoder; HEVC tests skip where no encoder exists), next to macOS and Linux.
- The Claude Code plugin's launcher is now a Node script (`plugin/scripts/mcp.mjs`) instead of `sh`,
  so the plugin starts on Windows; it installs and starts exactly as before, and CI installs from the
  commit through it on Linux and Windows.
- Chrome discovery joins paths for the target platform, also looks in `Program Files (x86)`, and no
  longer makes a relative path when `LOCALAPPDATA` is unset.
- `resolveInsideRoot` normalizes its root; `.gitattributes` keeps LF in Windows checkouts;
  `npm run test:integration` works in `cmd.exe` (`node --env-file`).
- `doctor` reports a software GPU as a warning: renders work, only more slowly.

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

- MP4 colour description: the `colr` box said sRGB (transfer 13), from Chrome's canvas frames, while
  the H.264/HEVC bitstream said BT.709. QuickTime and Safari read the box, so FrameVelo files were
  shown with the sRGB curve since 0.1.0. The muxer now tags the stream BT.709 as well. Found by CI,
  whose FFmpeg 9 reports the container's value.
- A page replaced after verification is now closed: it kept a second copy of the composition for the
  whole render (about 170 MB more peak memory on a 1080p DOM page).
- HyperFrames: the fresh page prepares alongside the main one, so a page that waits out the readiness
  timeout pays it once (`webgl-video-texture-render-compat`: 94 s back to 49 s).
- Full Chrome: every capture page opens in a window of its own. Chrome paints only its front tab, so a
  second page (the fresh page, a worker) never painted and HyperFrames renders hung;
  `chrome-headless-shell` was unaffected.

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
