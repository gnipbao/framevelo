---
name: framevelo
description: Render code-driven videos to MP4 fast with FrameVelo, on the GPU and the hardware encoder - HyperFrames projects, code-video compositions (defineComposition), and any HTML/CSS/GSAP or Canvas/WebGL page that is a pure function of time. Use when the user wants such a page or project rendered, exported or previewed as a video (渲染视频、导出 MP4、出片、预览一段), wants a render to be faster or lighter on CPU and memory (加速渲染), or wants an HTML animation made renderable frame by frame. Not for editing existing video files or generating video with AI models.
---

# FrameVelo

FrameVelo turns a page that draws its frames from code into an MP4. Frames stay on the GPU (`drawElementImage` or the page's canvas) and go straight to the hardware encoder, so a render takes a fraction of the CPU and memory of screenshot-based renderers. HyperFrames projects are compiled by the official HyperFrames pipeline; FrameVelo replaces only capture and encoding.

## Calling it

Use the MCP tools of this plugin when they are available:

- `render`: renders; returns the output path, frame count, size, timings, warnings and the last log lines.
- `doctor`: checks Node, FFmpeg, Chrome, `drawElementImage`, the hardware encoders and HyperFrames support.
- `install_browser`: downloads chrome-headless-shell (about 100 MB) when no Chrome 151+ is installed.

Without the tools, run the CLI. `--json` prints the result (or `{"error": ...}`) on stdout:

```bash
npx -y -p github:gnipbao/framevelo -p @hyperframes/producer@0.8.186 -p @hyperframes/engine@0.8.186 framevelo render /abs/project -o /abs/out.mp4 --json -q
```

The first `npx` run installs for about half a minute. If you will render often, suggest that the user install it once: `npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8.186 @hyperframes/engine@0.8.186`. The CLI takes the same options as the tool, as flags (`--frames 30 --quality draft`). `framevelo render --help` lists them.

Use absolute paths. Run one render at a time: they share the single hardware encoder, and the MCP server queues them anyway.

## Workflow

1. **Find the input**: a project directory with `index.html`, or an `.html` file. Duration, fps and size come from the page (HyperFrames `data-duration`/`data-fps`/`data-width`, `window.__framevelo.duration`, the GSAP timeline length, `window.__comp`). Pass them only to override.
2. **Preview a slice** when the composition is new or just changed: `{ input, output: "/tmp/preview.mp4", start: 2, frames: 30, quality: "draft" }`. This takes seconds. Look at a frame: `ffmpeg -v error -ss 0.5 -i /tmp/preview.mp4 -frames:v 1 /tmp/preview.png`, then view the PNG.
3. **Render in full** with defaults. Add `scale: 2` for 4K from a 1080p layout, or `subframes: 3` for motion blur.
4. **Check the result**: `frames` is the count you expected; `audio` is true when the composition has sound; read `warnings`. `screenshotFrames > 0` means some intervals failed verification and were captured by screenshot (still correct, just slower).
5. **Report** the output path, length, size and how long it took (`wallMs`).

## Making a page renderable

Every frame must be a pure function of time. FrameVelo seeks the page through the first of these it finds:

1. `window.__framevelo = { seek(t), duration, fps }`. `seek` may return a promise.
2. `window.__seek(t)`, with an optional `window.__duration`.
3. A paused GSAP timeline on `window.__timelines.main` (or the first key).

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

- Put footage on the timeline with `<video data-start="1.5" src="clip.mp4">` (optional `data-media-start`, `data-duration`, `data-playback-rate`). FrameVelo seeks it to the exact frame; long-GOP sources get a cached all-intra proxy.
- `Math.random` is seeded, so renders repeat.
- `requestAnimationFrame` loops, CSS transitions, `Date.now()` and `performance.now()` animations cannot be seeked. Move them onto `seek(t)` or a paused GSAP timeline.
- Wait for assets inside the page (fonts, images) before exposing the driver, or return a promise from `seek`.

## Options worth knowing

| Need | Arguments |
|---|---|
| Quick check | `frames: 30`, `quality: "draft"`, `start: <s>` |
| 4K from a 1080p layout | `scale: 2` |
| Vertical page without declared size | `viewport: "1080x1920"` |
| Smaller files | `codec: "hevc"` |
| Motion blur | `subframes: 3` (and `shutter`, default 0.5) |
| Replace the soundtrack | `audio: "/abs/music.m4a"` |
| Capture one element | `selector: "#stage"` |
| Transparent DOM over a color | `background: "#000"` |
| code-video skill not found | `mounts: {"/@skill/": "/abs/path/to/code-video"}` |
| HyperFrames project as a plain page | `hyperframes: false` |

## When it fails

| Message | Do this |
|---|---|
| `Chrome not found` | Call `install_browser` (or run `framevelo browser install`), then render again. |
| `FFmpeg` / `FFprobe` failing in `doctor` | Ask the user to install FFmpeg (`brew install ffmpeg`). Don't install system software yourself. |
| `The page exposes no way to seek time` | The page needs a time driver; see "Making a page renderable". |
| `Unknown duration` | Pass `duration` or `frames`, or declare the duration in the page. |
| `The composition failed to set up` | A script error in the composition. Fix the page; the message carries the page error. |
| `No element matches selector` / `Nothing to capture` / `has no size` | Point `selector` at a visible element with a size, or fix the layout. |
| `Rendering a HyperFrames project needs ... @hyperframes/producer` | Use the `npx -p @hyperframes/...` command above, or install the packages next to FrameVelo. |
| `No paint event within ...` | The page stopped painting; usually a hung script. Check it in a browser. |

Renders are atomic: a failed or cancelled render leaves no output file.
