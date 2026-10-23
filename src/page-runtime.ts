// Code that runs inside the page. Puppeteer serializes these functions with Function#toString, so
// each one must be self-contained: no imports, no references to module-level values, and only
// erasable TypeScript syntax.

export type CaptureMode = "auto" | "canvas" | "dom";

export interface PagePrepareOptions {
  mode: CaptureMode;
  selector?: string;
  readyTimeoutMs: number;
}

export interface PagePrepareResult {
  driver: "framevelo" | "seek" | "gsap";
  mode: "canvas" | "dom";
  /** Layout size of the captured element in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Backing size of the captured canvas (canvas mode). */
  canvasWidth?: number;
  canvasHeight?: number;
  duration?: number;
  fps?: number;
  chromeHasDrawElement: boolean;
}

export interface PageRenderOptions {
  width: number;
  height: number;
  fps: number;
  startFrame: number;
  frames: number;
  codec: string;
  bitrate: number;
  keyframeInterval: number;
  /** Seconds relative to each frame time; more than one entry averages sub-frames (motion blur). */
  subframeOffsets: number[];
  hardwareAcceleration: "prefer-hardware" | "no-preference" | "prefer-software";
  maxEncodeQueue: number;
  chunkBytes: number;
  paintTimeoutMs: number;
  background?: string;
}

export interface PageRenderStats {
  frames: number;
  encoderConfig: { codec: string; hardwareAcceleration: string };
  hardwareFallback: boolean;
  seekMs: number;
  paintMs: number;
  encodeWaitMs: number;
  transferWaitMs: number;
}

/**
 * Find how the page is driven through time and what to capture, then (DOM mode) move the captured
 * element into a `<canvas layoutsubtree>` so `drawElementImage` can rasterize it.
 *
 * Time drivers, in order: `window.__framevelo = { seek(t), duration?, fps? }`, `window.__seek(t)`
 * with optional `window.__duration`, or a paused GSAP timeline registered on `window.__timelines`
 * (the HyperFrames convention; `main` or the first key).
 */
