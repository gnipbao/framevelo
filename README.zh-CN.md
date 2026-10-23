# FrameVelo

**Code the motion. Speed the render.**

为代码生成的视频，加速每一帧。 · [English](README.md)

---

FrameVelo 把「用代码写成的视频」渲染成 MP4：包括 [HyperFrames](https://github.com/heygen-com/hyperframes) 这类 HTML/CSS/GSAP 合成，以及按时间纯函数绘制的 Canvas 2D / WebGL 场景。目标是在硬件允许的范围内，把耗时、CPU 和内存压到最低。

大多数代码视频渲染器的做法是：每帧截图或导出 PNG → base64 传回 Node → FFmpeg 再解码 → CPU 上做 RGB→YUV → x264 软件编码。FrameVelo 让帧一直留在 GPU 上：

```
seek(t) ─► drawElementImage（DOM）/ canvas ─► VideoFrame ─► WebCodecs VideoEncoder（硬件编码）
        ─► 压缩后的 H.264/HEVC 码流 ─► 直接封装（不解码、不重编码）
```

## 状态

早期开发中，首个目标平台是 Apple 芯片的 macOS（通过 WebCodecs 调用 VideoToolbox）。路线图见下文。

## 为什么：M3 Pro 实测

同一个 GSAP 合成（80 张带阴影的卡片、渐变、文字；10 秒，300 帧），与官方 `hyperframes render` 0.8.186 对比：

| 场景 | 管线 | 墙钟 | CPU 时间 | 峰值内存 |
|---|---|---:|---:|---:|
| 1080p30 | HyperFrames 默认（4 worker，截图 + x264） | 20.3 s | 62.1 s | 2649 MB |
| 1080p30 | HyperFrames `--gpu` | 15.7 s | 29.1 s | 2232 MB |
| 1080p30 | **FrameVelo 原型** | **7.5 s** | **13.7 s** | **1468 MB** |
| 4K30 | HyperFrames 默认 | 47.5 s | 234 s | 3296 MB |
| 4K30 | HyperFrames `--gpu` | 37.3 s | 96.5 s | 2500 MB |
| 4K30 | **FrameVelo 原型** | **9.7 s** | **18.3 s** | **1650 MB** |

纯 Canvas 2D 场景从 PNG + x264 管线的 17 fps 提升到 170 fps。1080p 画质与官方 `--gpu` 持平（PSNR 42.9 vs 42.5 dB）；drawElement 采集与 Chrome 原生截图的差异为 PSNR 57.8 dB / SSIM 0.998。

完整方法、数据和风险：[docs/research-render-acceleration.md](docs/research-render-acceleration.md)。可复现的基准脚本：[research/bench](research/bench)。

## 路线图

| 阶段 | 内容 |
|---|---|
| M0 | CLI：可 seek 的 HTML 页面和纯 canvas 场景 → MP4（WebCodecs、直接封装、音轨） |
| M1 | HyperFrames 适配：编译产物、子合成、字体、混音；与官方渲染器做一致性测试 |
| M2 | 按区间规划、抽帧对照截图自校验、截图 + VideoToolbox 回退、色彩元数据、60 fps / 4K / HEVC |
| M3 | 视频素材走硬件 `VideoDecoder`、静帧去重、图层光栅缓存、GPU 运动模糊 |

## 环境要求

- Apple 芯片的 macOS（其他平台后续支持）
- Node.js 22.18 或更高
- Google Chrome 151 或更高（HTML-in-Canvas `drawElementImage`）
- FFmpeg 和 FFprobe

## 许可证

[Apache-2.0](LICENSE)
