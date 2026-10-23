import { randomBytes } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { buildMuxArgs, detectAacEncoder, probeVideo, startMux, type MuxProcess, type VideoProbe } from "./ffmpeg.ts";
import { codecString, keyframeInterval, type Codec } from "./options.ts";
import {
  pageBootstrap,
  pageInstallRuntime,
  type FrameVeloPageApi,
  type PageEncodeOptions,
  type PagePrepareOptions,
  type PagePrepareResult,
  type PageRenderStats,
} from "./page-runtime.ts";

/** Shape of `window` once `pageInstallRuntime` has run (type-only; erased before serialization). */
type FvWindow = { __fv: FrameVeloPageApi };

export interface CapturePage {
  page: Page;
  /** Uncaught page errors seen so far, for error messages. */
  errors: string[];
}

/**
 * Open `url` in a fresh tab ready for capture: the bootstrap runs before any page script, and the
 * FrameVelo runtime is installed once the page has loaded.
 */
export async function openCapturePage(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<CapturePage> {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
  await page.evaluateOnNewDocument(pageBootstrap);
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(pageInstallRuntime);
  return { page, errors };
}

export async function preparePage(capture: CapturePage, options: PagePrepareOptions): Promise<PagePrepareResult> {
  try {
    return await capture.page.evaluate((o) => (window as unknown as FvWindow).__fv.prepare(o), options);
  } catch (error) {
    const detail = capture.errors.length ? `\nPage errors:\n  ${capture.errors.slice(0, 5).join("\n  ")}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}

export interface CaptureJob {
  page: Page;
  output: string;
  fps: number;
  /** Index of the first output frame on the composition timeline. */
  startFrame: number;
  frames: number;
  width: number;
  height: number;
  codec: Codec;
  bitrate: number;
  /** Seconds relative to each frame time; more than one entry averages sub-frames (motion blur). */
  subframeOffsets: number[];
  background?: string;
  audio?: {
    path: string;
    /** Seconds to skip at the start of the audio file. */
    offset: number;
    /** The file is already AAC: copy it instead of encoding. */
    copy?: boolean;
  };
  /**
   * Called after every seek, before the sub-frame is painted (e.g. to inject decoded video frames).
   * Frames that need it are driven from Node, one round trip per step; the rest run in the page.
   */
  beforeSample?: (time: number) => Promise<void>;
  /** Times at which `beforeSample` has work to do; other frames skip it. Defaults to every time. */
  needsBeforeSample?: (time: number) => boolean;
  paintTimeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  onProgress?: (framesDone: number, framesTotal: number) => void;
}

export interface CaptureResult {
  output: string;
  bytes: number;
  renderMs: number;
  page: PageRenderStats;
  probe: VideoProbe;
}

export interface FrameSegment {
  start: number;
  count: number;
  /** Driven from Node so `beforeSample` runs between seek and paint. */
  hooked: boolean;
}

/**
 * Split the frame range into runs that need the `beforeSample` hook and runs that can loop inside
 * the page. A frame after a hooked one stays hooked, so the hook sees the moment its work ends
 * (an injected video frame must be hidden again).
 */
export function planSegments(job: Pick<CaptureJob, "startFrame" | "frames" | "fps" | "subframeOffsets" | "beforeSample" | "needsBeforeSample">): FrameSegment[] {
  if (!job.beforeSample) return job.frames > 0 ? [{ start: job.startFrame, count: job.frames, hooked: false }] : [];
  const needs = job.needsBeforeSample ?? (() => true);
  const segments: FrameSegment[] = [];
  let previousNeeded = false;
  for (let i = 0; i < job.frames; i++) {
    const frameIndex = job.startFrame + i;
    const needed = job.subframeOffsets.some((offset) => needs(Math.max(0, frameIndex / job.fps + offset)));
    const hooked = needed || previousNeeded || i === 0;
    previousNeeded = needed;
    const tail = segments.at(-1);
    if (tail && tail.hooked === hooked) tail.count++;
    else segments.push({ start: frameIndex, count: 1, hooked });
  }
  return segments;
}

/**
 * Encode `frames` frames from a prepared page into `job.output`. The file is written next to its
 * destination under a temporary name, verified with ffprobe, then renamed; a failure leaves nothing.
 */
export async function captureToFile(job: CaptureJob): Promise<CaptureResult> {
  const { page } = job;
  const output = path.resolve(job.output);
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.${randomBytes(4).toString("hex")}.partial.mp4`);

  const audioEncoder = job.audio ? (job.audio.copy ? "copy" : await detectAacEncoder(job.ffmpegPath)) : undefined;
  let mux: MuxProcess | undefined = startMux(
    buildMuxArgs({
      codec: job.codec,
      fps: job.fps,
      output: staging,
      ...(job.audio ? { audio: path.resolve(job.audio.path), audioOffset: job.audio.offset } : {}),
      ...(audioEncoder ? { audioEncoder } : {}),
    }),
    job.ffmpegPath,
  );
  try {
    const activeMux = mux;
    await page.exposeFunction("__fvChunk", (base64: string) => activeMux.write(Buffer.from(base64, "base64")));
    await page.exposeFunction("__fvProgress", (done: number) => job.onProgress?.(done, job.frames));

    const encodeOptions: PageEncodeOptions = {
      width: job.width,
      height: job.height,
      fps: job.fps,
      codec: codecString(job.codec, job.width, job.height, job.fps),
      bitrate: job.bitrate,
      keyframeInterval: keyframeInterval(job.fps),
      subframes: job.subframeOffsets.length,
      hardwareAcceleration: "prefer-hardware",
      maxEncodeQueue: 4,
      chunkBytes: 2 << 20,
      paintTimeoutMs: job.paintTimeoutMs ?? 10_000,
      ...(job.background ? { background: job.background } : {}),
    };
    const r0 = performance.now();
    await page.evaluate((o) => (window as unknown as FvWindow).__fv.begin(o), encodeOptions);
    for (const segment of planSegments(job)) {
      if (!segment.hooked) {
        await page.evaluate(
          (start, count, offsets) => (window as unknown as FvWindow).__fv.run(start, count, offsets),
          segment.start,
          segment.count,
          job.subframeOffsets,
        );
        continue;
      }
      const last = job.subframeOffsets.length - 1;
      for (let frameIndex = segment.start; frameIndex < segment.start + segment.count; frameIndex++) {
        for (let k = 0; k <= last; k++) {
          const t = Math.max(0, frameIndex / job.fps + job.subframeOffsets[k]!);
          await page.evaluate((time) => (window as unknown as FvWindow).__fv.seek(time), t);
          await job.beforeSample!(t);
          await page.evaluate(
            (sub, encodeFrame) => (window as unknown as FvWindow).__fv.sample(sub, encodeFrame ?? undefined),
            k,
            k === last ? frameIndex : null,
          );
        }
      }
    }
    const pageStats = await page.evaluate(() => (window as unknown as FvWindow).__fv.end());
    const renderMs = performance.now() - r0;

    await mux.finish();
    mux = undefined;

    const probe = await probeVideo(staging, job.ffprobePath);
    if (probe.packets !== job.frames) throw new Error(`Encoded ${probe.packets} video packets, expected ${job.frames}.`);
    if (probe.width !== job.width || probe.height !== job.height) {
      throw new Error(`Output is ${probe.width}x${probe.height}, expected ${job.width}x${job.height}.`);
    }
    if (job.audio && !probe.audioCodec) throw new Error("The audio track is missing from the output.");
    await rename(staging, output);
    const { size } = await stat(output);
    return { output, bytes: size, renderMs: Math.round(renderMs), page: pageStats, probe };
  } finally {
    mux?.kill();
    await rm(staging, { force: true });
  }
}
