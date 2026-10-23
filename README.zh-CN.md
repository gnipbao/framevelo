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

## 实测结果

Apple M3 Pro（11 核，18 GB），macOS 27，chrome-headless-shell 154，FFmpeg 7.0.2，HyperFrames 0.8.186。耗时、CPU 时间和峰值内存统计整个进程树（每 200 ms 采样）；画质为与参考渲染逐帧比较的 PSNR。

**GSAP 合成，10 秒**（[research/bench/hfproj](research/bench/hfproj)）

| 渲染器 | 耗时 | CPU | 峰值内存 | 与官方的 PSNR |
|---|---:|---:|---:|---:|
| `hyperframes render`，1080p | 17.4 s | 64.2 s | 2385 MB | |
| `hyperframes render --gpu`，1080p | 15.4 s | 30.6 s | 2035 MB | |
| **FrameVelo，1080p** | **7.8 s** | **7.8 s** | **797 MB** | 45.6 dB |
| `hyperframes render`，4K | 34.7 s | 210.5 s | 3360 MB | |
| `hyperframes render --gpu`，4K | 32.8 s | 91.2 s | 2489 MB | |
| **FrameVelo，4K** | **9.3 s** | **11.5 s** | **903 MB** | 48.7 dB |

FrameVelo 的文件更大（1080p 为 15.5 MB 对 14.3 MB，4K 为 56 MB 对 37 MB）：同等画质下硬件编码器比 x264 需要更高码率。

**HyperFrames 回归用例**：官方 `packages/producer/tests` 中的 24 个项目全部能渲染，其中 23 个与 `hyperframes render` 的 PSNR 在 40 dB 以上（一个页面内着色器转场用例平均 37.5 dB）。合计耗时从 366 秒降到 219 秒（快 1.7 倍），CPU 从 589 秒降到 265 秒（省 2.2 倍），平均峰值内存从 1858 MB 降到 926 MB（少 50%）。动效类项目提升最大，2.5–6 倍；视频为主的项目因为帧来自官方抽帧和注入器，提升较小，`pip-video-late-host` 慢 5%。

<details>
<summary>逐个用例</summary>

| 用例 | 帧数 | PSNR 平均 / 最低 | 耗时 HF → FV | CPU HF → FV | 峰值内存 HF → FV |
|---|---:|---:|---:|---:|---:|
| nested-subcomp-depth-3 | 60 | 49.7 / 49.3 dB | 13.0 → 3.3 s | 6.3 → 1.9 s | 1306 → 688 MB |
| css-spinner-render-compat | 150 | 55.7 / 54.9 dB | 11.1 → 2.1 s | 11.0 → 2.2 s | 1810 → 686 MB |
| raf-ball-render-compat | 150 | 62 / 60 dB | 7.3 → 1.9 s | 10.5 → 2.3 s | 1635 → 677 MB |
| gsap-letters-render-compat | 120 | 66.2 / 57.6 dB | 11.2 → 2.5 s | 13.0 → 2.0 s | 2335 → 704 MB |
| many-cuts | 168 | 60.4 / 51.4 dB | 16.9 → 8.6 s | 18.1 → 6.3 s | 2240 → 805 MB |
| speed-ramp | 120 | 47.6 / 45.8 dB | 8.1 → 4.5 s | 7.3 → 4.8 s | 1737 → 677 MB |
| animejs-adapter | 180 | 49.7 / 39.5 dB | 9.4 → 3.2 s | 12.4 → 2.1 s | 1900 → 711 MB |
| html-dir-rtl | 60 | 48.5 / 46.4 dB | 6.3 → 2.0 s | 2.7 → 1.5 s | 731 → 667 MB |
| transparency-regression | 30 | 55.1 / 54.9 dB | 5.8 → 0.9 s | 1.8 → 1.3 s | 675 → 609 MB |
| style-1-prod | 510 | 50.7 / 48.1 dB | 28.9 → 22.3 s | 57.5 → 43.2 s | 2577 → 1931 MB |
| style-5-prod | 572 | 50.8 / 46.9 dB | 33.9 → 19.1 s | 72.0 → 18.3 s | 2646 → 1628 MB |
| sub-composition-video | 390 | 49.3 / 48.4 dB | 29.6 → 21.3 s | 75.4 → 19.9 s | 2692 → 1564 MB |
| typegpu-adapter | 180 | 52.9 / 51.1 dB | 9.3 → 5.5 s | 17.7 → 2.8 s | 2259 → 731 MB |
| webgl-video-texture-render-compat | 60 | 45.8 / 42.3 dB | 50.9 → 48.4 s | 7.0 → 4.2 s | 1203 → 672 MB |
| iframe-render-compat | 150 | 61.4 / 56.1 dB | 6.1 → 1.7 s | 11.7 → 1.6 s | 1903 → 617 MB |
| pip-video-late-host | 180 | 51.7 / 47.7 dB | 15.0 → 15.8 s | 27.7 → 5.9 s | 1943 → 1160 MB |
| variables-prod | 90 | 62.2 / 53.1 dB | 8.3 → 2.7 s | 7.3 → 2.0 s | 1553 → 724 MB |
| hf2550-video-subcomposition-ghost | 1516 | 50.3 / 46 dB | 37.2 → 26.3 s | 145.7 → 118.1 s | 2885 → 2176 MB |
| nested-sequential-video-local-start | 60 | 100 / 100 dB | 6.4 → 2.7 s | 3.2 → 4.2 s | 714 → 632 MB |
| timed-descendant-visibility | 270 | 53.6 / 41.7 dB | 7.7 → 1.7 s | 5.9 → 1.8 s | 1652 → 647 MB |
| vignelli-stacking | 308 | 52.3 / 48.5 dB | 17.1 → 12.6 s | 41.7 → 9.7 s | 2383 → 1268 MB |
| page-side-shader-compositor-render-compat | 60 | 37.5 / 27.2 dB | 8.4 → 4.0 s | 5.2 → 4.1 s | 1184 → 792 MB |
| gsap-call-render-seek | 180 | 53.1 / 49.3 dB | 7.7 → 3.0 s | 14.3 → 2.2 s | 2237 → 717 MB |
| sub-comp-t0 | 180 | 58.4 / 47.6 dB | 10.9 → 2.7 s | 13.5 → 2.2 s | 2398 → 735 MB |

