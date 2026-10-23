# FrameVelo

**Code the motion. Speed the render.**

为代码生成的视频，加速每一帧。 · [English](README.md)

---

FrameVelo 把「用代码写成的视频」渲染成 MP4：[HyperFrames](https://github.com/heygen-com/hyperframes) 项目、[code-video](#code-video-合成) 合成，以及任何按时间纯函数绘制的 HTML/CSS/GSAP 或 Canvas/WebGL 页面。目标是在硬件允许的范围内，把耗时、CPU 和内存压到最低。

大多数代码视频渲染器的做法是：每帧截图或导出 PNG → base64 传回 Node → FFmpeg 再解码 → CPU 上做 RGB→YUV → x264 软件编码。FrameVelo 让帧一直留在 GPU 上：

```
seek(t) ─► drawElementImage（DOM）/ canvas ─► VideoFrame ─► WebCodecs VideoEncoder（硬件编码）
        ─► 压缩后的 H.264/HEVC ─► 直接封装 + 音轨 ─► 校验后的 MP4
```

<!-- results -->

## 环境要求

- Apple 芯片的 macOS（其他平台未测试）
- Node.js 22.18 或更高
- `PATH` 中有 FFmpeg 和 FFprobe
- DOM 采集需要 Chrome 151 或更高：优先使用 `chrome-headless-shell`（`framevelo browser install`），已安装的 Google Chrome 也可以
- 渲染 HyperFrames 项目需要 `@hyperframes/producer` 和 `@hyperframes/engine` 0.8.x（可选 peer 依赖）

## 安装

还没发布到 npm，先从 GitHub 安装；要渲染 HyperFrames 项目就一并装上官方包：

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8 @hyperframes/engine@0.8
```

安装轻量浏览器并检查本机环境：

```bash
framevelo browser install
```

```bash
framevelo doctor
```

`doctor` 会报告将使用的浏览器、`drawElementImage` 是否可用、哪些 WebCodecs 编码器走硬件、FFmpeg 与 AAC，以及 HyperFrames 支持情况。

## 快速上手

```bash
framevelo render my-hyperframes-project/ -o film.mp4
```

```bash
framevelo render examples/dom-cards -o dom-cards.mp4 --scale 2
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --codec hevc --subframes 3
```

输入是一个 `.html` 文件，或者一个包含 `index.html` 的目录。

## 能渲染什么

### HyperFrames 项目

根节点带 `data-composition-id` 的页面会交给官方 HyperFrames 管线编译和提供服务：字体、子合成、片段可见窗口、`<video>` 帧、着色器转场和混音都与 `hyperframes render` 一致，FrameVelo 只替换采集和编码。加 `--no-hyperframes` 可按普通页面渲染。

### code-video 合成

用 code-video skill 的 `defineComposition()` 写成的页面可以直接渲染：FrameVelo 会把 skill 目录挂到 `/@skill/`（取自 `CODE_VIDEO_SKILL_DIR` 或 `~/.claude/skills/code-video`），用 `window.seek(t)` 推进时间，从 `window.__comp` 读取时长和帧率，并封装合成里声明的配乐。

### 任何可 seek 的页面

每一帧都必须是时间的纯函数。FrameVelo 按以下顺序查找时间驱动：

1. `window.__framevelo = { seek(t), duration, fps }`（`seek` 可以返回 Promise）
2. `window.__seek(t)`，可选 `window.__duration`
3. 注册在 `window.__timelines.main`（或第一个键）上的暂停 GSAP 时间线

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

视频素材用 `<video data-start="0.5">` 放到合成时间轴上（可选 `data-media-start`、`data-duration`、`data-playback-rate`），FrameVelo 每帧都会逐帧精确地定位它。关键帧间隔长的源会自动生成全帧内代理（硬件编码一次并缓存），每次定位只解码一帧。`Math.random` 使用固定种子，渲染结果可复现。

依赖 `requestAnimationFrame` 循环、CSS transition 或真实时钟的页面无法 seek。

## 采集原理

- **Canvas 页面**：`<canvas>` 本身就是画面。
- **DOM 页面**：被采集的元素移进 `<canvas layoutsubtree>`，用 `drawElementImage` 绘制。画布后备尺寸等于输出尺寸，`--scale 2` 会把 1080p 布局按 4K 重新光栅化。
- **自校验**：编码前，把每个区间（按片段边界切分，最长 2 秒）的首帧和中间帧分别用 drawElement 和原生截图渲染并比对；低于 `--verify-threshold`（30 dB）的区间改用截图采集，仍走同一个编码器。
- **静帧复用**：画面没有任何可见变化的帧复用上一帧绘制，开启与关闭的输出逐字节一致。
- **多页面并行**：需要 Node 逐帧驱动的帧（HyperFrames 视频帧、截图区间）受往返延迟限制而不是 GPU。较长的这类帧段会切成几段连续区间，每段由独立页面和编码器渲染；每段先编码一帧丢弃的预热帧，再以关键帧开头，最后按顺序拼接后封装。校验采样也分摊到各个页面。
- **输出**：WebCodecs 硬件编码，直接封装为 MP4 并写入 BT.709 标记；先写临时文件，用 ffprobe 校验帧数、尺寸、音轨后再重命名，失败不留半成品。

实现细节，以及实测后放弃的方案：[docs/architecture.md](docs/architecture.md)。

## 命令行

```
framevelo render <input> [options]
framevelo doctor
framevelo browser install [version] | framevelo browser path
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `-o, --output <file>` | `<输入名>.mp4` | 输出 MP4 |
| `--fps <n>` | 页面帧率，否则 30 | 帧率；支持整数和 NTSC 帧率（29.97、59.94） |
| `--duration <s>`、`--frames <n>` | 页面时长 | 渲染长度 |
| `--start <s>` | 0 | 起始时间；音轨同步偏移 |
| `--width`、`--height <px>`、`--scale <n>` | 采集尺寸 | 输出尺寸 |
| `--viewport <WxH>` | 取自页面，否则 1920x1080 | CSS 视口 |
| `--mode <m>` | `auto` | `auto`、`canvas` 或 `dom` |
| `--selector <css>` | | 要采集的元素或 canvas |
| `--capture <c>` | `auto` | DOM 页面：`auto`（校验并按区间回退）、`dom`、`screenshot` |
| `--verify-threshold <dB>` | 30 | 区间改用截图的校验阈值 |
| `--codec <c>` | `h264` | `h264` 或 `hevc` |
| `--quality <q>` | `standard` | `draft`、`standard`（约等于 x264 CRF 18）、`high` |
| `--bitrate <b>` | 由尺寸、帧率和画质推算 | 目标码率，例如 `12M` |
| `--audio <file>` | 合成自带音轨 | 音轨（AAC） |
| `--subframes <n>`、`--shutter <f>` | 1、0.5 | 在 GPU 上平均子帧实现运动模糊 |
| `--background <css>` | 页面背景 | DOM 透明区域后面的颜色 |
| `--mount <prefix>=<dir>` | | 额外提供一个目录，例如 `/@skill/=./skill` |
| `--no-hyperframes` | | 把 HyperFrames 项目当普通页面渲染 |
| `--no-paint-reuse` | | 每帧都重新绘制 |
| `--no-video-proxy` | | 不生成视频代理，直接定位源文件 |
| `--workers <n>` | 按 CPU 核数（11 核 M3 Pro 为 3） | Node 驱动帧最多使用的页面数；每 200 帧一个页面；`1` 关闭 |
| `--chrome <path>` | 先 headless shell，再 Chrome | 浏览器可执行文件 |
| `--json`、`-q, --quiet` | | 以 JSON 输出结果（分阶段耗时、路线规划、页面统计）；不显示进度 |

## API

```js
import { render } from "framevelo";

const result = await render({ input: "examples/dom-cards", output: "dom-cards.mp4", scale: 2 });
console.log(result.wallMs, result.stages, result.plan);
```

## 已知限制

- `drawElementImage` 是 Origin Trial API（到 Chrome 160），并在 Chrome 155 改过形态；自校验能挡住回归，但升级 Chrome 后建议用 `scripts/parity.ts` 复核。
- HyperFrames 的视频帧走官方抽帧和注入器，所以视频为主的项目提速不如动效为主的项目明显：每出现一个新视频帧，要多付一次渲染更新的代价；多页面并行可以把这些等待重叠起来，代价是占用更多内存。
- 未实现图层光栅缓存：`drawElementImage` 无法把缓存图层与其余内容按层叠顺序交错合成。
- 硬件视频编码器只有一个，和其他应用共享；同时运行录屏或视频会议会让编码变慢。
- 硬件编码器需要约 x264 CRF 18 的 1.2 倍码率才能达到相同画质。

## 开发

```bash
npm install
npm test
npm run test:integration
node scripts/parity.ts path/to/hyperframes-project
```

`npm test` 运行单元测试；`npm run test:integration` 通过 Chrome 和 FFmpeg 渲染示例；`scripts/parity.ts` 在同一台机器上对比 FrameVelo 与 `hyperframes render`。源码直接运行在 Node 的 TypeScript 类型剥离上；`npm run build` 生成 `dist/`。调研与基准：[docs/research-render-acceleration.md](docs/research-render-acceleration.md)、[research/bench](research/bench)。

## 许可证

[Apache-2.0](LICENSE)。部分代码移植自 HyperFrames，见 [NOTICE](NOTICE)。
