import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, CDPSession, Page } from "puppeteer-core";
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
import { buildIntervals, mergeRoutes, routeIntervals, sampleFrames, type CaptureRoute, type IntervalPlan } from "./planner.ts";

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
export async function openCapturePage(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number },
  options: { seedRandom?: boolean } = {},
): Promise<CapturePage> {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
  await page.evaluateOnNewDocument(pageBootstrap, { seedRandom: options.seedRandom ?? false });
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

/**
 * How DOM pages are captured: "auto" verifies sampled frames of every interval against native
 * screenshots and routes failing intervals to screenshot capture; "dom" trusts drawElementImage
 * everywhere; "screenshot" uses native screenshots for every frame.
 */
export type CapturePolicy = "auto" | "dom" | "screenshot";

export interface CaptureJob {
  page: Page;
  prepared: PagePrepareResult;
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
  capture?: CapturePolicy;
  /** Skip painting frames in which nothing visible changed (default true). */
  reusePaints?: boolean;
  /** Verification PSNR below which an interval is routed to screenshots (default 30 dB). */
  verifyThresholdDb?: number;
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
  onLog?: (message: string) => void;
}

export interface CaptureResult {
  output: string;
  bytes: number;
  renderMs: number;
  page: PageRenderStats;
  /** Node-driven frames: time in seek round trips, the beforeSample hook, and sample round trips. */
  nodeLoop: { frames: number; seekMs: number; hookMs: number; sampleMs: number; verifyMs: number };
  probe: VideoProbe;
  /** DOM capture: the route of every interval and its verification samples. */
  plan: IntervalPlan[];
  /** Frames captured through native screenshots. */
  screenshotFrames: number;
}

export interface FrameSegment {
  start: number;
  count: number;
  /** Driven from Node so `beforeSample` runs between seek and paint. */
  hooked: boolean;
  route: CaptureRoute;
}

/**
 * Split the frame range into runs that share a capture route and either need the `beforeSample`
 * hook or can loop inside the page. A frame after a hooked one stays hooked, so the hook sees the
 * moment its work ends (an injected video frame must be hidden again). Screenshot runs are always
 * driven from Node.
 */
export function planSegments(
  job: Pick<CaptureJob, "startFrame" | "frames" | "fps" | "subframeOffsets" | "beforeSample" | "needsBeforeSample">,
  routeOf: (frame: number) => CaptureRoute = () => "dom",
): FrameSegment[] {
  const needs = job.beforeSample ? (job.needsBeforeSample ?? (() => true)) : () => false;
  const segments: FrameSegment[] = [];
  let previousNeeded = false;
  for (let i = 0; i < job.frames; i++) {
    const frameIndex = job.startFrame + i;
    const route = routeOf(frameIndex);
    const needed = job.subframeOffsets.some((offset) => needs(Math.max(0, frameIndex / job.fps + offset)));
    const hooked = route === "screenshot" || (Boolean(job.beforeSample) && (needed || previousNeeded || i === 0));
    previousNeeded = needed;
    const tail = segments.at(-1);
    if (tail && tail.hooked === hooked && tail.route === route) tail.count++;
    else segments.push({ start: frameIndex, count: 1, hooked, route });
  }
  return segments;
}

/**
 * Encode `frames` frames from a prepared page into `job.output`. The file is written next to its
 * destination under a temporary name, verified with ffprobe, then renamed; a failure leaves nothing.
 */
export async function captureToFile(job: CaptureJob): Promise<CaptureResult> {
  const { page, prepared } = job;
  const log = job.onLog ?? (() => {});
  const output = path.resolve(job.output);
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.${randomBytes(4).toString("hex")}.partial.mp4`);
  const fv = {
    seek: (t: number, quiet = false) => page.evaluate((time, q) => (window as unknown as FvWindow).__fv.seek(time, q), t, quiet),
    setRoute: (route: CaptureRoute) => page.evaluate((r) => (window as unknown as FvWindow).__fv.setRoute(r), route),
  };
  let cdp: CDPSession | undefined;
  const screenshot = async (): Promise<string> => {
    await page.evaluate(() => (window as unknown as FvWindow).__fv.composite());
    cdp ??= await page.createCDPSession();
    const rect = await page.evaluate(() => (window as unknown as FvWindow).__fv.targetRect());
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 95,
      optimizeForSpeed: true,
      clip: { ...rect, scale: job.width / rect.width },
    });
    return data;
  };
  // Verification seeks are administrative: quiet, so timeline callbacks fire only during the render.
  const quietSeekAndHook = async (t: number) => {
    await fv.seek(t, true);
    if (job.beforeSample && (job.needsBeforeSample?.(t) ?? true)) {
      await job.beforeSample(t);
      await page.evaluate(() => (window as unknown as FvWindow).__fv.settle());
    }
  };

  const audioEncoder = job.audio ? (job.audio.copy ? "copy" : await detectAacEncoder(job.ffmpegPath)) : undefined;
  let mux: MuxProcess | undefined = startMux(
    buildMuxArgs({
      codec: job.codec,
      fps: job.fps,
      output: staging,
      ...(job.audio ? { audio: path.resolve(job.audio.path), audioOffset: job.audio.offset, videoSeconds: job.frames / job.fps } : {}),
      ...(audioEncoder ? { audioEncoder } : {}),
    }),
    job.ffmpegPath,
  );
  try {
    const activeMux = mux;
    const streamDump = process.env.FRAMEVELO_DUMP_STREAM;
    if (streamDump) await writeFile(streamDump, "");
    await page.exposeFunction("__fvChunk", async (base64: string) => {
      const bytes = Buffer.from(base64, "base64");
      if (streamDump) await appendFile(streamDump, bytes);
      await activeMux.write(bytes);
    });
    await page.exposeFunction("__fvProgress", (done: number) => job.onProgress?.(done, job.frames));

    const encodeOptions: PageEncodeOptions = {
      width: job.width,
      height: job.height,
      fps: job.fps,
      codec: codecString(job.codec, job.width, job.height, job.fps),
      bitrate: job.bitrate,
      keyframeInterval: keyframeInterval(job.fps),
      subframes: job.subframeOffsets.length,
      reusePaints: job.reusePaints ?? true,
      hardwareAcceleration: "prefer-hardware",
      maxEncodeQueue: 4,
      chunkBytes: 2 << 20,
      paintTimeoutMs: job.paintTimeoutMs ?? 10_000,
      ...(job.background ? { background: job.background } : {}),
    };
    const r0 = performance.now();
    await page.evaluate((o) => (window as unknown as FvWindow).__fv.begin(o), encodeOptions);

    // ---- route planning (DOM capture) ----
    let plan: IntervalPlan[] = [];
    if (prepared.mode === "dom") {
      const policy: CapturePolicy = prepared.drawElementReady ? (job.capture ?? "auto") : "screenshot";
      const boundaries = await page.evaluate(() => (window as unknown as FvWindow).__fv.boundaries());
      const intervals = buildIntervals(job.startFrame, job.frames, job.fps, boundaries);
      if (policy === "auto" && prepared.hasEmbeddedDocuments) {
        // Verification moves the composition between routes, which reloads iframes.
        plan = intervals.map((interval) => ({ ...interval, route: "dom", samples: [], reason: "not verified: iframes reload when moved" }));
        log("verification skipped: the composition contains iframes, which reload when moved; using drawElementImage");
      } else if (policy === "auto") {
        const threshold = job.verifyThresholdDb ?? 30;
        const psnrByFrame = new Map<number, number>();
        for (const frame of new Set(intervals.flatMap(sampleFrames))) {
          const t = frame / job.fps;
          await quietSeekAndHook(t);
          await page.evaluate(() => (window as unknown as FvWindow).__fv.paintOnly());
          // Moving the composition out of the capture canvas restarts CSS animations: seek again.
          await fv.setRoute("screenshot");
          await quietSeekAndHook(t);
          const shot = await screenshot();
          const psnr = await page.evaluate((b64) => (window as unknown as FvWindow).__fv.compareScreenshot(b64), shot);
          psnrByFrame.set(frame, psnr);
          if (process.env.FRAMEVELO_VERIFY_DUMP) {
            const dir = process.env.FRAMEVELO_VERIFY_DUMP;
            const drawn = await page.evaluate(() => (window as unknown as FvWindow).__fv.captureDataUrl());
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, `frame${frame}-drawelement.png`), Buffer.from(drawn.slice(drawn.indexOf(",") + 1), "base64"));
            await writeFile(path.join(dir, `frame${frame}-screenshot-${psnr.toFixed(1)}dB.jpg`), Buffer.from(shot, "base64"));
          }
          await fv.setRoute("dom");
        }
        plan = routeIntervals(intervals, psnrByFrame, threshold);
        const failed = plan.filter((p) => p.route === "screenshot");
        if (failed.length) {
          log(`verification: ${failed.length}/${plan.length} interval(s) use screenshot capture (${failed.map((p) => `${(p.start / job.fps).toFixed(2)}-${(p.end / job.fps).toFixed(2)}s: ${p.reason}`).join("; ")})`);
        }
      } else {
        const route: CaptureRoute = policy === "dom" ? "dom" : "screenshot";
        plan = intervals.map((interval) => ({ ...interval, route, samples: [], reason: `--capture ${policy}` }));
        if (!prepared.drawElementReady && job.capture === "dom") log("drawElementImage is unavailable; using screenshot capture");
      }
    }
    const planningMs = performance.now() - r0;
    const routes = mergeRoutes(plan);
    const routeOf = (frame: number): CaptureRoute => routes.find((r) => frame >= r.start && frame < r.end)?.route ?? "dom";

    // ---- frame loop ----
    // Park the playhead just before the first frame without firing callbacks, so the render's own
    // seeks replay the timeline's side effects in order from the start.
    await fv.seek(Math.max(0, (job.startFrame - 1) / job.fps), true);
    let screenshotFrames = 0;
    const last = job.subframeOffsets.length - 1;
    const blurred = last > 0;
    const loop = { frames: 0, seekMs: 0, hookMs: 0, sampleMs: 0, verifyMs: Math.round(planningMs) };
    const timed = async <T>(key: "seekMs" | "hookMs" | "sampleMs", work: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      try {
        return await work();
      } finally {
        loop[key] += performance.now() - t;
      }
    };
    for (const segment of planSegments(job, routeOf)) {
      if (prepared.mode === "dom") await fv.setRoute(segment.route);
      if (!segment.hooked) {
        await page.evaluate(
          (start, count, offsets) => (window as unknown as FvWindow).__fv.run(start, count, offsets),
          segment.start,
          segment.count,
          job.subframeOffsets,
        );
        continue;
      }
      for (let frameIndex = segment.start; frameIndex < segment.start + segment.count; frameIndex++) {
        const frameTime = frameIndex / job.fps;
        loop.frames++;
        await timed("seekMs", () => fv.seek(frameTime));
        for (let k = 0; k <= last; k++) {
          const t = Math.max(0, frameTime + job.subframeOffsets[k]!);
          if (blurred) await timed("seekMs", () => fv.seek(t, true));
          if (job.beforeSample) {
            await timed("hookMs", async () => {
              await job.beforeSample!(t);
              // Injected frames swap <img> sources; let them reach the paint record first.
              if (segment.route === "dom") await page.evaluate(() => (window as unknown as FvWindow).__fv.settle());
            });
          }
          const encodeFrame = k === last ? frameIndex : null;
          if (segment.route === "screenshot") {
            await timed("sampleMs", async () => {
              const shot = await screenshot();
              await page.evaluate(
                (b64, sub, frame) => (window as unknown as FvWindow).__fv.sampleScreenshot(b64, sub, frame ?? undefined),
                shot,
                k,
                encodeFrame,
              );
            });
          } else {
            await timed("sampleMs", () =>
              page.evaluate((sub, frame) => (window as unknown as FvWindow).__fv.sample(sub, frame ?? undefined), k, encodeFrame),
            );
          }
        }
        if (blurred) await timed("seekMs", () => fv.seek(frameTime, true));
        if (segment.route === "screenshot") screenshotFrames++;
      }
    }
    const pageStats = await page.evaluate(() => (window as unknown as FvWindow).__fv.end());
    const renderMs = performance.now() - r0;

    await mux.finish();
    mux = undefined;

    const probe = await probeVideo(staging, job.ffprobePath);
    if (probe.packets !== job.frames) {
      throw new Error(
        `Muxed ${probe.packets} video packets from ${pageStats.frames} frames (${pageStats.chunks} encoder chunks, ${pageStats.emptyChunks} empty); expected ${job.frames}.`,
      );
    }
    if (probe.width !== job.width || probe.height !== job.height) {
      throw new Error(`Output is ${probe.width}x${probe.height}, expected ${job.width}x${job.height}.`);
    }
    if (job.audio && !probe.audioCodec) throw new Error("The audio track is missing from the output.");
    await rename(staging, output);
    const { size } = await stat(output);
    const nodeLoop = {
      frames: loop.frames,
      seekMs: Math.round(loop.seekMs),
      hookMs: Math.round(loop.hookMs),
      sampleMs: Math.round(loop.sampleMs),
      verifyMs: loop.verifyMs,
    };
    return { output, bytes: size, renderMs: Math.round(renderMs), page: pageStats, probe, plan, screenshotFrames, nodeLoop };
  } finally {
    mux?.kill();
    await cdp?.detach().catch(() => {});
    await rm(staging, { force: true });
  }
}