export async function pagePrepare(options: PagePrepareOptions): Promise<PagePrepareResult> {
  type Seek = (t: number) => unknown;
  type Timeline = { seek: (t: number, suppressEvents?: boolean) => unknown; duration?: () => number };
  const w = window as unknown as {
    __framevelo?: { seek?: Seek; duration?: number; fps?: number };
    __seek?: Seek;
    __duration?: number;
    __timelines?: Record<string, Timeline | undefined>;
    __fvState?: unknown;
  };

  const findDriver = (): { driver: PagePrepareResult["driver"]; seek: Seek; duration?: number; fps?: number } | null => {
    const fv = w.__framevelo;
    if (fv && typeof fv.seek === "function") {
      const seek = fv.seek.bind(fv);
      return { driver: "framevelo", seek, duration: fv.duration, fps: fv.fps };
    }
    if (typeof w.__seek === "function") return { driver: "seek", seek: w.__seek, duration: w.__duration };
    const timelines = w.__timelines;
    if (timelines) {
      const keys = Object.keys(timelines);
      const tl = timelines.main ?? (keys[0] !== undefined ? timelines[keys[0]] : undefined);
      if (tl && typeof tl.seek === "function") {
        // seek() returns the timeline, which is a thenable that settles on completion: never return it.
        const seek = (t: number) => {
          tl.seek(t, false);
        };
        return { driver: "gsap", seek, duration: typeof tl.duration === "function" ? tl.duration() : undefined };
      }
    }
    return null;
  };

  // Timelines are often registered after fonts load; wait for one to appear.
  const deadline = performance.now() + options.readyTimeoutMs;
  let found = findDriver();
  while (!found && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    found = findDriver();
  }
  if (!found) {
    throw new Error(
      "The page exposes no way to seek time. Define window.__framevelo = { seek(t), duration }, " +
        "window.__seek(t), or register a paused GSAP timeline on window.__timelines.main.",
    );
  }

  await document.fonts.ready;
  await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));

  // HyperFrames: the root's data-duration is the render length, whatever the timeline length.
  const compositionRoot = document.querySelector<HTMLElement>("[data-composition-id]");
  const attrNumber = (el: Element | null, name: string): number | undefined => {
    const raw = el?.getAttribute(name);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const duration = attrNumber(compositionRoot, "data-duration") ?? (found.duration && found.duration > 0 ? found.duration : undefined);
  const fps = found.fps ?? attrNumber(compositionRoot, "data-fps");

  let target: Element | null = null;
  if (options.selector) {
    target = document.querySelector(options.selector);
    if (!target) throw new Error(`No element matches selector ${options.selector}`);
  }
  target ??= compositionRoot ?? document.getElementById("root");
  if (!target) {
    const canvases = document.querySelectorAll("canvas");
    if (canvases.length === 1) target = canvases[0]!;
  }
  if (!target) {
    target = Array.from(document.body.children).find((el) => !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(el.tagName)) ?? null;
  }
  if (!target) throw new Error("Nothing to capture: the page body has no visible element.");

  let mode: "canvas" | "dom";
  if (options.mode === "canvas") {
    if (!(target instanceof HTMLCanvasElement)) {
      const inner = target.querySelectorAll("canvas");
      if (inner.length !== 1) throw new Error("Canvas mode needs a <canvas> target; pass --selector to pick one.");
      target = inner[0]!;
    }
    mode = "canvas";
  } else if (options.mode === "dom") {
    mode = "dom";
  } else {
    mode = target instanceof HTMLCanvasElement ? "canvas" : "dom";
  }

  const rect = target.getBoundingClientRect();
  const cssWidth = Math.round(attrNumber(target, "data-width") ?? rect.width);
  const cssHeight = Math.round(attrNumber(target, "data-height") ?? rect.height);
  if (!(cssWidth > 0 && cssHeight > 0)) throw new Error(`The captured element has no size (${cssWidth}x${cssHeight}).`);

  const probeCtx = document.createElement("canvas").getContext("2d") as (CanvasRenderingContext2D & { drawElementImage?: unknown }) | null;
  const chromeHasDrawElement = typeof probeCtx?.drawElementImage === "function";

  let capture: HTMLCanvasElement | undefined;
  if (mode === "dom") {
    if (!chromeHasDrawElement) {
      throw new Error("DOM capture needs canvas.drawElementImage (Chrome 151 or later with the CanvasDrawElement feature).");
    }
    capture = document.createElement("canvas");
    capture.setAttribute("layoutsubtree", "");
    // Positioned so absolutely positioned children keep the composition as containing block.
    capture.style.cssText = `display:block;position:relative;width:${cssWidth}px;height:${cssHeight}px;margin:0;padding:0;border:0;`;
    target.parentNode!.insertBefore(capture, target);
    capture.appendChild(target);
  }

  // What a screenshot would show behind transparent content.
  const backgroundOf = (el: Element | null): string | null => {
    if (!el) return null;
    const color = getComputedStyle(el).backgroundColor;
    return color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color) ? color : null;
  };
  const background = backgroundOf(document.body) ?? backgroundOf(document.documentElement) ?? "#ffffff";

  w.__fvState = { seek: found.seek, mode, target, capture, background };
  return {
    driver: found.driver,
    mode,
    cssWidth,
    cssHeight,
    ...(target instanceof HTMLCanvasElement ? { canvasWidth: target.width, canvasHeight: target.height } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(fps !== undefined ? { fps } : {}),
    chromeHasDrawElement,
  };
}

/**
 * Render frames [startFrame, startFrame + frames) and stream the encoded Annex-B bytes to Node
 * through the `__fvChunk(base64)` binding. Frames never leave the GPU process as pixels.
 */
