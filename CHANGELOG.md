# Changelog

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
