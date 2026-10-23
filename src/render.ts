import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import { chromeMajor, findChrome, launchChrome, MIN_DOM_CHROME_MAJOR } from "./chrome.ts";
import { buildMuxArgs, detectAacEncoder, probeVideo, startMux } from "./ffmpeg.ts";
import {
  codecString,
  defaultBitrate,
  evenDimension,
  frameCount,
  keyframeInterval,
  subframeOffsets,
  type Codec,
} from "./options.ts";
import {
  pagePrepare,
  pageRender,
  type CaptureMode,
  type PagePrepareResult,
  type PageRenderOptions,
  type PageRenderStats,
} from "./page-runtime.ts";
import { serveDirectory } from "./server.ts";

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
  codec?: Codec;
  /** Bits per second. */
  bitrate?: number;
  audio?: string;
  subframes?: number;
  shutter?: number;
  background?: string;
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
  driver: PagePrepareResult["driver"];
  chrome: string;
  hardwareEncoder: boolean;
  bytes: number;
  wallMs: number;
  renderMs: number;
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

export async function render(options: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  const log = options.onLog ?? (() => {});
  const codec: Codec = options.codec ?? "h264";
  const { root, file } = await resolveInput(options.input);
  const viewport = options.viewport ?? viewportFromHtml(await readFile(file, "utf8")) ?? { width: 1920, height: 1080 };

  const chromePath = findChrome(options.chromePath ? { explicitPath: options.chromePath } : {});
  if (!chromePath) {
    throw new Error("Chrome not found. Install Google Chrome, or pass --chrome / set FRAMEVELO_CHROME to a Chrome 151+ binary.");
  }

  const output = path.resolve(options.output);
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.${randomBytes(4).toString("hex")}.partial.mp4`);
  const server = await serveDirectory(root);
  let browser: Browser | undefined;
  let mux: ReturnType<typeof startMux> | undefined;
  try {
    browser = await launchChrome(chromePath);
    const version = await browser.version();
    log(`chrome ${version} (${chromePath})`);

    const page = await browser.newPage();
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
    // HyperFrames compositions assign into a registry its runtime normally creates first.
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __timelines?: Record<string, unknown> };
      w.__timelines ??= {};
    });

    const url = `${server.origin}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;
    await page.goto(url, { waitUntil: "load" });

    let prepared: PagePrepareResult;
    try {
      prepared = await page.evaluate(pagePrepare, {
        mode: options.mode ?? "auto",
        ...(options.selector ? { selector: options.selector } : {}),
        readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      });
    } catch (error) {
      const detail = pageErrors.length ? `\nPage errors:\n  ${pageErrors.slice(0, 5).join("\n  ")}` : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    }
    if (prepared.mode === "dom" && chromeMajor(version) < MIN_DOM_CHROME_MAJOR) {
      throw new Error(`DOM capture needs Chrome ${MIN_DOM_CHROME_MAJOR} or later; found ${version}.`);
    }

    const fps = options.fps ?? prepared.fps ?? 30;
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

    const audioEncoder = options.audio ? await detectAacEncoder(options.ffmpegPath) : undefined;
    mux = startMux(
      buildMuxArgs({
        codec,
        fps,
        output: staging,
        ...(options.audio ? { audio: path.resolve(options.audio), audioOffset: start } : {}),
        ...(audioEncoder ? { audioEncoder } : {}),
      }),
      options.ffmpegPath,
    );
    const activeMux = mux;
    await page.exposeFunction("__fvChunk", (base64: string) => activeMux.write(Buffer.from(base64, "base64")));
    await page.exposeFunction("__fvProgress", (done: number) => options.onProgress?.(done, frames));

    const renderOptions: PageRenderOptions = {
      width,
      height,
      fps,
      startFrame: Math.round(start * fps),
      frames,
      codec: codecString(codec, width, height, fps),
      bitrate,
      keyframeInterval: keyframeInterval(fps),
      subframeOffsets: subframeOffsets(options.subframes ?? 1, options.shutter ?? 0.5, fps),
      hardwareAcceleration: "prefer-hardware",
      maxEncodeQueue: 4,
      chunkBytes: 2 << 20,
      paintTimeoutMs: 10_000,
      ...(options.background ? { background: options.background } : {}),
    };
    const r0 = performance.now();
    const pageStats = await page.evaluate(pageRender, renderOptions);
    const renderMs = performance.now() - r0;
    if (pageStats.hardwareFallback) log("hardware encoder unavailable for this configuration; Chrome chose its own encoder");

    await mux.finish();
    mux = undefined;

    const probe = await probeVideo(staging, options.ffprobePath);
    if (probe.packets !== frames) throw new Error(`Encoded ${probe.packets} video packets, expected ${frames}.`);
    if (probe.width !== width || probe.height !== height) {
      throw new Error(`Output is ${probe.width}x${probe.height}, expected ${width}x${height}.`);
    }
    if (options.audio && !probe.audioCodec) throw new Error("The audio track is missing from the output.");
    await rename(staging, output);
    const { size } = await stat(output);

    return {
      output,
      frames,
      fps,
      width,
      height,
      codec,
      bitrate,
      mode: prepared.mode,
      driver: prepared.driver,
      chrome: version,
      hardwareEncoder: !pageStats.hardwareFallback,
      bytes: size,
      wallMs: Math.round(performance.now() - t0),
      renderMs: Math.round(renderMs),
      page: pageStats,
    };
  } finally {
    mux?.kill();
    await browser?.close().catch(() => {});
    await server.close();
    await rm(staging, { force: true });
  }
}
