# FrameVelo：代码视频渲染加速 — 方案调研与可行性

- 日期：2026-10-23
- 目标：参照 [HyperFrames-RenderKit](https://github.com/xiaotianfotos/HyperFrames-RenderKit)，在 **macOS / Apple M3** 上做一个“代码写成的视频”（HyperFrames、canvas/three.js 等按时间求值的网页）渲染加速工具，**尽量压低耗时、CPU 和内存**。
- 测试机：MacBook Pro M3 Pro（5P + 6E 核，18 GB 统一内存，1 个视频编码引擎）、macOS 27.0.1、Google Chrome 155.0.8059.85、HyperFrames CLI 0.8.186、FFmpeg 7.0.2。
- 所有数字均在本机实测，脚本在 [`research/bench/`](../research/bench/)，可复现。

---

## TL;DR

**可行，而且不需要像 RenderKit 那样编译定制 Chromium。**

推荐路线：**单个 Chrome、单个页面，DOM 用 `drawElementImage()`（纯 canvas 合成直接用 canvas）→ `new VideoFrame(canvas)` → WebCodecs `VideoEncoder`（Chrome 在 Mac 上走 VideoToolbox 硬编）→ 码流直接封装（stream copy）**。帧数据全程留在 GPU 侧，不再经过 JPEG/PNG 编解码、base64、CPU 色彩转换和 x264 软编。

同一个 GSAP 合成（10 秒，300 帧），与官方 `hyperframes render` 端到端对比：

| 场景 | 方案 | 墙钟 | CPU 时间 | 峰值内存 |
|---|---|---:|---:|---:|
| 1080p30 | 官方默认（4 worker，截图 + x264） | 20.3 s | 62.1 s | 2649 MB |
| 1080p30 | 官方 `--gpu`（截图 + ffmpeg VideoToolbox） | 15.7 s | 29.1 s | 2232 MB |
| 1080p30 | **FrameVelo 原型** | **7.5 s** | **13.7 s** | **1468 MB** |
| 4K30 | 官方默认 | 47.5 s | 234 s | 3296 MB |
| 4K30 | 官方 `--gpu` | 37.3 s | 96.5 s | 2500 MB |
| 4K30 | **FrameVelo 原型** | **9.7 s** | **18.3 s** | **1650 MB** |

- 1080p：比官方默认 **快 2.7 倍、CPU 降到 1/4.5、内存少 45%**；画质与官方 `--gpu` 持平（PSNR 42.9 vs 42.5 dB）。
- 4K：**快 4.9 倍、CPU 降到 1/12.8、内存减半**；PSNR 46.4 dB / SSIM 0.993。
- 纯 canvas 合成（`code-video` 这类 Canvas 2D 按时间求值的形态）：**170 fps vs 17 fps，约 10 倍**，CPU 从 60 s 降到 7.6 s。

主要风险：`drawElementImage`（HTML-in-Canvas）仍是 Origin Trial（延长到 Chrome 160），API 在 Chrome 155 改过名。对策：钉死 Chrome for Testing 版本，加一层 API 适配，按区间抽帧自校验，失败的区间回退到「截图 + VideoToolbox」。

---

## 1. 参考项目 RenderKit 在做什么

[HyperFrames-RenderKit](https://github.com/xiaotianfotos/HyperFrames-RenderKit)（最新提交 2026-08-20）是一个 **Linux x86_64 + Intel VAAPI** 专用的确定性渲染工具链：

- **定制 Electron 43.3 / Chromium 150**，一个约 570 行的补丁（`patches/0001-production-runtime.patch`）：
  - 新增 `HTMLCanvasElement.requestSynchronousPaint()`：同步跑完 Blink 生命周期，让逐帧采集**不受显示器 vsync 节拍限制**；
  - 修 VAAPI 编码器 / GBM / Wayland 的 NV12、共享内存输入问题，让 WebCodecs 能用 Intel 硬编。
- 管线：静态预检（CSS / 媒体风险扫描）→ `RenderPlan` + 按区间的 `FrameBackendPlan` → 视频素材用 WebCodecs `VideoDecoder` 精确到 PTS 解码 → `drawElementImage` 把 DOM 画进 canvas → WebCodecs H.264 → Annex-B 管道 → FFmpeg 只做 stream copy → 原子落盘。
- 不支持的语义（滤镜、遮罩、复杂层叠）显式规划为「忠实截图」区间，**禁止运行时偷偷降级**。
- 编译环境要求：80 GB 磁盘、32 GB 内存。

**对 Mac 的启示**：核心思路——DOM 直接画进 canvas、GPU 上编码、FFmpeg 只封装——完全适用；但它的补丁是为 Linux/VAAPI/Wayland 写的，Mac 上用不到（见 §4.2），也没必要在 18 GB 的机器上编 Chromium。

## 2. 官方 HyperFrames 在 Mac 上的现状（v0.8.186）

读了 `packages/engine` 源码并在本机跑了渲染日志：

- 浏览器：Puppeteer + `chrome-headless-shell` 152。Linux 用 `HeadlessExperimental.beginFrame`；Mac 只能截图（`Page.captureScreenshot`）或 drawElement。
- Mac 上 drawElement 默认开启（v0.7.38 起），但帧出页面的方式是：drawElementImage → OffscreenCanvas worker 压 **JPEG** → **base64** 经 CDP binding 传回 Node → FFmpeg **解 JPEG** → CPU 上做 RGB→YUV → **libx264 软编**（`--gpu` 时换成 `h264_videotoolbox`，色彩转换仍在 CPU）。
- **本机实际情况**（日志原文）：
  - 默认 `auto` 选了 **4 个 worker（4 个 Chrome）**，同时打出 `default-on drawElement disabled for this render: parallel capture has no runtime self-verification`，即**多 worker 时直接关掉 drawElement**，走 4 个截图 + x264。
  - `--workers 1` 时尝试 drawElement，但 `drawElement self-verify failed at frame 75: 16.1dB < 32`，**整片回退为截图重渲**（28.6 s）。
  - 同一合成在我们的原型里（Chrome 155）这几帧与截图的 PSNR 为 57–59 dB，说明问题出在官方那条路径（Chrome 152 / 注入方式），不是 drawElement 方案本身；具体原因没有深究。

结论：**官方在 Mac 上实际跑的基本是最慢的那条路**，而且 CPU 大头花在「图片编解码 + 搬运 + 软编」这些本可以避免的环节。

## 3. 实测数据

方法说明：

- 内存 = 采样期间整个进程树（node + Chrome 全部子进程 + ffmpeg）RSS 之和的峰值，200 ms 采样一次。共享内存会被重复计算，GPU 显存（IOSurface）不完全计入，所以只适合横向比较。
- CPU = 进程树累计 CPU 时间（user + sys）。
- 画质 = 与**同一管线自己的无损采集**逐帧比较 PSNR / SSIM（官方用它自己的 `--format png-sequence` 作参考，因为官方运行时会把 `system-ui` 映射成自带字体，像素和我们不同）。
- 除非特别说明，均为单次运行；de-wc 重复跑了 4 次，fps 在 43.4–45.6 之间。

### 3.1 端到端：同一 GSAP 合成，官方 CLI vs 原型

合成：80 张带圆角、渐变、`box-shadow` 模糊阴影的卡片 + 3 个 520 px 径向渐变光斑 + 逐字动画标题 + 文本，全部由一条暂停的 GSAP 时间线驱动（`research/bench/hfproj/index.html`，通过 `hyperframes lint`）。

| 方案 | 墙钟 | CPU | 峰值内存 | 文件 | PSNR / SSIM |
|---|---:|---:|---:|---:|---|
| 官方默认 1080p（4 worker，截图 + x264 crf16） | 20.33 s | 62.1 s | 2649 MB | 14.3 MB | 44.20 dB / 0.9875 |
| 官方 `--gpu` 1080p | 15.73 s | 29.1 s | 2232 MB | 12.7 MB | 42.50 dB / 0.9842 |
| 官方 `--workers 1` 1080p（drawElement 校验失败 → 截图重渲） | 28.61 s | 63.8 s | 1506 MB | 14.3 MB | — |
| **原型 1080p**（drawElement + WebCodecs，12 Mbps） | **7.46 s** | **13.7 s** | **1468 MB** | 15.1 MB | 42.90 dB / 0.9855 |
| 官方默认 4K | 47.45 s | 234.0 s | 3296 MB | 37.0 MB | 未测 |
| 官方 `--gpu` 4K | 37.31 s | 96.5 s | 2500 MB | 12.7 MB | 未测 |
| **原型 4K**（40 Mbps） | **9.70 s** | **18.3 s** | **1650 MB** | 46.4 MB | 46.43 dB / 0.9926 |

注：原型墙钟包含 node 启动、Chrome 启动和封装；官方墙钟包含 CLI 启动、编译和校准。

### 3.2 管线拆解（1080p30，300 帧，只计渲染阶段）

合成：`www/comp.html`（视觉同上，直接用 JS 按时间求值）。

| 管线 | fps | CPU | 峰值内存 | 浏览器→Node 传输量 |
|---|---:|---:|---:|---:|
| CDP 截图 JPEG → ffmpeg 解码 → x264 medium crf18（≈ 官方截图路径） | 18.1 | 54.8 s | 1900 MB | 78.5 MB |
| drawElement → JPEG → ffmpeg → VideoToolbox | 23.7 | 21.4 s | 1736 MB | 78.3 MB |
| **drawElement → WebCodecs（VideoToolbox）** | **45.5** | **13.6 s** | **1271 MB** | 20.1 MB（已是 H.264 码流） |
| 同上，去掉 80 个 `box-shadow` | 149.6 | 9.0 s | 1573 MB | 20.0 MB |
| 截图 → x264，去掉 `box-shadow` | 32.9 | 43.7 s | 2204 MB | 73.2 MB |

CPU 按进程分布：

| 管线 | ffmpeg | GPU 进程 | 浏览器主进程 | 渲染进程 | node |
|---|---:|---:|---:|---:|---:|
| 截图 → x264 | **26.2 s** | 14.4 s | 8.7 s | 4.3 s | 1.2 s |
| drawElement → WebCodecs | 0 s | 6.4 s | 2.0 s | 4.4 s | 0.6 s |

### 3.3 纯 canvas 合成（code-video 形态）

`www/canvas.html`：1500 个粒子 + 40 个带阴影旋转方块 + 渐变背景 + 文字，Canvas 2D 按时间纯函数绘制。

| 管线 | fps | CPU | 峰值内存 | 传输量 |
|---|---:|---:|---:|---:|
| `toDataURL('image/png')` → ffmpeg → x264 medium（≈ 常见 PNG 管道渲染脚本，如 `code-video` 的 `render.mjs`，subframes=1） | 17.3 | 60.4 s | 2668 MB | 489 MB |
| **canvas → WebCodecs（VideoToolbox）** | **170.3** | **7.6 s** | **1502 MB** | 20.1 MB |

`code-video` 默认 `--subframes 3`（3 次采样合成运动模糊），现有路径的成本还要再乘 3 并加上 ffmpeg `tmix`；改为在 GPU 上累加子帧后只编码一次，收益会更大（未实测）。

### 3.4 编码器本身（ffmpeg，testsrc2 BGRA 输入，300 帧）

| 分辨率 | 编码器 | 墙钟 | CPU | 峰值内存 |
|---|---|---:|---:|---:|
| 1080p | libx264 medium crf18 | 1.95 s | 14.6 s | 868 MB |
| 1080p | libx264 veryfast | 1.00 s | 8.0 s | 643 MB |
| 1080p | h264_videotoolbox | 1.58 s | 4.6 s | 259 MB |
| 1080p | hevc_videotoolbox | 1.67 s | 4.7 s | 259 MB |
| 1080p | prores_videotoolbox | 0.79 s | 0.6 s | 333 MB |
| 4K | libx264 medium crf18 | 8.01 s | 58.9 s | **2944 MB** |
| 4K | libx264 veryfast | 4.13 s | 32.5 s | 2380 MB |
| 4K | h264_videotoolbox | 5.49 s | 16.8 s | 886 MB |
| 4K | hevc_videotoolbox | 5.90 s | 16.9 s | 886 MB |
| 4K | prores_videotoolbox | 2.21 s | 2.7 s | 818 MB |

`h264_videotoolbox` 在 ffmpeg 里仍有 4.6–16.8 s CPU，几乎都是 swscale 做 BGRA→NV12（`-pix_fmt bgra` 也会被自动转换）。WebCodecs 在 Chrome 里把这一步放到 GPU 上，这是 CPU 再降一档的原因。

### 3.5 并行能不能更快？不能

| 并行方式（drawElement + WebCodecs，300 帧分段） | 1 | 2 | 3 | 4 |
|---|---:|---:|---:|---:|
| 同一浏览器多窗口：fps | 45.5 | 47.2 | 47.7 | 44.7 |
| 同一浏览器多窗口：峰值内存 | 1271 MB | 1779 MB | 1958 MB | 2075 MB |
| 多个独立浏览器：fps | 45.5 | 50.1 | 40.1 | 39.6 |
| 多个独立浏览器：峰值内存 | 1271 MB | 2397 MB | 3431 MB | 4406 MB |

GPU 进程的 CPU 时间约等于墙钟（单线程打满），开多个浏览器后 GPU 硬件本身成为瓶颈。M3 Pro 只有一块 GPU 和一个视频编码引擎，**单页面串行就是最优**，多开只会成倍吃内存。另外 headless 下同一窗口的后台标签页不出帧（`paint` 事件被节流），需要多页时必须用独立窗口。

### 3.6 保真度

| 对比 | PSNR | SSIM |
|---|---:|---:|
| drawElement 无损采集 vs 原生截图无损采集（comp.html，300 帧） | 57.79 dB | 0.99847 |
| 同上（GSAP 合成，300 帧；第 75/150/225/285 帧分别 59.2/57.0/57.4/57.2 dB） | 57.78 dB | 0.99848 |
| WebCodecs 16 Mbps（20.1 MB）vs 无损 | 43.86 dB | 0.9877 |
| WebCodecs 10 Mbps（12.6 MB）vs 无损 | 42.57 dB | 0.9848 |
| x264 crf18 medium（10.6 MB）vs 无损 | 43.07 dB | 0.9844 |

- Chrome 155 + Metal 下 drawElement 与原生合成在像素上基本一致（> 57 dB）。
- 要达到 x264 crf18 的画质，VideoToolbox 大约需要 **1.2 倍码率**；如果要更小的文件，可以换 HEVC。

## 4. 关键结论

1. **CPU 和内存主要花在「搬图」和「软编」上，而不是渲染本身。** 截图路径里 ffmpeg 一个进程就占 26 s CPU；4K x264 单进程就要 2.9 GB 内存。把编码挪到 VideoToolbox、把色彩转换挪到 GPU、只把压缩后的码流（约为 JPEG 的 1/4、PNG 的 1/24）传给 Node，是最大的收益来源。
2. **Mac 上不需要定制 Chromium。** RenderKit 的补丁主要解决两件事：Linux 下 vsync 节拍限制和 VAAPI 编码缺陷。实测 stock Chrome 155 加 `--disable-gpu-vsync --disable-frame-rate-limit` 后，`requestPaint()` → `paint` 循环在轻内容上能跑到 150 fps（远超 60 Hz），说明不受 vsync 限制；VideoToolbox 也已接入 WebCodecs（H.264/HEVC 硬编均 `supported: true`，AV1/VP9 硬编不支持）。
3. **不要多进程并行。** 见 §3.5：GPU 受限，多开只涨内存。这也正好契合「最小化内存」的目标。
4. **DOM 路径的新瓶颈是 GPU 每帧重放绘制。** `drawElementImage` 每帧都重放元素的绘制指令，不复用合成器的图层光栅缓存，模糊阴影 / 滤镜类效果每帧都要重算：80 个 `box-shadow` 时 45 fps，去掉后 150 fps。这是下一阶段优化的主攻点（见 §5.3 O2）。
5. **4K 几乎是免费的。** 把 canvas 的后备尺寸设为 3840×2160（CSS 尺寸仍为 1920×1080），`drawElementImage` 会自动按比例以矢量重绘（文字锐利），耗时只从 7.5 s 增加到 9.7 s。注意不要再叠加 `ctx.scale(2,2)`，否则会被放大 4 倍（踩过的坑）。

## 5. 推荐方案：FrameVelo 架构

### 5.1 数据流

```
项目目录
  │  复用官方编译器（@hyperframes/core / producer，Apache-2.0）产出单文件 HTML（字体、子合成已内联）
  ▼
规划器：特征扫描 → 为每个区间选一条路线
  │   canvas-direct（纯 canvas / WebGL 合成）
  │   dom-drawelement（普通 DOM / CSS / GSAP）
  │   screenshot-vt（不支持的语义：未合成的 WebGL 子画布、视频、特殊滤镜等）
  ▼
钉死版本的 Chrome for Testing ×1，页面 ×1
  │  每帧：seek(t) → canvas.requestPaint() → paint 事件里 drawElementImage(root)
  │        → new VideoFrame(canvas, {timestamp}) → VideoEncoder.encode()（队列 ≤ 4，有背压）
  │  EncodedVideoChunk（压缩码流）→ 二进制通道 → Node
  ▼
Node：封装（mediabunny 或 ffmpeg -c copy）+ 音频（复用官方 audioMixer → aac_at）
  → 临时文件 → 校验（帧数 / 时长 / 色彩元数据 / 抽帧 PSNR）→ 原子 rename
```

### 5.2 关键组件

| 组件 | 做法 | 依据 |
|---|---|---|
| 时间驱动适配器 | HyperFrames：`window.__player.seek` / `__hf` 协议；通用：`window.__seek(t)`；code-video：canvas 纯函数 | 官方 engine `frameCapture.ts`、RenderKit `full-canvas-renderer.js` |
| 采集 | `<canvas layoutsubtree>` 包住合成根节点，`requestPaint` + `paint` 事件里 `drawElementImage`；WebGL/WebGPU 子画布按官方 `instrumentAcceleratedCanvases` 的做法手动合成 | 原型 `www/capture.js`、官方 `drawElementService.ts` |
| 编码 | WebCodecs `VideoEncoder`，`avc1.640033` / `hvc1`，`hardwareAcceleration: 'prefer-hardware'`，`latencyMode: 'quality'`（`realtime` 实测反而更慢：34.6 vs 45.5 fps），队列 ≤ 4 | §3.2 参数扫描 |
| 传输 | 压缩码流按约 2 MB 批量走 CDP binding；正式版可换 WebSocket 二进制帧，省掉 base64 | 原型实测 node 进程 CPU < 1 s |
| 封装 | mediabunny（MPL-2.0，RenderKit 也在用）或 ffmpeg stream copy；显式写 BT.709 色彩元数据 | 见 §6 色彩 |
| 自校验与回退 | 每个区间抽 K 帧，对比 drawElement 与截图（官方阈值 32 dB）；不达标的**区间**改走 screenshot-vt，而不是整片重渲 | 官方整片回退花了 28.6 s |
| 资源上限 | 单页面、编码队列有界、Node 侧不缓存帧 → 内存不随视频时长增长 | §3.5 |

### 5.3 后续优化（按预期收益排序）

- **O1 静帧 / 保持帧去重**：时间线在相邻帧间没有属性变化时跳过 paint，重复编码上一帧（或打 duplicate 标记）。官方已有 `staticFrameDedup`，可以参考。
- **O2 图层光栅缓存**：只做 transform/opacity 动画的元素（GSAP 最常见的情况），用 `captureElementImage()` 光栅化一次，之后每帧用 canvas 变换合成，避免重放阴影 / 模糊。在阴影很重的合成上，上限约 3 倍（45 → 150 fps）。需要配合抽帧校验，因为层叠上下文和混合模式有保真风险。
- **O3 GPU 运动模糊**（code-video）：子帧在 canvas 里用 `globalAlpha` 或 WebGL 累加后只编码一次，取代「N 张 PNG + ffmpeg tmix」。
- **O4 视频素材**：页面内用 `VideoDecoder`（VideoToolbox 硬解）按精确 PTS 取帧（RenderKit 的做法），取代官方用 ffmpeg 抽帧再注入。**未实测**，这是带视频素材的项目里最大的未知数。
- **O5 HEVC 输出**：同画质下文件更小，编码速度与 H.264 相同（§3.4）。

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| HTML-in-Canvas 仍是 Origin Trial（延长到 Chrome 160）；Chrome 155 改了 API（`layoutsubtree` → `content="drawable"`，`drawElementImage` 改为返回 void 等） | 升级 Chrome 后可能失效 | 钉死 Chrome for Testing 版本；采集层做 API 适配；升级前跑保真回归。官方 HyperFrames 也默认依赖这个 API，生态上有推动力 |
| drawElement 已知缺陷：WebGL/WebGPU 画布会冻结在第一帧；Chrome ≤ 150 局部透明度丢元素；`<video>` 纹理 | 画面错误 | 版本 ≥ 155；手动合成加速画布；抽帧自校验 + 区间回退 |
| 官方路径在本机校验失败（Chrome 152） | 说明不同版本 / 实现差异很大 | 每次升级 Chrome 都要跑保真回归；不要假设结论能跨版本 |
| VideoToolbox 码控：WebCodecs 只有 bitrate / quantizer，没有 CRF | 同画质文件略大 | 默认按分辨率给码率（1080p30 ≈ 12–16 Mbps，4K30 ≈ 35–40 Mbps）；评估 `bitrateMode: 'quantizer'`（未测） |
| 色彩标记：WebCodecs 输出的 transfer 被标成 `iec61966-2-1`（sRGB）而不是 BT.709 | 个别播放器 / 剪辑软件色偏 | 封装时显式写 BT.709 primaries / transfer / matrix，并加探测校验 |
| 硬件编码不保证逐比特可复现 | 不能用文件哈希做回归 | 回归测试用解码后的 PSNR/SSIM |
| 透明通道 / ProRes 4444 | WebCodecs 不支持 | 这类输出走「截图或 drawElement 读回 → ffmpeg `prores_videotoolbox`」，单独一条路线 |
| 机型差异 | M3 Pro 只有 1 个编码引擎，M3 Max 有 2 个 | 编码不是当前瓶颈（纯 canvas 能跑 170 fps），影响不大 |

## 7. 为什么不照搬 RenderKit

- 它的补丁针对 Linux + VAAPI + Wayland，Mac 上用不到；Mac 上 stock Chrome 已经满足「不被 vsync 限速 + 硬件编码」这两个前提（§4.2）。
- 编译 Chromium 需要 80 GB 以上磁盘、32 GB 以上内存和数小时，而本机只有 18 GB 内存；每次跟进上游都要重新编译。
- 它在「确定性交付」上的工程纪律值得逐步吸收：区间路由计划、精确 PTS 的媒体解码、整数采样边界的音频、有界资源、原子落盘、显式回退。这些放在 M2/M3 阶段做。

## 8. 里程碑（粗略估计）

| 阶段 | 内容 | 估时 |
|---|---|---|
| M0 | CLI MVP：通用可 seek 页面 + 纯 canvas 合成 → MP4（WebCodecs + 封装 + 音频）；接入 `code-video` 的 `render.mjs`（加 `--capture webcodecs`） | 2–3 天 |
| M1 | HyperFrames 适配：复用官方编译产物（字体、子合成）、`__player.seek`、音频混音；与官方输出做 PSNR 对齐测试 | 1–2 周 |
| M2 | 规划器 + 抽帧自校验 + 区间回退（screenshot-vt）；色彩元数据；60 fps / 4K / HEVC；有界资源与原子落盘 | 1–2 周 |
| M3 | 视频素材走 VideoDecoder；静帧去重；图层光栅缓存；GPU 运动模糊 | 2 周以上 |

M0 的核心代码基本就是 `research/bench/www/capture.js` 里的 `__renderWebCodecs` 加上 `bench.mjs` 的 de-wc 分支，风险最低，建议先做，用来验证真实项目的收益。

## 9. 复现

```bash
cd research/bench && npm i && npm run setup
```

```bash
node bench.mjs de-wc 300 hf.html
```

```bash
node measure.mjs official -- npx hyperframes@0.8.186 render hfproj -o official.mp4 --quiet
```

更多模式见 `bench.mjs` 文件头（`shot-x264`、`de-jpeg-vt`、`canvas-png-x264`、`canvas-wc`、`de-wc-par`；环境变量 `SCALE=2` 跑 4K，`LOSSLESS=1` 生成参考帧，`LITE=1` 去掉阴影）。编码器对比：`bash enc.sh`。能力探测：`node probe.mjs "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`。

## 参考

- [HyperFrames-RenderKit](https://github.com/xiaotianfotos/HyperFrames-RenderKit)（README、`skills/hyperframes-render-optimization/references/pipeline.md`、`patches/0001-production-runtime.patch`）
- [HyperFrames](https://github.com/heygen-com/hyperframes)（`packages/engine/src/config.ts`、`services/drawElementService.ts`、`services/frameCapture.ts`，提交 e85f56e，2026-10-22）
- [HTML-in-Canvas updates: Iterating toward a better Web API](https://developer.chrome.com/blog/html-in-canvas-ot-changes)（Chrome 150/155 的 API 变更，Origin Trial 延长到 Chrome 160）
- [Microsoft Edge Origin Trials: html-in-canvas](https://developer.microsoft.com/en-us/microsoft-edge/origin-trials/trials/a297467e-0030-4c4c-8739-48e130026c03)
- [Better Stack: HTML-in-Canvas API guide](https://betterstack.com/community/guides/scaling-nodejs/html-in-canvas-api/)
- [MacBook Pro Technical Specifications](https://www.apple.com/macbook-pro/specs/)（M3 Pro：1 个视频编码引擎、1 个 ProRes 引擎；M3 Max：各 2 个）
- [Chromium: VideoToolbox H.264 encode accelerator CL](https://codereview.chromium.org/1636083003)
- [Mediabunny](https://github.com/Vanilagy/mediabunny)

---

## 附录：实现后的结论（v0.2，2026-10-23）

M0–M3 已实现，架构说明见 [architecture.md](architecture.md)。与最初方案相比，有以下修正和新发现：

| 主题 | 原方案 | 实际结论 |
|---|---|---|
| HyperFrames 适配 | 复用官方编译产物 | 采用官方面向第三方接入者的 `plan()`（`plan-dir-v1`）：编译、字体、子合成、视频抽帧、混音都交给官方；FrameVelo 只替换采集与编码，并通过 `window.__hf.seek` 驱动官方运行时 |
| 浏览器 | 钉死 Chrome for Testing | 优先 `chrome-headless-shell`：画面一致，CPU 和内存约为完整版 Chrome 的一半（DOM 合成 CPU 13.2 s → 6.3 s，内存 1422 MB → 646 MB；纯 canvas CPU 7.9 s → 1.9 s） |
| 抽帧自校验 | 每个区间抽样对比截图 | 已实现；路线切换会让 CSS 动画重启、iframe 重载、捕获画布内容丢失，均需专门处理；含 iframe 的页面跳过校验 |
| 时间线副作用 | 未考虑 | 校验、子帧、复位都必须用静默 seek（`suppressEvents`），否则 GSAP `.call()` 会被重复触发 |
| 音频 | 官方混音 + 封装 | `-shortest` 和输出端 `-t` 都会在音轨略短或起点为负（AAC 前导）时截掉视频尾帧；改为在音频输入端限长 |
| 视频素材（HyperFrames） | 页面内 VideoDecoder 取代官方抽帧 | 保留官方抽帧 + 官方注入器。实测：换 `<img>` 后要多一次完整渲染更新才能进入 drawElement 快照（否则画面落后一帧，且偶发），每帧下限约一个帧间隔；页面内注入并不更快；原生 seek 帧精确但颜色走 Chrome 管线、远程源每次重新取数据、长 GOP 源慢 3.5 倍 |
| 视频素材（普通页面） | 未细化 | `<video data-start>` 原生 seek（Chrome 硬件解码），逐帧精确；长 GOP 源自动生成全帧内代理（VideoToolbox，保留时间戳，带缓存），单关键帧 1080p 视频 31.1 s → 10.0 s（命中缓存约 8 s） |
| 静帧去重 | 时间线静态分析 | 改为运行时观察：seek 后合成子树无 DOM 变动、动画时钟不变、无加载中的图片即复用上一帧绘制，输出逐字节一致 |
| 图层光栅缓存 | 优化方向 O2 | 暂缓：`drawElementImage` 只能绘制画布的直接子元素，无法把缓存图层按层叠顺序与其余内容交错合成，等于重写合成器，保真风险高 |
| 一致性测试 | 与官方输出做 PSNR 对齐 | `scripts/parity.ts` 在同一台机器上用官方 CLI 与 FrameVelo 渲染官方回归用例并逐帧对比，结果见 README |
