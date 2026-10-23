# FrameVelo architecture

FrameVelo turns a page that can be seeked in time into an MP4. Everything expensive happens on the
GPU or the hardware encoder; Node only moves compressed bytes and orchestrates.

```
                          ┌───────────────────────── Chrome (headless shell) ─────────────────────────┐
 input ──► [compile] ──► │ page ──seek(t)──► composition ──► capture ──► VideoFrame ──► VideoEncoder  │──► Annex-B ──► FFmpeg ──► MP4
                          │        (driver)                   (route)                    (hardware)    │    chunks     stream copy
                          └───────────────────────────────────────────────────────────────────────────┘    + audio, BT.709 VUI, timestamps
```

## Modules

| File | Role |
|---|---|
| `src/cli.ts` | `framevelo render`, `doctor`, `browser install|path`, `mcp` |
| `src/mcp.ts` | MCP server on stdio for coding agents: `render`, `doctor`, `install_browser` tools, progress, cancellation |
| `src/render.ts` | Orchestration: input, compile (HyperFrames), browser, page preparation, video hooks, `captureToFile` |
| `src/capture.ts` | Opens the capture page, plans routes (verification), runs the frame loop (split across pages for Node-driven frames), muxes, verifies, renames |
| `src/page-runtime.ts` | Code that runs in the page: time drivers, capture canvas, paint, encoder, routes, media sync |
| `src/planner.ts` | Intervals, verification samples, routing, PSNR |
| `src/hyperframes.ts` | Optional HyperFrames integration through `@hyperframes/producer` |
| `src/media-proxy.ts` | All-intra proxies for videos on plain pages |
| `src/ffmpeg.ts` | Mux arguments, FFmpeg process, ffprobe verification |
| `src/chrome.ts` | Browser discovery (headless shell first), flags, launch, install |
| `src/server.ts` | Static server with byte ranges and mounts |
| `src/virtual-time-shim.ts` | Virtual time for HyperFrames pages (ported from HyperFrames) |
| `src/options.ts` | Bitrate, frame counts, sub-frame offsets, codec strings |

## Time drivers

The page must be a pure function of time. `pagePrepare` looks for, in order:

