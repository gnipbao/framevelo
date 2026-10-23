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

## Status

Early development. The first target is macOS on Apple silicon (VideoToolbox via WebCodecs). See the [roadmap](#roadmap).

## Why: measured on an M3 Pro

The same GSAP composition (80 shadowed cards, gradients, text; 10 s, 300 frames), compared with the official `hyperframes render` 0.8.186 CLI:

| Scene | Pipeline | Wall time | CPU time | Peak memory |
|---|---|---:|---:|---:|
| 1080p30 | HyperFrames default (4 workers, screenshot + x264) | 20.3 s | 62.1 s | 2649 MB |
| 1080p30 | HyperFrames `--gpu` | 15.7 s | 29.1 s | 2232 MB |
| 1080p30 | **FrameVelo prototype** | **7.5 s** | **13.7 s** | **1468 MB** |
| 4K30 | HyperFrames default | 47.5 s | 234 s | 3296 MB |
| 4K30 | HyperFrames `--gpu` | 37.3 s | 96.5 s | 2500 MB |
| 4K30 | **FrameVelo prototype** | **9.7 s** | **18.3 s** | **1650 MB** |

A pure Canvas 2D scene renders at 170 fps instead of 17 fps with a PNG + x264 pipeline. Quality at 1080p matches the official `--gpu` output (PSNR 42.9 dB vs 42.5 dB); the drawElement capture matches native Chrome screenshots at 57.8 dB PSNR / 0.998 SSIM.

Full method, data, and risks: [docs/research-render-acceleration.md](docs/research-render-acceleration.md) (Chinese). Reproducible benchmarks: [research/bench](research/bench).

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | CLI: seekable HTML pages and pure-canvas scenes → MP4 via WebCodecs, stream-copy mux, audio track |
| M1 | HyperFrames adapter: compiled compositions, sub-compositions, fonts, audio mix; parity tests against the official renderer |
| M2 | Per-interval planner, sampled self-verification against screenshots, screenshot + VideoToolbox fallback, color metadata, 60 fps / 4K / HEVC |
| M3 | Video sources via hardware `VideoDecoder`, static-frame dedup, layer raster cache, GPU motion blur |

## Requirements

- macOS on Apple silicon (other platforms later)
- Node.js 22.18 or later
- Google Chrome 151 or later (HTML-in-Canvas `drawElementImage`)
- FFmpeg and FFprobe

## License

[Apache-2.0](LICENSE)
