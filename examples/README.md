# Examples

| Example | Shows |
|---|---|
| [canvas-particles](canvas-particles) | Canvas 2D scene as a pure function of time (`window.__framevelo`) |
| [dom-cards](dom-cards) | DOM composition captured with `drawElementImage` |
| [gsap-timeline](gsap-timeline) | Paused GSAP timeline on `window.__timelines.main` (renders as a plain page with `--no-hyperframes`) |
| [video-page](video-page) | `<video data-start>` kept frame-exact on the composition clock |
| [hyperframes-project](hyperframes-project) | HyperFrames project: sub-compositions, an image, a video and an audio bed, through the official pipeline |

```bash
framevelo render examples/dom-cards -o out/dom-cards.mp4
```

```bash
framevelo render examples/hyperframes-project -o out/hyperframes.mp4 --scale 2
```