export async function pageRender(o: PageRenderOptions): Promise<PageRenderStats> {
  type DrawElementContext = CanvasRenderingContext2D & { drawElementImage(element: Element, x: number, y: number): void };
  const w = window as unknown as {
    __fvState?: { seek: (t: number) => unknown; mode: "canvas" | "dom"; target: Element; capture?: HTMLCanvasElement; background: string };
    __fvChunk(base64: string): Promise<void>;
    __fvProgress(done: number): void;
  };
  const state = w.__fvState;
  if (!state) throw new Error("pagePrepare must run before pageRender.");

  const stats = { seekMs: 0, paintMs: 0, encodeWaitMs: 0, transferWaitMs: 0 };
  const background = o.background ?? state.background;
  // Await only real promises: animation libraries return chainable objects with a then() that
  // resolves when playback completes, which never happens for a paused timeline.
  const seekTo = async (t: number): Promise<void> => {
    const result = state.seek(t);
    if (result instanceof Promise) await result;
  };

  // ---- frame source ----
  let source: HTMLCanvasElement;
  let paint: (t: number) => Promise<void>;
  if (state.mode === "dom") {
    const capture = state.capture!;
    // drawElementImage maps CSS pixels onto the backing store, so a larger backing store
    // re-rasterizes the DOM at that resolution (crisp 4K from a 1080p layout).
    capture.width = o.width;
    capture.height = o.height;
    const ctx = capture.getContext("2d") as DrawElementContext;
    paint = (t) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No paint event within ${o.paintTimeoutMs} ms at t=${t}s.`)), o.paintTimeoutMs);
        (capture as HTMLCanvasElement & { onpaint: (() => void) | null }).onpaint = () => {
          clearTimeout(timer);
          try {
            const p0 = performance.now();
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, o.width, o.height);
            ctx.drawElementImage(state.target, 0, 0);
            stats.paintMs += performance.now() - p0;
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        const s0 = performance.now();
        seekTo(t).then(() => {
          stats.seekMs += performance.now() - s0;
          (capture as HTMLCanvasElement & { requestPaint(): void }).requestPaint();
        }, reject);
      });
    source = capture;
  } else {
    source = state.target as HTMLCanvasElement;
    paint = async (t) => {
      const s0 = performance.now();
      await seekTo(t);
      stats.seekMs += performance.now() - s0;
    };
  }

  // Averaging sub-frames, or scaling a canvas to another output size, needs an output canvas.
  const subframes = o.subframeOffsets.length;
  const needsOutputCanvas = subframes > 1 || (state.mode === "canvas" && (source.width !== o.width || source.height !== o.height));
  const output = needsOutputCanvas ? new OffscreenCanvas(o.width, o.height) : null;
  const octx = output ? output.getContext("2d")! : null;

  // ---- encoder ----
  let encoderError: unknown = null;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let inFlight = 0;
  let chain: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (pending.length === 0) return chain;
    const blob = new Blob(pending as BlobPart[]);
    pending = [];
    pendingBytes = 0;
    inFlight++;
    chain = chain
      .then(
        () =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((url) => w.__fvChunk(url.slice(url.indexOf(",") + 1)))
      .finally(() => {
        inFlight--;
      });
    return chain;
  };

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      if (pendingBytes >= o.chunkBytes) void flush().catch((error) => (encoderError ??= error));
    },
    error: (error) => {
      encoderError ??= error;
    },
  });

  const baseConfig: VideoEncoderConfig = {
    codec: o.codec,
    width: o.width,
    height: o.height,
    bitrate: o.bitrate,
    bitrateMode: "variable",
    framerate: o.fps,
    latencyMode: "quality",
    hardwareAcceleration: o.hardwareAcceleration,
  };
  // Annex-B keeps SPS/PPS in-band so the stream can be piped straight into FFmpeg.
  const config = { ...baseConfig, avc: { format: "annexb" }, hevc: { format: "annexb" } } as VideoEncoderConfig;
  let hardwareFallback = false;
  let support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported && o.hardwareAcceleration === "prefer-hardware") {
    config.hardwareAcceleration = "no-preference";
    support = await VideoEncoder.isConfigSupported(config);
    hardwareFallback = support.supported === true;
  }
  if (!support.supported) throw new Error(`This Chrome cannot encode ${o.codec} at ${o.width}x${o.height}.`);
  encoder.configure(config);

  const frameDuration = 1e6 / o.fps;
  try {
    for (let i = 0; i < o.frames; i++) {
      if (encoderError) throw encoderError;
      const frameIndex = o.startFrame + i;
      const t = frameIndex / o.fps;

      if (octx && output) {
        for (let k = 0; k < subframes; k++) {
          await paint(Math.max(0, t + o.subframeOffsets[k]!));
          // Running mean: after k+1 samples, blend the new one at 1/(k+1).
          octx.globalAlpha = 1 / (k + 1);
          octx.drawImage(source, 0, 0, o.width, o.height);
        }
        octx.globalAlpha = 1;
      } else {
        await paint(t);
      }

      const frame = new VideoFrame((output ?? source) as CanvasImageSource, {
        timestamp: Math.round(frameIndex * frameDuration),
        duration: Math.round(frameDuration),
      });
      encoder.encode(frame, { keyFrame: i % o.keyframeInterval === 0 });
      frame.close();

      const e0 = performance.now();
      while (encoder.encodeQueueSize > o.maxEncodeQueue) {
        await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
      }
      stats.encodeWaitMs += performance.now() - e0;

      // Bound the bytes waiting for Node so a slow muxer cannot grow page memory.
      if (inFlight > 4) {
        const c0 = performance.now();
        await chain;
        stats.transferWaitMs += performance.now() - c0;
      }
      if ((i + 1) % 5 === 0 || i + 1 === o.frames) w.__fvProgress(i + 1);
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    await flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }

  return {
    frames: o.frames,
    encoderConfig: { codec: o.codec, hardwareAcceleration: config.hardwareAcceleration ?? "no-preference" },
    hardwareFallback,
    seekMs: Math.round(stats.seekMs),
    paintMs: Math.round(stats.paintMs),
    encodeWaitMs: Math.round(stats.encodeWaitMs),
    transferWaitMs: Math.round(stats.transferWaitMs),
  };
}
