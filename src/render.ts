import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import {
  captureToFile,
  openCapturePage,
  preparePage,
  type CapturePage,
  type CapturePolicy,
  type CaptureResult,
  type CaptureWorker,
} from "./capture.ts";
import { chromeMajor, findChrome, framevelCacheDir, launchChrome, MIN_DOM_CHROME_MAJOR } from "./chrome.ts";
import { ensureProxy } from "./media-proxy.ts";
import { isHyperFramesHtml, loadHyperFrames, PAGE_SIDE_COMPOSITING_FLAG, prepareHyperFramesSite, type HyperFramesSite } from "./hyperframes.ts";
import { defaultBitrate, evenDimension, frameCount, subframeOffsets, type Codec, type Quality } from "./options.ts";
import type { CaptureMode, FrameVeloPageApi, PagePrepareResult, PageRenderStats, TimeDriver } from "./page-runtime.ts";
import type { IntervalPlan } from "./planner.ts";
import { resolveInsideRoot, serveDirectory, type StaticServer } from "./server.ts";
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
  /** Reuse the previous paint when a seek changed nothing in the composition (default true). */
  reusePaints?: boolean;
  codec?: Codec;
  /** Bits per second; overrides `quality`. */
  bitrate?: number;
  /** Bitrate preset when no bitrate is given (default "standard"). */
  quality?: Quality;
  /** Audio file to mux. For HyperFrames projects it replaces the composition's own mix. */
  audio?: string;
  subframes?: number;
  shutter?: number;
  background?: string;
  /**
   * Extra directories to serve, keyed by URL prefix ("/vendor/" → a directory outside the project),
   * for pages that load shared files from absolute paths.
   */
  mounts?: Record<string, string>;
  /**
   * Plain pages: replace <video data-start> sources that are not all-intra with cached all-intra
   * proxies so every seek decodes one frame (default true).
   */
  videoProxies?: boolean;
  /**
   * How to treat a HyperFrames project (a page with a data-composition-id root): "auto" compiles and
   * serves it with the official HyperFrames pipeline when @hyperframes/producer is installed;
   * "off" renders it as a plain seekable page.
   */
  hyperframes?: "auto" | "off";
  /**
   * Pages that render frames driven from Node (HyperFrames video frames, screenshot capture) in
   * parallel, each over a contiguous part of the range. Default: chosen from the CPU count; 1 turns
   * it off. Frames painted inside the page do not use workers.
   */
  workers?: number;
  chromePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  readyTimeoutMs?: number;
  /** Aborting closes the browser and rejects with the signal's reason; no output is left behind. */
  signal?: AbortSignal;
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
  /** Wall time of each stage: HyperFrames compile, page load and preparation, capture and encode. */
  stages: { compileMs: number; prepareMs: number; renderMs: number };
  warnings: string[];
  /** DOM capture: route and verification samples of each interval. */
  plan: IntervalPlan[];
  /** Node-driven frame loop timings (frames with video injection or screenshots). */
  nodeLoop: CaptureResult["nodeLoop"];
  /** Frames captured through native screenshots instead of drawElementImage. */
  screenshotFrames: number;
  /** Pages that rendered frames in parallel. */
  workers: number;
  page: PageRenderStats;
}

/** Parallel pages for Node-driven frames: latency-bound, so a few pages overlap their round trips. */
export function defaultWorkers(cpus = os.availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(cpus / 3)));
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

/** A served URL back to the file it came from (the root or a mount), or null. */
export function localFileForUrl(url: string, origin: string, root: string, mounts: Record<string, string> = {}): string | null {
  if (!url.startsWith(`${origin}/`)) return null;
  const pathname = decodeURIComponent(new URL(url).pathname);
  for (const [prefix, dir] of Object.entries(mounts)) {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (pathname.startsWith(normalized)) return resolveInsideRoot(path.resolve(dir), `/${pathname.slice(normalized.length)}`);
  }
  return resolveInsideRoot(root, pathname);
}

const PROXY_URL_PREFIX = "/__framevelo/proxies/";
const proxyCacheDir = () => path.join(framevelCacheDir(), "proxies");

