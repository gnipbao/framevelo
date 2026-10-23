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

## 为什么：M3 Pro 实测

同一个 GSAP 合成（80 张带阴影的卡片、渐变、文字；10 秒，300 帧），与官方 `hyperframes render` 0.8.186 对比：

| 场景 | 管线 | 墙钟 | CPU 时间 | 峰值内存 |
|---|---|---:|---:|---:|
| 1080p30 | HyperFrames 默认（4 worker，截图 + x264） | 20.3 s | 62.1 s | 2649 MB |
| 1080p30 | HyperFrames `--gpu` | 15.7 s | 29.1 s | 2232 MB |
| 1080p30 | **FrameVelo** | **7.5 s** | **13.7 s** | **1468 MB** |
| 4K30 | HyperFrames 默认 | 47.5 s | 234 s | 3296 MB |
| 4K30 | HyperFrames `--gpu` | 37.3 s | 96.5 s | 2500 MB |
| 4K30 | **FrameVelo** | **9.7 s** | **18.3 s** | **1650 MB** |

FrameVelo 一行是调研原型在空闲机器上的测量值；在同等条件下交替测试，CLI 与原型持平或更快。

纯 Canvas 2D 场景从 PNG + x264 管线的 17 fps 提升到 170 fps。1080p 画质与官方 `--gpu` 持平（PSNR 42.9 vs 42.5 dB）；drawElement 采集与 Chrome 原生截图的差异为 PSNR 57.8 dB / SSIM 0.998。

完整方法、数据和风险：[docs/research-render-acceleration.md](docs/research-render-acceleration.md)。可复现的基准脚本：[research/bench](research/bench)。

## 环境要求

- Apple 芯片的 macOS（其他平台未测试）
- Node.js 22.18 或更高
- DOM 采集需要 Google Chrome 151 或更高（HTML-in-Canvas `drawElementImage`）；纯 canvas 页面用较新的 Chrome 即可
- `PATH` 中有 FFmpeg 和 FFprobe

## 安装

还没发布到 npm，先从 GitHub 安装：

```bash
npm install -g github:gnipbao/framevelo
```

然后检查本机环境：

```bash
framevelo doctor
```

`doctor` 会报告找到的 Chrome、`drawElementImage` 是否可用、哪些 WebCodecs 编码器走硬件，以及 FFmpeg / AAC 的情况。

## 快速上手

```bash
framevelo render examples/dom-cards -o dom-cards.mp4
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --scale 2 --codec hevc
```

```bash
framevelo render my-film/ -o my-film.mp4 --audio score.wav --subframes 3
```

输入是一个 `.html` 文件，或者一个包含 `index.html` 的目录。FrameVelo 会在 `127.0.0.1` 上提供这个目录，用 headless Chrome 打开，然后逐帧推进时间。

## 让页面可以 seek

每一帧都必须是时间的纯函数。FrameVelo 按以下顺序查找时间驱动：

1. `window.__framevelo = { seek(t), duration, fps }`。`seek` 可以返回 Promise；`duration` 和 `fps` 可省略。
2. `window.__seek(t)`，可选 `window.__duration`。
3. 注册在 `window.__timelines.main`（或第一个键）上的暂停 GSAP 时间线，即 HyperFrames 的约定。合成根节点上的 `data-duration`、`data-width`、`data-height`、`data-fps` 会被读取。

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

依赖 `requestAnimationFrame`、CSS transition 或真实时钟驱动的页面无法 seek，暂不支持。

### 采集什么

- **Canvas 模式**：`<canvas>` 本身就是画面。被采集的元素是 canvas 时自动选用。
- **DOM 模式**：被采集的元素（HyperFrames 根节点、`#root` 或 `--selector` 指定的元素）会被移进一个 `<canvas layoutsubtree>`，用 `drawElementImage` 绘制。canvas 的后备尺寸等于输出尺寸，所以 `--scale 2` 会把 1080p 布局按 4K 重新光栅化，而不是放大。

## 命令行

