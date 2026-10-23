// Code that runs inside the page. Puppeteer serializes these functions with Function#toString, so
// each one must be self-contained: no imports, no references to module-level values, and only
// erasable TypeScript syntax.

export type CaptureMode = "auto" | "canvas" | "dom";
export type TimeDriver = "framevelo" | "hyperframes" | "seek" | "gsap";

export interface PagePrepareOptions {
  mode: CaptureMode;
  selector?: string;
  readyTimeoutMs: number;
  /** The page is served with the HyperFrames runtime; wait for its `window.__hf` seek protocol. */
  expectHyperFrames?: boolean;
}

export interface PagePrepareResult {
  driver: TimeDriver;
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
  /** DOM mode only: whether drawElementImage capture is set up (otherwise only screenshots work). */
  drawElementReady: boolean;
  /** WebGL/WebGPU canvases composited under the DOM paint (DOM mode). */
  acceleratedCanvases: number;
  warnings: string[];
}

export interface PageEncodeOptions {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
  keyframeInterval: number;
  /** Sub-frames averaged into each output frame (motion blur). */
  subframes: number;
  /** Skip the paint of a frame in which nothing visible can have changed (DOM capture). */
  reusePaints?: boolean;
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
  /** Sub-frames whose paint was skipped because nothing changed since the previous one. */
  reusedPaints: number;
  /** Encoded chunks the encoder returned (one per frame unless it dropped some). */
  chunks: number;
  /** Chunks with no payload (the encoder skipped an unchanged frame). */
  emptyChunks: number;
  /** Why paint reuse is off for this page, when it is. */
  reuseDisabledReason?: string;
}

/** The page-side API installed by `pageInstallRuntime`, reached as `window.__fv`. */
export interface FrameVeloPageApi {
  prepare(options: PagePrepareOptions): Promise<PagePrepareResult>;
  begin(options: PageEncodeOptions): Promise<{ hardwareFallback: boolean }>;
  /**
   * Move the composition to `t`. A quiet seek is administrative (verification, sub-frame samples,
   * repositioning): it must not fire timeline callbacks, so a render's side effects happen once,
   * in frame order.
   */
  seek(t: number, quiet?: boolean): Promise<void>;
  /** Paint the current state as sub-frame `k`; with `encodeFrame`, also encode the finished frame. */
  sample(k: number, encodeFrame?: number): Promise<void>;
  /** Use a native screenshot (base64 JPEG/PNG) as sub-frame `k`; with `encodeFrame`, also encode. */
  sampleScreenshot(base64: string, k: number, encodeFrame?: number): Promise<void>;
  encode(frameIndex: number): Promise<void>;
  /** In-page loop: seek, sample and encode `count` frames starting at `startFrame`. */
  run(startFrame: number, count: number, subframeOffsets: number[]): Promise<void>;
  end(): Promise<PageRenderStats>;
  /**
   * DOM mode: "dom" keeps the captured element inside the capture canvas (drawElementImage);
   * "screenshot" moves it back into the page so the compositor paints it for a native screenshot.
   */
  setRoute(route: "dom" | "screenshot"): void;
  /** Viewport rectangle of the captured element, for a screenshot clip. */
  targetRect(): { x: number; y: number; width: number; height: number };
  /** Composition times (seconds) where clips start or end: natural interval boundaries. */
  boundaries(): number[];
  /** Paint the current state with drawElementImage without encoding (verification). */
  paintOnly(): Promise<void>;
  /** PSNR (dB) between the last drawElementImage paint and a native screenshot, at reduced size. */
  compareScreenshot(base64: string): Promise<number>;
  /** PNG data URL of the last drawElementImage paint (debugging verification). */
  captureDataUrl(): string;
  /**
   * Run a pending HyperFrames page-side shader composite (after video frames are injected, before
   * a screenshot): clone the scenes, paint the clones, run the shader into the overlay canvas.
   */
  composite(): Promise<void>;
}

/**
 * Runs before any page script (evaluateOnNewDocument). Keeps a real clock before a virtual-time
 * shim freezes `performance.now`, and records WebGL/WebGPU canvases: their content reaches the
 * compositor by texture swap, so drawElementImage would see a stale first frame and they must be
 * composited by hand. WebGL contexts get `preserveDrawingBuffer` so they can be read back.
 */
