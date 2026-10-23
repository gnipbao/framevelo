import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import { captureToFile, openCapturePage, preparePage, type CapturePage, type CapturePolicy } from "./capture.ts";
import { chromeMajor, findChrome, launchChrome, MIN_DOM_CHROME_MAJOR } from "./chrome.ts";
import { isHyperFramesHtml, loadHyperFrames, prepareHyperFramesSite, type HyperFramesSite } from "./hyperframes.ts";
import { defaultBitrate, evenDimension, frameCount, subframeOffsets, type Codec } from "./options.ts";
import type { CaptureMode, PagePrepareResult, PageRenderStats, TimeDriver } from "./page-runtime.ts";
import type { IntervalPlan } from "./planner.ts";
import { serveDirectory, type StaticServer } from "./server.ts";
import { VIRTUAL_TIME_SHIM } from "./virtual-time-shim.ts";

export interface RenderOptions {
  /** An .html file, or a directory containing index.html. */
  input: string;
  /** Output .mp4 path. */
  output: string;
  fps?: number;
  /** Seconds. Defaults to what the page declares (HyperFrames data-duration, timeline length, ...). */
  duration?: number;
  /** Exact frame count; overrides duration. */
  frames?: number;
  /** First frame time in seconds. */
  start?: number;
  /** Output size in pixels. Defaults to the captured element's CSS size times `scale`. */
  width?: number;
  height?: number;
  scale?: number;
  /** CSS viewport; defaults to data-width/data-height or the viewport meta tag of the input, else 1920x1080. */
  viewport?: { width: number; height: number };
  mode?: CaptureMode;
  selector?: string;
  /** DOM pages: verify sampled frames against screenshots ("auto"), or force one capture route. */
  capture?: CapturePolicy;
  /** Verification PSNR below which an interval falls back to screenshot capture (default 30 dB). */
  verifyThresholdDb?: number;
  codec?: Codec;
  /** Bits per second. */
  bitrate?: number;
  /** Audio file to mux. For HyperFrames projects it replaces the composition's own mix. */
  audio?: string;
  subframes?: number;
  shutter?: number;
  background?: string;
  /**
   * How to treat a HyperFrames project (a page with a data-composition-id root): "auto" compiles and
   * serves it with the official HyperFrames pipeline when @hyperframes/producer is installed;
   * "off" renders it as a plain seekable page.
   */
  hyperframes?: "auto" | "off";
  chromePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  readyTimeoutMs?: number;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  onLog?: (message: string) => void;
}

export interface RenderResult {
  output: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  codec: Codec;
  bitrate: number;
  mode: "canvas" | "dom";
  driver: TimeDriver;
  /** "hyperframes" when the official HyperFrames compiler and runtime prepared the page. */
  pipeline: "page" | "hyperframes";
  chrome: string;
  hardwareEncoder: boolean;
  audio: boolean;
  bytes: number;
  wallMs: number;
  renderMs: number;
  warnings: string[];
  /** DOM capture: route and verification samples of each interval. */
  plan: IntervalPlan[];
  /** Frames captured through native screenshots instead of drawElementImage. */
  screenshotFrames: number;
  page: PageRenderStats;
}

export async function resolveInput(input: string): Promise<{ root: string; file: string }> {
  const absolute = path.resolve(input);
  const info = await stat(absolute).catch(() => null);
  if (!info) throw new Error(`Input not found: ${input}`);
  const file = info.isDirectory() ? path.join(absolute, "index.html") : absolute;
  if (info.isDirectory() && !(await stat(file).catch(() => null))) throw new Error(`No index.html in ${input}`);
  return { root: path.dirname(file), file };
}