1. `window.__framevelo = { seek(t), duration?, fps? }`
2. `window.__hf` (the HyperFrames runtime's seek protocol), when the page is served by the HyperFrames file server
3. `window.__seek(t)` with an optional `window.__duration`
4. A paused GSAP timeline on `window.__timelines` (`main` or the first key)

Seeks are either *rendering* seeks, which may fire timeline callbacks, or *quiet* seeks
(`suppressEvents`) used for verification, sub-frame samples and repositioning. Before the first frame
the playhead is parked quietly, so callbacks such as GSAP `.call()` fire once each, in frame order.

## Capture

**Canvas mode.** The page's `<canvas>` is the frame.

**DOM mode.** The captured element is moved into a `<canvas layoutsubtree>` and drawn with
`drawElementImage` inside the canvas's `paint` event. Details that matter, most learned from the
official HyperFrames capture code:

- The canvas backing store is the output size and its CSS size the layout size, so `--scale 2`
  re-rasterizes vector content at 4K instead of upscaling.
- The snapshot never includes the captured element's own transform; it is applied by hand.
- A sentinel child of the canvas changes every frame so a paint event fires even for static frames.
- WebGL/WebGPU canvases present by texture swap and would freeze in the snapshot. They are tracked
  from `getContext` (with `preserveDrawingBuffer`), hidden from the DOM paint and drawn underneath.
- The HyperFrames page-side shader compositor draws transitions into a fixed overlay above the page;
  the overlay is drawn on top and paint reuse is off while it shows.

**Paint reuse.** A seek that mutated nothing inside the captured element (MutationObserver), changed no
animation clock, and left no image loading cannot change the picture; the previous paint is reused.
Pages with canvas, iframe, SMIL or self-seeked video content always repaint. Output with and without
reuse is byte-identical.

## Encoding and muxing

`new VideoFrame(canvas)` goes to a WebCodecs `VideoEncoder` (`prefer-hardware`, Annex-B, keyframe every
two seconds, bounded queue). Encoded chunks are batched to Node through a binding and piped into FFmpeg,
which only copies the stream: `h264_metadata`/`hevc_metadata` rewrites the VUI to BT.709 SDR (Chrome
tags canvas frames with the sRGB transfer) and `setts` gives frame N the timestamp N (raw Annex-B has
none; the encoder emits only I and P frames, so this is exact). Audio is limited on its input with `-t`,
never with `-shortest` or an output `-t`, which drop trailing video frames when the audio is shorter or
starts before zero. The file is written under a temporary name, checked with ffprobe (exact packet
count, size, audio present) and renamed.

## Routes, verification and fallback

DOM captures are split into intervals at clip boundaries (at most 2 s). Before encoding, the first and
middle frame of each interval are painted with `drawElementImage` and compared, at reduced size, with a
native screenshot of the same moment. Intervals under the threshold (30 dB) are captured with
`Page.captureScreenshot`; those JPEG frames are decoded in the page and fed to the same encoder, so a
mixed render is still one H.264 stream. Routes are decided once, before the first frame.

Moving the composition out of the capture canvas for a screenshot has side effects that the loop
accounts for: the canvas loses its content (verification copies the paint first), CSS animations
restart (every route switch is followed by a seek), and iframes reload (pages with iframes skip
verification; a forced screenshot route waits for the reload).

## HyperFrames projects

A page with a `data-composition-id` root is rendered through the official pipeline when the optional
peer `@hyperframes/producer` is installed:

1. `plan()` from `@hyperframes/producer/distributed` compiles the project (fonts, sub-compositions,
   inlined scripts), extracts `<video>` frames and mixes the audio into a plan directory
   (layout `plan-dir-v1`).
2. `createFileServer` serves the compiled site with the verified HyperFrames runtime, the virtual-time
   shim and the page-side compositing flag.
3. FrameVelo drives `window.__hf.seek` and captures as above.
4. Frames inside a video's window are driven from Node: the official `createVideoFrameInjector` swaps
   each `<video>` for its extracted frame (served same-origin), the canvas runs one paint event so the
   swapped image reaches the paint record, then the frame is painted. Other frames loop in the page.
5. The plan's AAC mix is stream-copied into the MP4.

Chrome starts while the project compiles.

## Parallel pages

Frames driven from Node (video injection, screenshot intervals) cost a few protocol round trips each
and leave the GPU mostly idle, so they are latency-bound where in-page loops are GPU-bound. When a
render has at least 200 such frames per extra page (up to `--workers`, by default a third of the
cores, at most 4), more pages open on the same composition while the main page starts verifying, and
take verification samples from a shared queue as they come up. After routing, the range is split into
contiguous parts, one per page:

- each page parks quietly before the first frame, then seeks normally to the frame before its part,
  so timeline side effects (GSAP `.call()`) replay as in a sequential render;
- each page has its own HyperFrames injector and encoder; the encoder first encodes the frame before
  its part as a discarded warm-up frame (a cold start costs about 2.5 dB on the first keyframe), then
  starts the part on a keyframe; keyframes otherwise follow the video's own GOP grid;
- parts are written to temporary Annex-B files and concatenated in order into the muxer.

On the 1516-frame `hf2550-video-subcomposition-ghost` fixture, 3–4 pages cut the render stage from
38 s to 13–15 s at 7% more CPU and about 40% more peak memory; PSNR against the official render is
unchanged. Below about 200 Node-driven frames per page the page start-up outweighs the gain.

## Video on plain pages

`<video data-start>` (optional `data-media-start`, `data-duration`, `data-playback-rate`) is paused and
seeked to the matching media time on every seek; the frame is painted once `seeked` fires. Sources whose
packets are not all keyframes are replaced by an all-intra proxy (VideoToolbox, passthrough timestamps,
cached in `~/.cache/framevelo/proxies`), so each seek decodes one frame. The static server answers
range requests, without which Chrome cannot seek in MP4.

## Investigated and not adopted

| Idea | Finding |
|---|---|
| Custom Chromium build (RenderKit) | Not needed on macOS: the paint loop is not vsync-bound and VideoToolbox is reachable from WebCodecs |
| Parallel pages for in-page loops, parallel browsers | GPU-bound on M3 Pro; throughput flat, memory grows per page (parallel pages are used only for Node-driven frames) |
| Full Chrome | Same frames at about twice the CPU and memory of `chrome-headless-shell` |
| In-page HyperFrames video injection | A swapped `<img>` needs a second rendering update; no faster than the official Node-side injector |
| Native seeking of HyperFrames videos | Frame-exact but colors follow Chrome rather than the official extraction, remote sources refetch on every seek, 3.5x slower on long-GOP sources |
| Layer raster cache | `drawElementImage` draws only direct children of the canvas, so cached layers cannot be interleaved with the rest of the composition in paint order without reimplementing compositing |
| Waiting for `requestVideoFrameCallback` after a seek | A paused video never presents a frame; it only added a timeout per frame |

## Measuring

`scripts/parity.ts` renders projects with the official CLI and with FrameVelo on the same machine and
reports per-frame PSNR, audio, wall time, CPU and peak memory. `research/bench` holds the original
pipeline benchmarks. `FRAMEVELO_VERIFY_DUMP=<dir>` writes each verification pair;
`FRAMEVELO_DUMP_STREAM=<file>` keeps the raw encoded stream.