</details>

**code-video**（build-a-world，20–30 秒，3 个子帧）：skill 自带的 `render.mjs` 用时 46.8 秒、CPU 115 秒、内存 3157 MB；FrameVelo 用时 48.3 秒、CPU 12.3 秒、内存 1006 MB（41.5 dB）。这个 three.js 场景本身就占满了 GPU，所以 FrameVelo 省下的是 CPU 和内存，而不是时间。

复现：`node scripts/parity.ts <项目>` 和 `research/bench/measure.mjs`。

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

## 接入 AI Agent

FrameVelo 自带 MCP 服务 `framevelo mcp`，提供三个工具：`render`、`doctor` 和 `install_browser`。另附一个 [skill](plugin/skills/framevelo/SKILL.md)，教 Agent 完整流程：先预览一小段、再完整渲染、检查结果，以及每类错误怎么处理。

**Claude Code**：装插件即可同时得到 MCP 工具和 skill。

```
/plugin marketplace add gnipbao/framevelo
/plugin install framevelo@framevelo
```

**其他 MCP 客户端**（Codex、Cursor、Claude Desktop 等）：先安装一次，再注册 `framevelo mcp`。

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8.186 @hyperframes/engine@0.8.186
```

```json
{ "mcpServers": { "framevelo": { "command": "framevelo", "args": ["mcp"] } } }
```

Codex 写在 `~/.codex/config.toml`：

```toml
[mcp_servers.framevelo]
command = "framevelo"
args = ["mcp"]
```

不想安装也可以用 npx：`"command": "npx"`，`"args": ["-y", "-p", "github:gnipbao/framevelo", "-p", "@hyperframes/producer@0.8.186", "-p", "@hyperframes/engine@0.8.186", "framevelo", "mcp"]`，并设置环境变量 `PUPPETEER_SKIP_DOWNLOAD=true`。首次启动约半分钟，可能超过客户端的启动超时。

`render` 接收与命令行相同的参数，写成 JSON（`input`、`output`、`frames`、`start`、`quality`、`scale`、`codec` 等）。它返回 `output`、`frames`、`fps`、`width`、`height`、`bytes`、`audio`、`wallMs`、`stages`、`warnings` 和最后几行日志。渲染过程中会发送进度通知，也可以取消。失败会以可读的工具错误返回，渲染任务一次只跑一个。

**只能用 shell 的 Agent**：`framevelo render <input> -o out.mp4 --json -q` 在 stdout 输出 JSON 结果；失败时输出 `{"error": "..."}` 并以 1 退出。

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
framevelo mcp
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

`onProgress(done, total)` 报告帧进度；传入 `signal`（`AbortSignal`）可以中止渲染，不留下文件。

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