/** Swap long-GOP sources of managed videos for all-intra proxies (built once, then cached). */
async function useVideoProxies(
  capture: CapturePage,
  root: string,
  origin: string,
  options: Pick<RenderOptions, "ffmpegPath" | "ffprobePath">,
  log: (message: string) => void,
): Promise<void> {
  type FvWindow = { __fv: FrameVeloPageApi };
  const sources = await capture.page.evaluate(() => (window as unknown as FvWindow).__fv.managedVideoSources());
  for (const [index, src] of sources.entries()) {
    if (!src.startsWith(`${origin}/`)) continue;
    const file = resolveInsideRoot(root, new URL(src).pathname);
    if (!file) continue;
    const started = performance.now();
    try {
      const result = await ensureProxy(file, {
        cacheDir: proxyCacheDir(),
        ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
        ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
      });
      if (!result.proxy) continue;
      const url = `${origin}${PROXY_URL_PREFIX}${encodeURIComponent(path.basename(result.proxy))}`;
      const loaded = await capture.page.evaluate((i, u) => (window as unknown as FvWindow).__fv.replaceVideoSource(i, u), index, url);
      log(`video ${path.relative(root, file)}: all-intra proxy ${result.reason}${result.reason.startsWith("built") ? ` in ${Math.round(performance.now() - started)} ms` : ""}${loaded ? "" : " (failed to load; keeping the original)"}`);
      if (!loaded) await capture.page.evaluate((i, u) => (window as unknown as FvWindow).__fv.replaceVideoSource(i, u), index, src);
    } catch (error) {
      log(`video ${path.relative(root, file)}: no proxy (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }
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
  const { signal } = options;
  signal?.throwIfAborted();
  const codec: Codec = options.codec ?? "h264";
  const { root, file } = await resolveInput(options.input);
  const html = await readFile(file, "utf8");
  const viewport = options.viewport ?? viewportFromHtml(html) ?? { width: 1920, height: 1080 };
  const useHyperFrames = options.hyperframes !== "off" && isHyperFramesHtml(html);

  const chromePath = findChrome(options.chromePath ? { explicitPath: options.chromePath } : {});
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Run `framevelo browser install`, install Google Chrome, or pass --chrome / set FRAMEVELO_CHROME to a Chrome 151+ binary.",
    );
  }

  let site: HyperFramesSite | undefined;
  let server: StaticServer | undefined;
  let browser: Browser | undefined;
  const warnings: string[] = [];
  // Chrome starts while the project compiles; neither needs the other.
  const browserLaunch = launchChrome(chromePath);
  browserLaunch.catch(() => {});
  // Closing the browser makes whatever the render is waiting on fail fast.
  const abort = () => void browserLaunch.then((b) => b.close()).catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  let compileMs = 0;
  try {
    let url: string;
    const c0 = performance.now();
    if (useHyperFrames) {
      const api = await loadHyperFrames();
      const fps = options.fps ?? fpsFromHtml(html) ?? 30;
      log(`hyperframes project: compiling with @hyperframes/producer ${api.version}`);
      site = await prepareHyperFramesSite(api, {
        projectDir: root,
        width: viewport.width,
        height: viewport.height,
        fps,
        preHeadScripts: [VIRTUAL_TIME_SHIM, PAGE_SIDE_COMPOSITING_FLAG],
        onLog: log,
      });
      if (site.videos && site.planFps !== fps) {
        warnings.push(`video frames were extracted at ${site.planFps} fps for a ${fps} fps render; video motion is approximate`);
      }
      url = site.url;
      // The compiled entry is always index.html; a non-index input file is compiled as the project root.
      if (path.basename(file) !== "index.html") warnings.push(`compiled ${root} as a HyperFrames project (entry index.html)`);
    } else {
      const mounts: Record<string, string> = { ...options.mounts, [PROXY_URL_PREFIX]: proxyCacheDir() };
      server = await serveDirectory(root, { mounts });
      url = `${server.origin}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;
    }

    compileMs = performance.now() - c0;
    signal?.throwIfAborted();
    const p0 = performance.now();
    browser = await browserLaunch;
    const version = await browser.version();
    log(`chrome ${version} (${chromePath})`);
    // Plain pages get a seeded Math.random so renders repeat; HyperFrames keeps the official behavior.
    const pageOptions = {
      mode: useHyperFrames ? "dom" : (options.mode ?? "auto"),
      ...(options.selector ? { selector: options.selector } : {}),
      readyTimeoutMs: options.readyTimeoutMs ?? (useHyperFrames ? 45_000 : 10_000),
      ...(useHyperFrames ? { expectHyperFrames: true } : {}),
    } as const;
    const capture: CapturePage = await openCapturePage(browser, url, viewport, { seedRandom: !useHyperFrames });
    const prepared: PagePrepareResult = await preparePage(capture, pageOptions);
    warnings.push(...prepared.warnings);
    if (prepared.mode === "dom" && prepared.drawElementReady && chromeMajor(version) < MIN_DOM_CHROME_MAJOR) {
      warnings.push(`Chrome ${chromeMajor(version)} predates reliable drawElementImage (${MIN_DOM_CHROME_MAJOR}+); verification decides per interval`);
    }

    if (prepared.managedVideos > 0 && server && options.videoProxies !== false) {
      await useVideoProxies(capture, root, server.origin, options, log);
    }
    const prepareMs = performance.now() - p0;
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
    const bitrate = options.bitrate ?? defaultBitrate(width, height, fps, codec, options.quality);
    log(`${prepared.mode} capture via ${prepared.driver}: ${frames} frames at ${fps} fps, ${width}x${height}, ${codec} ${(bitrate / 1e6).toFixed(1)} Mbps`);
    for (const warning of warnings) log(`warning: ${warning}`);

    // The official injector swaps <video> elements for pre-extracted frames after each seek. Each
    // page gets its own injector: it remembers what it injected.
    let hookFor: ((page: CapturePage["page"]) => (time: number) => Promise<void>) | undefined;
    let needsBeforeSample: ((time: number) => boolean) | undefined;
    const offsets = subframeOffsets(options.subframes ?? 1, options.shutter ?? 0.5, fps);
    if (site?.videos) {
      const api = await loadHyperFrames();
      const videos = site.videos;
      const lookup = api.engine.createFrameLookupTable(videos.videos, videos.extracted, site.planFps);
      const frameUrl = site.frameUrl;
      // Frames load over same-origin HTTP rather than as base64 data URIs through the protocol.
      const injector = () => api.producer.createVideoFrameInjector(lookup, { frameSrcResolver: (framePath) => frameUrl(framePath) });
      if (injector()) {
        hookFor = (page) => {
          const inject = injector()!;
          return (time) => inject(page, time);
        };
        // Only frames inside a video's window (one frame of margin) need the round trip.
        const windows = videoWindows(videos.videos);
        const margin = 1 / fps;
        needsBeforeSample = windows ? (t) => windows.some(([a, b]) => t >= a - margin && t < b + margin) : undefined;
      }
    }
    const beforeSample = hookFor?.(capture.page);
    const openWorker = async (): Promise<CaptureWorker> => {
      const worker = await openCapturePage(browser!, url, viewport, { seedRandom: !useHyperFrames });
      try {
        const ready = await preparePage(worker, pageOptions);
        if (ready.mode !== prepared.mode || ready.cssWidth !== prepared.cssWidth || ready.cssHeight !== prepared.cssHeight) {
          throw new Error("a worker page prepared differently from the main page");
        }
        if (ready.managedVideos > 0 && server && options.videoProxies !== false) {
          await useVideoProxies(worker, root, server.origin, options, () => {});
        }
      } catch (error) {
        await worker.page.close().catch(() => {});
        throw error;
      }
      const hook = hookFor?.(worker.page);
      return { page: worker.page, ...(hook ? { beforeSample: hook } : {}), close: () => worker.page.close() };
    };

    let declaredAudio: string | undefined;
    if (!options.audio && !site && prepared.audio && server) {
      declaredAudio = localFileForUrl(prepared.audio, server.origin, root, options.mounts) ?? undefined;
      if (declaredAudio) log(`audio: ${path.relative(root, declaredAudio) || declaredAudio} (declared by the page)`);
      else warnings.push(`the page declares audio ${prepared.audio}, which is not a local file`);
    }
    const audioPath = options.audio ? path.resolve(options.audio) : (site?.audioPath ?? declaredAudio);
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
      subframeOffsets: offsets,
      ...(options.capture ? { capture: options.capture } : {}),
      ...(options.reusePaints !== undefined ? { reusePaints: options.reusePaints } : {}),
      ...(options.verifyThresholdDb !== undefined ? { verifyThresholdDb: options.verifyThresholdDb } : {}),
      onLog: log,
      ...(options.background ? { background: options.background } : {}),
      ...(audioPath ? { audio: { path: audioPath, offset: start, copy: !options.audio && Boolean(site?.audioPath) } } : {}),
      ...(beforeSample ? { beforeSample } : {}),
      ...(needsBeforeSample ? { needsBeforeSample } : {}),
      workers: options.workers ?? defaultWorkers(),
      openWorker,
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
      stages: { compileMs: Math.round(compileMs), prepareMs: Math.round(prepareMs), renderMs: result.renderMs },
      warnings,
      plan: result.plan,
      nodeLoop: result.nodeLoop,
      screenshotFrames: result.screenshotFrames,
      workers: result.workers,
      page: result.page,
    };
  } catch (error) {
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", abort);
    browser ??= await browserLaunch.catch(() => undefined);
    await browser?.close().catch(() => {});
    await server?.close();
    await site?.close();
  }
}