/** Viewport hint from the HTML source, read before the page loads so layout happens at the right size. */
export function viewportFromHtml(html: string): { width: number; height: number } | null {
  const root = /<[^>]*\bdata-composition-id\b[^>]*>/i.exec(html)?.[0] ?? "";
  const width = /\bdata-width\s*=\s*["']?(\d+)/i.exec(root)?.[1];
  const height = /\bdata-height\s*=\s*["']?(\d+)/i.exec(root)?.[1];
  if (width && height) return { width: Number(width), height: Number(height) };
  const meta = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i.exec(html)?.[0] ?? "";
  const mw = /width\s*=\s*(\d+)/i.exec(meta)?.[1];
  const mh = /height\s*=\s*(\d+)/i.exec(meta)?.[1];
  if (mw && mh) return { width: Number(mw), height: Number(mh) };
  return null;
}

/**
 * Composition-time windows [start, end) of the planned videos, or null when any window is unknown
 * (then every frame goes through the injector).
 */
export function videoWindows(videos: unknown[]): Array<[number, number]> | null {
  const windows: Array<[number, number]> = [];
  for (const video of videos) {
    const { start, end } = video as { start?: unknown; end?: unknown };
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    windows.push([start, end]);
  }
  return windows;
}

/** data-fps on the composition root, read before compiling. */
export function fpsFromHtml(html: string): number | undefined {
  const root = /<[^>]*\bdata-composition-id\b[^>]*>/i.exec(html)?.[0] ?? "";
  const fps = Number(/\bdata-fps\s*=\s*["']?([\d.]+)/i.exec(root)?.[1]);
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

export async function render(options: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  const log = options.onLog ?? (() => {});
  const codec: Codec = options.codec ?? "h264";
  const { root, file } = await resolveInput(options.input);
  const html = await readFile(file, "utf8");
  const viewport = options.viewport ?? viewportFromHtml(html) ?? { width: 1920, height: 1080 };
  const useHyperFrames = options.hyperframes !== "off" && isHyperFramesHtml(html);

  const chromePath = findChrome(options.chromePath ? { explicitPath: options.chromePath } : {});
  if (!chromePath) {
    throw new Error("Chrome not found. Install Google Chrome, or pass --chrome / set FRAMEVELO_CHROME to a Chrome 151+ binary.");
  }

  let site: HyperFramesSite | undefined;
  let server: StaticServer | undefined;
  let browser: Browser | undefined;
  const warnings: string[] = [];
  // Chrome starts while the project compiles; neither needs the other.
  const browserLaunch = launchChrome(chromePath);
  browserLaunch.catch(() => {});
  try {
    let url: string;
    if (useHyperFrames) {
      const api = await loadHyperFrames();
      const fps = options.fps ?? fpsFromHtml(html) ?? 30;
      log(`hyperframes project: compiling with @hyperframes/producer ${api.version}`);
      site = await prepareHyperFramesSite(api, {
        projectDir: root,
        width: viewport.width,
        height: viewport.height,
        fps,
        preHeadScripts: [VIRTUAL_TIME_SHIM],
        onLog: log,
      });
      if (site.videos && site.planFps !== fps) {
        warnings.push(`video frames were extracted at ${site.planFps} fps for a ${fps} fps render; video motion is approximate`);
      }
      url = site.url;
      // The compiled entry is always index.html; a non-index input file is compiled as the project root.
      if (path.basename(file) !== "index.html") warnings.push(`compiled ${root} as a HyperFrames project (entry index.html)`);
    } else {
      server = await serveDirectory(root);
      url = `${server.origin}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;
    }

    browser = await browserLaunch;
    const version = await browser.version();
    log(`chrome ${version} (${chromePath})`);
    const capture: CapturePage = await openCapturePage(browser, url, viewport);
    const prepared: PagePrepareResult = await preparePage(capture, {
      mode: useHyperFrames ? "dom" : (options.mode ?? "auto"),
      ...(options.selector ? { selector: options.selector } : {}),
      readyTimeoutMs: options.readyTimeoutMs ?? (useHyperFrames ? 45_000 : 10_000),
      ...(useHyperFrames ? { expectHyperFrames: true } : {}),
    });
    warnings.push(...prepared.warnings);
    if (prepared.mode === "dom" && prepared.drawElementReady && chromeMajor(version) < MIN_DOM_CHROME_MAJOR) {
      warnings.push(`Chrome ${chromeMajor(version)} predates reliable drawElementImage (${MIN_DOM_CHROME_MAJOR}+); verification decides per interval`);
    }

    const fps = options.fps ?? prepared.fps ?? (useHyperFrames ? fpsFromHtml(html) : undefined) ?? 30;
    const start = options.start ?? 0;
    const duration = options.duration ?? (prepared.duration !== undefined ? prepared.duration - start : undefined);
    const frames = options.frames ?? (duration !== undefined ? frameCount(duration, fps) : undefined);
    if (frames === undefined) {
      throw new Error("Unknown duration: pass --duration or --frames, or declare it in the page (window.__framevelo.duration, data-duration).");
    }
    const scale = options.scale ?? 1;
    const baseWidth = prepared.mode === "canvas" ? (prepared.canvasWidth ?? prepared.cssWidth) : prepared.cssWidth;
    const baseHeight = prepared.mode === "canvas" ? (prepared.canvasHeight ?? prepared.cssHeight) : prepared.cssHeight;
    const width = evenDimension(options.width ?? baseWidth * scale);
    const height = evenDimension(options.height ?? baseHeight * scale);
    const bitrate = options.bitrate ?? defaultBitrate(width, height, fps, codec);
    log(`${prepared.mode} capture via ${prepared.driver}: ${frames} frames at ${fps} fps, ${width}x${height}, ${codec} ${(bitrate / 1e6).toFixed(1)} Mbps`);
    for (const warning of warnings) log(`warning: ${warning}`);

    // The official injector swaps <video> elements for pre-extracted frames after each seek.
    let beforeSample: ((time: number) => Promise<void>) | undefined;
    let needsBeforeSample: ((time: number) => boolean) | undefined;
    if (site?.videos) {
      const api = await loadHyperFrames();
      const lookup = api.engine.createFrameLookupTable(site.videos.videos, site.videos.extracted, site.planFps);
      const inject = api.producer.createVideoFrameInjector(lookup);
      if (inject) {
        beforeSample = (time) => inject(capture.page, time);
        // Only frames inside a video's window (one frame of margin) need the round trip.
        const windows = videoWindows(site.videos.videos);
        const margin = 1 / fps;
        needsBeforeSample = windows ? (t) => windows.some(([a, b]) => t >= a - margin && t < b + margin) : undefined;
      }
    }

    const audioPath = options.audio ? path.resolve(options.audio) : (site?.audioPath ?? undefined);
    const result = await captureToFile({
      page: capture.page,
      prepared,
      output: options.output,
      fps,
      startFrame: Math.round(start * fps),
      frames,
      width,
      height,
      codec,
      bitrate,
      subframeOffsets: subframeOffsets(options.subframes ?? 1, options.shutter ?? 0.5, fps),
      ...(options.capture ? { capture: options.capture } : {}),
      ...(options.verifyThresholdDb !== undefined ? { verifyThresholdDb: options.verifyThresholdDb } : {}),
      onLog: log,
      ...(options.background ? { background: options.background } : {}),
      ...(audioPath ? { audio: { path: audioPath, offset: start, copy: !options.audio && Boolean(site?.audioPath) } } : {}),
      ...(beforeSample ? { beforeSample } : {}),
      ...(needsBeforeSample ? { needsBeforeSample } : {}),
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    if (result.page.hardwareFallback) log("hardware encoder unavailable for this configuration; Chrome chose its own encoder");

    return {
      output: result.output,
      frames,
      fps,
      width,
      height,
      codec,
      bitrate,
      mode: prepared.mode,
      driver: prepared.driver,
      pipeline: useHyperFrames ? "hyperframes" : "page",
      chrome: version,
      hardwareEncoder: !result.page.hardwareFallback,
      audio: Boolean(result.probe.audioCodec),
      bytes: result.bytes,
      wallMs: Math.round(performance.now() - t0),
      renderMs: result.renderMs,
      warnings,
      plan: result.plan,
      screenshotFrames: result.screenshotFrames,
      page: result.page,
    };
  } finally {
    browser ??= await browserLaunch.catch(() => undefined);
    await browser?.close().catch(() => {});
    await server?.close();
    await site?.close();
  }
}