```
framevelo render <input> [options]
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `-o, --output <file>` | `<输入名>.mp4` | 输出 MP4 |
| `--fps <n>` | 页面的 `fps` / `data-fps`，否则 30 | 帧率；支持整数和 NTSC 帧率（29.97、59.94） |
| `--duration <s>` | 页面声明的时长 | 渲染时长（秒） |
| `--frames <n>` | | 精确帧数（优先于 `--duration`） |
| `--start <s>` | 0 | 起始时间；音轨会同步偏移 |
| `--width`、`--height <px>` | 采集尺寸 × 缩放 | 输出尺寸 |
| `--scale <n>` | 1 | 分辨率倍数 |
| `--viewport <WxH>` | `data-width`/`data-height`、viewport meta 或 1920x1080 | CSS 视口 |
| `--mode <m>` | `auto` | `auto`、`canvas` 或 `dom` |
| `--selector <css>` | | 要采集的元素或 canvas |
| `--codec <c>` | `h264` | `h264` 或 `hevc` |
| `--bitrate <b>` | H.264 每像素每帧 0.2 bit，HEVC 0.13 | 目标码率，例如 `12M` |
| `--audio <file>` | | 音轨，编码为 AAC（有 AudioToolbox 时优先使用） |
| `--subframes <n>` | 1 | 每帧平均的子帧数，用于运动模糊 |
| `--shutter <f>` | 0.5 | 子帧覆盖的帧间隔比例 |
| `--background <css>` | 页面背景 | DOM 透明区域后面的颜色 |
| `--chrome <path>` | `FRAMEVELO_CHROME`、已安装的 Chrome、Puppeteer 缓存 | Chrome 可执行文件 |
| `--json` | | 以 JSON 输出结果 |
| `-q, --quiet` | | 不显示进度 |

每次渲染都先写入临时文件，用 FFprobe 校验（视频包数精确、尺寸正确、音轨存在），再重命名到目标位置。渲染失败不会留下半成品。输出带 BT.709 SDR 色彩标记。

## API

```js
import { render } from "framevelo";

const result = await render({
  input: "examples/dom-cards",
  output: "dom-cards.mp4",
  scale: 2,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
console.log(result.wallMs, result.page.encodeWaitMs);
```

## 已知限制

- HyperFrames 目前支持「单个暂停 GSAP 时间线的独立合成」。片段可见窗口（片段上的 `data-start`/`data-duration`）、子合成、`<video>`/`<audio>` 元素和官方字体映射由 HyperFrames 运行时负责，尚未复现，见路线图。
- `drawElementImage` 是 Origin Trial API（到 Chrome 160），并在 Chrome 155 改过形态。DOM 采集里的 WebGL/WebGPU 画布会停在第一帧。目前还没有自动回退到截图。
- 硬件视频编码器只有一个，和其他应用共享。同时运行录屏或视频会议会让编码变慢。
- 硬件编码器需要约 x264 CRF 18 的 1.2 倍码率才能达到相同画质。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | CLI：可 seek 的 HTML 页面和纯 canvas 场景 → MP4（WebCodecs、直接封装、音轨、运动模糊） | 已完成 |
| M1 | HyperFrames 适配：编译产物、子合成、字体、混音；与官方渲染器做一致性测试 | 下一步 |
| M2 | 按区间规划、抽帧对照截图自校验、截图 + VideoToolbox 回退、60 fps / 4K / HEVC 预设 | |
| M3 | 视频素材走硬件 `VideoDecoder`、静帧去重、图层光栅缓存、GPU 运动模糊 | |

## 开发

```bash
npm install
npm test
npm run test:integration
npm run framevelo -- render examples/dom-cards -o out/dom.mp4
```

`npm test` 运行单元测试；`npm run test:integration` 还会通过 Chrome 和 FFmpeg 渲染示例。源码直接运行在 Node 的 TypeScript 类型剥离上；`npm run build` 生成 `dist/`。

## 许可证

[Apache-2.0](LICENSE)