export function pageBootstrap(): void {
  type W = Window & {
    __fvClock?: { now: () => number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    __fvAccelCanvases?: HTMLCanvasElement[];
    __timelines?: Record<string, unknown>;
  };
  const w = window as W;
  if (w.__fvClock) return;
  w.__fvClock = {
    now: performance.now.bind(performance),
    setTimeout: window.setTimeout.bind(window) as typeof setTimeout,
    clearTimeout: window.clearTimeout.bind(window),
  };
  // HyperFrames compositions assign into a registry its runtime normally creates first.
  w.__timelines ??= {};
  const accelerated: HTMLCanvasElement[] = [];
  w.__fvAccelCanvases = accelerated;
  const original = HTMLCanvasElement.prototype.getContext;
  const patched = function (this: HTMLCanvasElement, type: string, attributes?: Record<string, unknown>) {
    const isGl = type === "webgl" || type === "webgl2" || type === "experimental-webgl";
    const context = (original as (this: HTMLCanvasElement, t: string, a?: unknown) => unknown).call(
      this,
      type,
      isGl ? { ...attributes, preserveDrawingBuffer: true } : attributes,
    );
    if (context && (isGl || type === "webgpu") && !accelerated.includes(this)) accelerated.push(this);
    return context;
  };
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = patched;
}

/** Install `window.__fv`. Idempotent per document. */
export function pageInstallRuntime(): void {
  type Seek = (t: number) => unknown;
  type Timeline = { seek: (t: number, suppressEvents?: boolean) => unknown; duration?: () => number };
  type DrawElementContext = CanvasRenderingContext2D & { drawElementImage(element: Element, x: number, y: number): void };
  type W = Window & {
    __fv?: unknown;
    __fvClock?: { now: () => number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    __fvAccelCanvases?: HTMLCanvasElement[];
    __framevelo?: { seek?: Seek; duration?: number; fps?: number };
    __hf?: { seek?: (t: number) => unknown; duration?: number; buildReady?: Record<string, unknown> };
    __hfWaitForSeekCompletion?: () => Promise<void>;
    __hf_page_composite_pending?: boolean;
    __hf_page_composite_prepare?: () => Promise<boolean>;
    __hf_page_composite_resolve?: () => boolean;
    __seek?: Seek;
    __duration?: number;
    __timelines?: Record<string, Timeline | undefined>;
    __fvChunk(base64: string): Promise<void>;
    __fvProgress(done: number): void;
  };
  const w = window as unknown as W;
  if (w.__fv) return;

  const clock = w.__fvClock ?? {
    now: performance.now.bind(performance),
    setTimeout: window.setTimeout.bind(window) as typeof setTimeout,
    clearTimeout: window.clearTimeout.bind(window),
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
  // Await only real promises: animation libraries return chainable objects with a then() that
  // resolves when playback completes, which never happens for a paused timeline.
  const settle = async (value: unknown) => {
    if (value instanceof Promise) await value;
  };

  interface State {
    driver: TimeDriver;
    seek: (t: number, quiet: boolean) => Promise<void>;
    mode: "canvas" | "dom";
    target: Element;
    cssWidth: number;
    cssHeight: number;
    capture?: HTMLCanvasElement;
    sentinel?: HTMLElement;
    accelerated: HTMLCanvasElement[];
    background: string;
    route: "dom" | "screenshot";
    /** Mutations inside the captured element since the last paint. */
    dirty: boolean;
    /** The next paint must not be skipped (route switch, first frame). */
    forcePaint: boolean;
    /** Animation clock signature at the last paint. */
    animationSignature: string;
    reuseBlocker: string | null;
  }
  let state: State | null = null;

  interface Session {
    o: PageEncodeOptions;
    source: HTMLCanvasElement;
    output: OffscreenCanvas | null;
    octx: OffscreenCanvasRenderingContext2D | null;
    /** Decoded screenshot of the current sub-frame (screenshot route). */
    shot: OffscreenCanvas | null;
    /** Canvas the next encode reads when no output canvas accumulates sub-frames. */
    frameSource: HTMLCanvasElement | OffscreenCanvas;
    encoder: VideoEncoder;
    config: VideoEncoderConfig;
    hardwareFallback: boolean;
    encoderError: unknown;
    pending: Uint8Array[];
    pendingBytes: number;
    inFlight: number;
    chain: Promise<void>;
    frames: number;
    stats: { seekMs: number; paintMs: number; encodeWaitMs: number; transferWaitMs: number; reusedPaints: number; chunks: number; emptyChunks: number };
  }
  let session: Session | null = null;

  const attrNumber = (el: Element | null, name: string): number | undefined => {
    const raw = el?.getAttribute(name);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  async function prepare(options: PagePrepareOptions): Promise<PagePrepareResult> {
    const warnings: string[] = [];
    const maxPolls = Math.max(1, Math.ceil(options.readyTimeoutMs / 50));

    type Found = { driver: TimeDriver; seek: (t: number, quiet: boolean) => Promise<void>; duration?: number; fps?: number };
    const findDriver = (): Found | null => {
      const fv = w.__framevelo;
      if (fv && typeof fv.seek === "function") {
        const seek = fv.seek.bind(fv);
        return { driver: "framevelo", seek: (t) => settle(seek(t)), duration: fv.duration, fps: fv.fps };
      }
      const hf = w.__hf;
      if (hf && typeof hf.seek === "function" && Number(hf.duration) > 0) {
        return {
          driver: "hyperframes",
          // Look seek up on every call: libraries such as shader transitions wrap it after load.
          seek: async (t, quiet) => {
            const current = w.__hf!.seek as (t: number, options?: { suppressEvents?: boolean }) => unknown;
            await settle(quiet ? current.call(w.__hf, t, { suppressEvents: true }) : current.call(w.__hf, t));
            await w.__hfWaitForSeekCompletion?.();
          },
          duration: Number(hf.duration),
        };
      }
      if (options.expectHyperFrames) return null;
      if (typeof w.__seek === "function") {
        const seek = w.__seek;
        return { driver: "seek", seek: (t) => settle(seek(t)), duration: w.__duration };
      }
      const timelines = w.__timelines;
      if (timelines) {
        const keys = Object.keys(timelines);
        const tl = timelines.main ?? (keys[0] !== undefined ? timelines[keys[0]] : undefined);
        if (tl && typeof tl.seek === "function") {
          // seek() returns the timeline itself, a thenable: never await it. Its second argument
          // is GSAP's suppressEvents.
          const seek = async (t: number, quiet: boolean) => {
            tl.seek(t, quiet);
          };
          return { driver: "gsap", seek, duration: typeof tl.duration === "function" ? tl.duration() : undefined };
        }
      }
      return null;
    };

    let found = findDriver();
    for (let i = 0; !found && i < maxPolls; i++) {
      await sleep(50);
      found = findDriver();
    }
    if (!found) {
      throw new Error(
        options.expectHyperFrames
          ? "The HyperFrames runtime did not expose window.__hf with a seek function and a duration."
          : "The page exposes no way to seek time. Define window.__framevelo = { seek(t), duration }, " +
              "window.__seek(t), or register a paused GSAP timeline on window.__timelines.main.",
      );
    }

    if (found.driver === "hyperframes") {
      // Scripts may register async build work that must finish before the first frame.
      const registry = w.__hf?.buildReady ?? {};
      const keys = Object.keys(registry);
      if (keys.length) {
        const outcome = await Promise.race([
          Promise.allSettled(keys.map((k) => Promise.resolve(registry[k]))).then(() => "settled"),
          sleep(options.readyTimeoutMs).then(() => "timeout"),
        ]);
        if (outcome === "timeout") warnings.push(`window.__hf.buildReady did not settle: ${keys.join(", ")}`);
      }
      // Every composition host needs its timeline registered (sub-compositions load async).
      const missing = (): string[] =>
        Array.from(document.querySelectorAll("[data-composition-id]"))
          .filter((host) => !host.hasAttribute("data-no-timeline"))
          .map((host) => host.getAttribute("data-composition-id") ?? "")
          .filter((id) => id && !w.__timelines?.[id]);
      for (let i = 0; missing().length && i < maxPolls; i++) await sleep(50);
      const stillMissing = missing();
      if (stillMissing.length) warnings.push(`no timeline registered for composition(s): ${stillMissing.join(", ")}`);
    }

    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));

    // HyperFrames: the root's data-duration is the render length, whatever the timeline length.
    const compositionRoot = document.querySelector<HTMLElement>("[data-composition-id]");
    const duration =
      attrNumber(compositionRoot, "data-duration") ?? (found.duration && found.duration > 0 ? found.duration : undefined);
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
    target ??= Array.from(document.body.children).find((el) => !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(el.tagName)) ?? null;
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
    let sentinel: HTMLElement | undefined;
    const accelerated: HTMLCanvasElement[] = [];
    if (mode === "dom" && !chromeHasDrawElement) {
      warnings.push("this Chrome has no canvas.drawElementImage (Chrome 151+); every frame uses screenshot capture");
    }
    if (mode === "dom" && chromeHasDrawElement) {
      capture = document.createElement("canvas");
      capture.id = "__fv_capture";
      capture.setAttribute("layoutsubtree", "");
      // Positioned so absolutely positioned children keep the composition as containing block.
      capture.style.cssText = `display:block;position:relative;width:${cssWidth}px;height:${cssHeight}px;margin:0;padding:0;border:0;`;
      target.parentNode!.insertBefore(capture, target);
      capture.appendChild(target);
      // A paint-level change outside the captured element guarantees a paint event, and a fresh
      // snapshot, even when nothing in the composition changed since the last frame.
      sentinel = document.createElement("div");
      sentinel.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;background:#000";
      capture.appendChild(sentinel);
      for (const canvas of w.__fvAccelCanvases ?? []) {
        if (target.contains(canvas)) {
          accelerated.push(canvas);
          // A transparent hole in the DOM paint; the live content is drawn underneath each frame.
          canvas.style.visibility = "hidden";
        }
      }
    }

    // What a screenshot would show behind transparent content.
    const backgroundOf = (el: Element | null): string | null => {
      if (!el) return null;
      const color = getComputedStyle(el).backgroundColor;
      return color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color) ? color : null;
    };
    const background = backgroundOf(document.body) ?? backgroundOf(document.documentElement) ?? "#ffffff";

    state = {
      driver: found.driver,
      seek: found.seek,
      mode,
      target,
      cssWidth,
      cssHeight,
      ...(capture ? { capture } : {}),
      ...(sentinel ? { sentinel } : {}),
      accelerated,
      background,
      route: mode === "dom" && !capture ? "screenshot" : "dom",
      dirty: true,
      forcePaint: true,
      animationSignature: "",
      reuseBlocker: null,
    };
    const st = state;
    // Content that changes without DOM mutations makes paint reuse unsafe.
    const blocker = target.querySelector("canvas, iframe, object, embed, animate, animateTransform, animateMotion, set")
      ? "canvas, iframe or SMIL content"
      : null;
    st.reuseBlocker = blocker;
    if (!blocker) {
      new MutationObserver(() => {
        st.dirty = true;
      }).observe(target, { subtree: true, attributes: true, childList: true, characterData: true });
    }
    return {
      driver: found.driver,
      mode,
      cssWidth,
      cssHeight,
      drawElementReady: Boolean(capture),
      ...(target instanceof HTMLCanvasElement ? { canvasWidth: target.width, canvasHeight: target.height } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(fps !== undefined ? { fps } : {}),
      chromeHasDrawElement,
      acceleratedCanvases: accelerated.length,
      warnings,
    };
  }

  function drawDom(s: Session, st: State): void {
    const { o } = s;
    const capture = st.capture!;
    const ctx = capture.getContext("2d") as DrawElementContext;
    const sx = o.width / st.cssWidth;
    const sy = o.height / st.cssHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = o.background ?? st.background;
    ctx.fillRect(0, 0, o.width, o.height);
    const rootRect = st.target.getBoundingClientRect();
    const drawAccelerated = (over: boolean) => {
      for (const canvas of st.accelerated) {
        if (canvas.hasAttribute("data-hf-3d") !== over) continue;
        const r = canvas.getBoundingClientRect();
        try {
          ctx.drawImage(canvas, (r.left - rootRect.left) * sx, (r.top - rootRect.top) * sy, r.width * sx, r.height * sy);
        } catch {
          // A zero-sized or unconfigured canvas has nothing to show yet.
        }
      }
    };
    drawAccelerated(false);
    // The snapshot never includes the captured element's own transform; apply it about its origin.
    // drawElementImage scales CSS pixels to the backing store itself, so work in CSS units.
    const style = getComputedStyle(st.target);
    if (style.transform && style.transform !== "none") {
      const m = new DOMMatrix(style.transform);
      const [ox = "0", oy = "0"] = style.transformOrigin.split(" ");
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.translate(parseFloat(ox) || 0, parseFloat(oy) || 0);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.translate(-(parseFloat(ox) || 0), -(parseFloat(oy) || 0));
      ctx.scale(1 / sx, 1 / sy);
    }
    ctx.drawElementImage(st.target, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawAccelerated(true);
    // A HyperFrames shader transition renders the whole frame into a fixed overlay above the page.
    const overlay = shaderOverlay();
    if (overlay) ctx.drawImage(overlay, 0, 0, o.width, o.height);
  }

  const OVERLAY_ID = "__hf-page-side-compositor";
  /** The HyperFrames page-side shader overlay, when it is showing a transition frame. */
  function shaderOverlay(): HTMLCanvasElement | null {
    const overlay = document.getElementById(OVERLAY_ID);
    return overlay instanceof HTMLCanvasElement && overlay.style.display !== "none" ? overlay : null;
  }

  async function composite(): Promise<void> {
    if (!w.__hf_page_composite_pending) return;
    if (!(await w.__hf_page_composite_prepare?.())) return;
    // The shader reads the staged scene clones with drawElementImage: paint them first.
    const staging = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[layoutsubtree]")).filter(
      (canvas) => canvas !== state?.capture && canvas.id !== OVERLAY_ID,
    );
    await Promise.all(
      staging.map(
        (canvas) =>
          new Promise<void>((resolve) => {
            const timer = clock.setTimeout(resolve, 2000);
            canvas.addEventListener(
              "paint",
              () => {
                clock.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            (canvas as HTMLCanvasElement & { requestPaint?: () => void }).requestPaint?.();
          }),
      ),
    );
    w.__hf_page_composite_resolve?.();
  }

  /** Clock state of every animation inside the captured element. */
  function animationSignature(st: State): string {
    const parts: string[] = [];
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target && st.target.contains(target)) parts.push(`${animation.playState}:${animation.currentTime}`);
    }
    return parts.join("|");
  }

  async function paint(s: Session, st: State): Promise<void> {
    if (st.mode !== "dom") return;
    await composite();
    // A shader transition changes the picture outside the observed element.
    if (shaderOverlay()) st.forcePaint = true;
    if (s.o.reusePaints && !st.reuseBlocker && !st.forcePaint && !st.dirty) {
      const signature = animationSignature(st);
      // An image still loading will change the picture without another mutation.
      const loading = Array.from(st.target.querySelectorAll("img")).some((img) => !img.complete);
      if (!loading && signature === st.animationSignature) {
        s.stats.reusedPaints++;
        return;
      }
    }
    const capture = st.capture as HTMLCanvasElement & { onpaint: (() => void) | null; requestPaint(): void };
    await new Promise<void>((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new Error(`No paint event within ${s.o.paintTimeoutMs} ms.`)), s.o.paintTimeoutMs);
      capture.onpaint = () => {
        clock.clearTimeout(timer);
        try {
          const p0 = clock.now();
          drawDom(s, st);
          s.stats.paintMs += clock.now() - p0;
          // Mutations made by drawing itself (none expected) must not count for the next frame.
          st.dirty = false;
          st.forcePaint = false;
          st.animationSignature = s.o.reusePaints && !st.reuseBlocker ? animationSignature(st) : "";
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const sentinel = st.sentinel!;
      sentinel.style.backgroundColor = sentinel.style.backgroundColor === "rgb(0, 0, 0)" ? "rgb(1, 1, 1)" : "rgb(0, 0, 0)";
      capture.requestPaint();
    });
  }

  function flush(s: Session): Promise<void> {
    if (s.pending.length === 0) return s.chain;
    const blob = new Blob(s.pending as BlobPart[]);
    s.pending = [];
    s.pendingBytes = 0;
    s.inFlight++;
    s.chain = s.chain
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
        s.inFlight--;
      });
    return s.chain;
  }

  const requireSession = (): { s: Session; st: State } => {
    if (!state) throw new Error("prepare() must run before rendering.");
    if (!session) throw new Error("begin() must run before rendering.");
    return { s: session, st: state };
  };

  async function begin(o: PageEncodeOptions): Promise<{ hardwareFallback: boolean }> {
    if (!state) throw new Error("prepare() must run before begin().");
    const st = state;
    let source: HTMLCanvasElement;
    if (st.mode === "dom" && st.capture) {
      source = st.capture;
      source.width = o.width;
      source.height = o.height;
    } else if (st.mode === "dom") {
      // Screenshot-only DOM capture: frames always come from decoded screenshots.
      source = document.createElement("canvas");
      source.width = o.width;
      source.height = o.height;
    } else {
      source = st.target as HTMLCanvasElement;
    }
    // Averaging sub-frames, or scaling a canvas to another output size, needs an output canvas.
    const needsOutput = o.subframes > 1 || (st.mode === "canvas" && (source.width !== o.width || source.height !== o.height));
    const output = needsOutput ? new OffscreenCanvas(o.width, o.height) : null;

    const s = {
      o,
      source,
      output,
      octx: output ? output.getContext("2d") : null,
      shot: st.mode === "dom" ? new OffscreenCanvas(o.width, o.height) : null,
      frameSource: output ?? source,
      hardwareFallback: false,
      encoderError: null as unknown,
      pending: [] as Uint8Array[],
      pendingBytes: 0,
      inFlight: 0,
      chain: Promise.resolve(),
      frames: 0,
      stats: { seekMs: 0, paintMs: 0, encodeWaitMs: 0, transferWaitMs: 0, reusedPaints: 0, chunks: 0, emptyChunks: 0 },
    } as unknown as Session;

    s.encoder = new VideoEncoder({
      output: (chunk) => {
        s.stats.chunks++;
        if (chunk.byteLength === 0) s.stats.emptyChunks++;
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        s.pending.push(bytes);
        s.pendingBytes += bytes.byteLength;
        if (s.pendingBytes >= o.chunkBytes) void flush(s).catch((error) => (s.encoderError ??= error));
      },
      error: (error) => {
        s.encoderError ??= error;
      },
    });
    // Annex-B keeps SPS/PPS in-band so the stream can be piped straight into FFmpeg.
    const config = {
      codec: o.codec,
      width: o.width,
      height: o.height,
      bitrate: o.bitrate,
      bitrateMode: "variable",
      framerate: o.fps,
      latencyMode: "quality",
      hardwareAcceleration: o.hardwareAcceleration,
      avc: { format: "annexb" },
      hevc: { format: "annexb" },
    } as VideoEncoderConfig;
    let support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported && o.hardwareAcceleration === "prefer-hardware") {
      config.hardwareAcceleration = "no-preference";
      support = await VideoEncoder.isConfigSupported(config);
      s.hardwareFallback = support.supported === true;
    }
    if (!support.supported) throw new Error(`This Chrome cannot encode ${o.codec} at ${o.width}x${o.height}.`);
    s.encoder.configure(config);
    s.config = config;
    session = s;
    return { hardwareFallback: s.hardwareFallback };
  }

  async function seek(t: number, quiet = false): Promise<void> {
    const { s, st } = requireSession();
    const s0 = clock.now();
    await st.seek(Math.max(0, t), quiet);
    s.stats.seekMs += clock.now() - s0;
  }

  async function encode(frameIndex: number): Promise<void> {
    const { s } = requireSession();
    if (s.encoderError) throw s.encoderError;
    const frameDuration = 1e6 / s.o.fps;
    const frame = new VideoFrame((s.output ?? s.frameSource) as CanvasImageSource, {
      timestamp: Math.round(frameIndex * frameDuration),
      duration: Math.round(frameDuration),
    });
    s.encoder.encode(frame, { keyFrame: s.frames % s.o.keyframeInterval === 0 });
    frame.close();
    s.frames++;

    const e0 = clock.now();
    while (s.encoder.encodeQueueSize > s.o.maxEncodeQueue) {
      await new Promise((r) => s.encoder.addEventListener("dequeue", r, { once: true }));
    }
    s.stats.encodeWaitMs += clock.now() - e0;
    // Bound the bytes waiting for Node so a slow muxer cannot grow page memory.
    if (s.inFlight > 4) {
      const c0 = clock.now();
      await s.chain;
      s.stats.transferWaitMs += clock.now() - c0;
    }
    if (s.frames % 5 === 0) w.__fvProgress(s.frames);
  }

  function accumulate(s: Session, from: HTMLCanvasElement | OffscreenCanvas, k: number): void {
    s.frameSource = from;
    if (s.octx) {
      // Running mean: after k+1 samples, blend the new one at 1/(k+1).
      s.octx.globalAlpha = 1 / (k + 1);
      s.octx.drawImage(from, 0, 0, s.o.width, s.o.height);
      s.octx.globalAlpha = 1;
    }
  }

  async function sample(k: number, encodeFrame?: number): Promise<void> {
    const { s, st } = requireSession();
    if (st.mode === "dom" && st.route !== "dom") throw new Error("sample() needs the dom route; use sampleScreenshot().");
    await paint(s, st);
    accumulate(s, s.source, k);
    if (encodeFrame !== undefined) await encode(encodeFrame);
  }

  async function decodeInto(base64: string, canvas: OffscreenCanvas): Promise<void> {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  }

  async function sampleScreenshot(base64: string, k: number, encodeFrame?: number): Promise<void> {
    const { s } = requireSession();
    if (!s.shot) throw new Error("Screenshots are only used for DOM capture.");
    const p0 = clock.now();
    await decodeInto(base64, s.shot);
    s.stats.paintMs += clock.now() - p0;
    accumulate(s, s.shot, k);
    if (encodeFrame !== undefined) await encode(encodeFrame);
  }

  function setRoute(route: "dom" | "screenshot"): void {
    if (!state || state.mode !== "dom") return;
    const st = state;
    if (route === st.route) return;
    if (route === "dom" && !st.capture) throw new Error("drawElementImage capture is not available in this Chrome.");
    const capture = st.capture!;
    if (route === "screenshot") {
      capture.parentNode!.insertBefore(st.target, capture);
      capture.style.display = "none";
      for (const canvas of st.accelerated) canvas.style.visibility = "";
    } else {
      capture.style.display = "block";
      capture.insertBefore(st.target, st.sentinel ?? null);
      for (const canvas of st.accelerated) canvas.style.visibility = "hidden";
    }
    st.route = route;
    // The capture canvas loses its content when the composition leaves it.
    st.forcePaint = true;
  }

  function targetRect(): { x: number; y: number; width: number; height: number } {
    if (!state) throw new Error("prepare() must run first.");
    const r = state.target.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: state.cssWidth, height: state.cssHeight };
  }

  function boundaries(): number[] {
    const times = new Set<number>();
    for (const el of Array.from(document.querySelectorAll("[data-start]"))) {
      const start = Number(el.getAttribute("data-start"));
      const duration = Number(el.getAttribute("data-duration"));
      if (!Number.isFinite(start)) continue;
      // Nested clips count from their composition host; add the host offsets.
      let offset = 0;
      for (let host = el.parentElement?.closest("[data-composition-id][data-start]"); host; host = host.parentElement?.closest("[data-composition-id][data-start]")) {
        offset += Number(host.getAttribute("data-start")) || 0;
      }
      times.add(offset + start);
      if (Number.isFinite(duration) && duration > 0) times.add(offset + start + duration);
    }
    return [...times].filter((t) => t > 0).sort((a, b) => a - b);
  }

  // Copy of the last verification paint: the capture canvas loses its content once the
  // composition moves out of it for a screenshot.
  let verifyCopy: OffscreenCanvas | null = null;

  async function paintOnly(): Promise<void> {
    const { s, st } = requireSession();
    if (st.mode !== "dom" || !st.capture) return;
    setRoute("dom");
    await paint(s, st);
    verifyCopy ??= new OffscreenCanvas(s.o.width, s.o.height);
    const ctx = verifyCopy.getContext("2d")!;
    ctx.clearRect(0, 0, verifyCopy.width, verifyCopy.height);
    ctx.drawImage(st.capture, 0, 0);
  }

  async function compareScreenshot(base64: string): Promise<number> {
    const { s } = requireSession();
    if (!verifyCopy || !s.shot) throw new Error("Nothing to compare: call paintOnly() first.");
    await decodeInto(base64, s.shot);
    // Compare at reduced size: missing or misplaced content shows, sub-pixel AA noise does not.
    const w = Math.min(640, s.o.width);
    const h = Math.max(1, Math.round((w * s.o.height) / s.o.width));
    const read = (from: CanvasImageSource) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(from, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const a = read(verifyCopy);
    const b = read(s.shot);
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const dr = a[i]! - b[i]!;
      const dg = a[i + 1]! - b[i + 1]!;
      const db = a[i + 2]! - b[i + 2]!;
      sum += dr * dr + dg * dg + db * db;
    }
    const mse = sum / ((a.length / 4) * 3);
    return mse === 0 ? 100 : 10 * Math.log10((255 * 255) / mse);
  }

  async function run(startFrame: number, count: number, subframeOffsets: number[]): Promise<void> {
    const { s } = requireSession();
    const blurred = subframeOffsets.length > 1;
    for (let i = 0; i < count; i++) {
      const frameIndex = startFrame + i;
      const t = frameIndex / s.o.fps;
      // The frame-time seek carries the timeline's side effects; sub-frame samples are quiet and
      // the playhead returns to the frame time, so the next seek crosses exactly (t, t + 1/fps].
      await seek(t);
      for (let k = 0; k < subframeOffsets.length; k++) {
        if (blurred) await seek(t + subframeOffsets[k]!, true);
        await sample(k, k === subframeOffsets.length - 1 ? frameIndex : undefined);
      }
      if (blurred) await seek(t, true);
    }
  }

  async function end(): Promise<PageRenderStats> {
    const { s } = requireSession();
    try {
      await s.encoder.flush();
      if (s.encoderError) throw s.encoderError;
      await flush(s);
      w.__fvProgress(s.frames);
    } finally {
      if (s.encoder.state !== "closed") s.encoder.close();
      session = null;
    }
    return {
      frames: s.frames,
      encoderConfig: { codec: s.o.codec, hardwareAcceleration: s.config.hardwareAcceleration ?? "no-preference" },
      hardwareFallback: s.hardwareFallback,
      seekMs: Math.round(s.stats.seekMs),
      paintMs: Math.round(s.stats.paintMs),
      encodeWaitMs: Math.round(s.stats.encodeWaitMs),
      transferWaitMs: Math.round(s.stats.transferWaitMs),
      reusedPaints: s.stats.reusedPaints,
      chunks: s.stats.chunks,
      emptyChunks: s.stats.emptyChunks,
      ...(state?.reuseBlocker && s.o.reusePaints ? { reuseDisabledReason: state.reuseBlocker } : {}),
    };
  }

  const api: FrameVeloPageApi = {
    prepare,
    begin,
    seek,
    sample,
    sampleScreenshot,
    encode,
    run,
    end,
    setRoute,
    targetRect,
    boundaries,
    paintOnly,
    compareScreenshot,
    composite,
    captureDataUrl: () => {
      if (!verifyCopy) return "";
      const c = document.createElement("canvas");
      c.width = verifyCopy.width;
      c.height = verifyCopy.height;
      c.getContext("2d")!.drawImage(verifyCopy, 0, 0);
      return c.toDataURL("image/png");
    },
  };
  w.__fv = api;
}
