import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
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
  options: {
    seedRandom?: boolean;
    ownWindow?: boolean;
    /** Runs before navigation, e.g. to add scripts that must run before the page's own. */
    beforeLoad?: (page: Page) => Promise<void>;
    /** Runs once the page and the FrameVelo runtime are loaded, before preparation. */
    afterLoad?: (page: Page) => Promise<void>;
  } = {},
): Promise<CapturePage> {
  // Full Chrome keeps its tabs in one window and paints only the front one: a capture page that is
  // not in front would never paint. Each page gets a window of its own there.
  const page = await browser.newPage(options.ownWindow ? { type: "window" } : undefined);
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
  await page.evaluateOnNewDocument(pageBootstrap, { seedRandom: options.seedRandom ?? false });
  await options.beforeLoad?.(page);
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(pageInstallRuntime);
  await options.afterLoad?.(page);
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
  /**
   * Pages for frames driven from Node (video injection, screenshots), which are bound by latency
   * rather than GPU throughput: the range is split into this many contiguous chunks rendered
   * concurrently, each by its own page and encoder (default 1).
   */
  workers?: number;
  /** Open and prepare another page on the same composition, with its own `beforeSample`. */
  openWorker?: () => Promise<CaptureWorker>;
  /** Called once every page the render uses is open, so pages opened ahead of time can be closed. */
  pagesReady?: () => void;
  /** Called with each page once it has rendered its range, before it closes. */
  afterRange?: (page: Page) => Promise<void>;
  paintTimeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  onLog?: (message: string) => void;
}

export interface CaptureWorker {
  page: Page;
  beforeSample?: (time: number) => Promise<void>;
  close(): Promise<void>;
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
  /** Pages that rendered the frames (1 unless Node-driven frames were split across workers). */
  workers: number;
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

/** Split [start, start + frames) into `parts` contiguous ranges of nearly equal length. */
export function splitRange(start: number, frames: number, parts: number): Array<{ start: number; frames: number }> {
  const ranges: Array<{ start: number; frames: number }> = [];
  for (let i = 0; i < parts; i++) {
    const a = start + Math.round((frames * i) / parts);
    const b = start + Math.round((frames * (i + 1)) / parts);
    if (b > a) ranges.push({ start: a, frames: b - a });
  }
  return ranges;
}

/** Sum the stats of pages that rendered parts of one output. */
function mergeStats(all: PageRenderStats[]): PageRenderStats {
  const sum = (key: keyof PageRenderStats) => all.reduce((n, s) => n + (Number(s[key]) || 0), 0);
  const reasons = all.map((s) => s.reuseDisabledReason).filter(Boolean);
  return {
    ...all[0]!,
    frames: sum("frames"),
    hardwareFallback: all.some((s) => s.hardwareFallback),
    seekMs: sum("seekMs"),
    paintMs: sum("paintMs"),
    encodeWaitMs: sum("encodeWaitMs"),
    transferWaitMs: sum("transferWaitMs"),
    reusedPaints: sum("reusedPaints"),
    chunks: sum("chunks"),
    emptyChunks: sum("emptyChunks"),
    ...(reasons.length ? { reuseDisabledReason: reasons[0]! } : {}),
  };
}

const SCREENSHOT_TIMEOUT_MS = 60_000;

/**
 * One screenshot at a time across pages. Chrome largely serializes screenshot work anyway (two pages
 * gain about 6%), and on the macOS CI runner two pages capturing at once sometimes never got a
 * screenshot back.
 */
let screenshotTurn: Promise<unknown> = Promise.resolve();
function oneScreenshotAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = screenshotTurn.then(work, work);
  screenshotTurn = run.catch(() => {});
  return run;
}

/** `work`, or a rejection with `message` after `ms`. */
function withTimeout<T>(ms: number, message: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Node-side handles for driving one capture page. */
function pageDriver(page: Page, width: number) {
  let cdp: CDPSession | undefined;
  return {
    page,
    seek: (t: number, quiet = false) => page.evaluate((time, q) => (window as unknown as FvWindow).__fv.seek(time, q), t, quiet),
    setRoute: (route: CaptureRoute) => page.evaluate((r) => (window as unknown as FvWindow).__fv.setRoute(r), route),
    settle: () => page.evaluate(() => (window as unknown as FvWindow).__fv.settle()),
    // `shotWidth` is the pixel width of the shot: the output width for frames, the element's own CSS
    // width (null) for verification. A shot scaled below 1x is rasterized at that lower scale, and
    // its edges differ from a downscaled full-size paint: verification would fail on sharp content.
    async screenshot(shotWidth: number | null = width): Promise<string> {
      await page.evaluate(() => (window as unknown as FvWindow).__fv.composite());
      const rect = await page.evaluate(() => (window as unknown as FvWindow).__fv.targetRect());
      const shoot = async () => {
        cdp ??= await page.createCDPSession();
        // Protocol calls have no timeout (renders are long): a screenshot that never comes must fail.
        const { data } = await withTimeout(
          SCREENSHOT_TIMEOUT_MS,
          "Chrome returned no screenshot within 60 s.",
          cdp.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 95,
            optimizeForSpeed: true,
            clip: { ...rect, scale: shotWidth === null ? 1 : shotWidth / rect.width },
          }),
        );
        return data;
      };
      try {
        return await oneScreenshotAtATime(shoot);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Chrome returned no screenshot")) throw error;
        // Once more, on a fresh protocol session.
        await cdp?.detach().catch(() => {});
        cdp = undefined;
        return oneScreenshotAtATime(shoot);
      }
    },
    detach: () => cdp?.detach().catch(() => {}),
  };
}
type PageDriver = ReturnType<typeof pageDriver>;

/** Node-driven frames that justify one more page. */
const FRAMES_PER_WORKER = 200;

/** One page rendering part of the output, with its own encoder and sample hook. */
interface Lane {
  driver: PageDriver;
  hook: ((time: number) => Promise<void>) | undefined;
  /** Annex-B file the lane's encoder writes when the range is split; the main lane starts on the muxer. */
  part?: string;
  /** The page took verification samples, so its timeline was seeked out of order. */
  verified?: boolean;
}

/**
 * Encode `frames` frames from a prepared page into `job.output`. The file is written next to its
 * destination under a temporary name, verified with ffprobe, then renamed; a failure leaves nothing.
 */
export async function captureToFile(job: CaptureJob): Promise<CaptureResult> {
  const { prepared } = job;
  const log = job.onLog ?? (() => {});
  const output = path.resolve(job.output);
  const tag = randomBytes(4).toString("hex");
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.${tag}.partial.mp4`);
  const partFile = (i: number) => path.join(path.dirname(output), `.${path.basename(output)}.${tag}.part${i}.h264`);
  const main: Lane = { driver: pageDriver(job.page, job.width), hook: job.beforeSample };
  const opening: Array<Promise<Lane | null>> = [];
  const workers: CaptureWorker[] = [];
  const rendering: Lane[] = [];
  const files: string[] = [];

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
    const progress: number[] = [];
    const attach = async (page: Page, index: number, sink: (bytes: Buffer) => Promise<void>) => {
      await page.exposeFunction("__fvChunk", (base64: string) => sink(Buffer.from(base64, "base64")));
      await page.exposeFunction("__fvProgress", (done: number) => {
        progress[index] = done;
        job.onProgress?.(progress.reduce((a, b) => a + (b ?? 0), 0), job.frames);
      });
    };
    // Encoded bytes go to the muxer while one page renders everything, to a part file per page
    // when the range is split.
    const firstLaneSink = (lane: Lane) => async (bytes: Buffer) => {
      if (lane.part) return appendFile(lane.part, bytes);
      if (streamDump) await appendFile(streamDump, bytes);
      await activeMux.write(bytes);
    };
    await attach(job.page, 0, firstLaneSink(main));

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
    const begin = (page: Page) => page.evaluate((o) => (window as unknown as FvWindow).__fv.begin(o), encodeOptions);

    // Workers pay off for frames driven from Node through the page (video injection): each waits
    // on round trips, not on the GPU. Screenshot frames do not count: Chrome serializes screenshot
    // work, so a second page gained about 6% there. Workers open while the main page verifies when
    // the frames are known up front, and take a share of the verification too.
    // A page costs about a second to open and a few hundred MB: one per FRAMES_PER_WORKER frames.
    const nodeDriven = (routeOf: (frame: number) => CaptureRoute) =>
      planSegments(job, routeOf).reduce((n, segment) => n + (segment.hooked && segment.route === "dom" ? segment.count : 0), 0);
    const laneCount = (driven: number) =>
      job.openWorker ? Math.max(1, Math.min(job.workers ?? 1, Math.floor(driven / FRAMES_PER_WORKER))) : 1;
    const openLanes = (count: number) => {
      for (let i = 1; i < count; i++) {
        opening.push(
          (async (): Promise<Lane> => {
            const worker = await job.openWorker!();
            workers.push(worker);
            const lane: Lane = { driver: pageDriver(worker.page, job.width), hook: worker.beforeSample, part: partFile(i) };
            files.push(lane.part!);
            await writeFile(lane.part!, "");
            await attach(worker.page, i, (bytes) => appendFile(lane.part!, bytes));
            await begin(worker.page);
            return lane;
          })().catch((error: unknown) => {
            log(`worker page ${i} failed to open (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); continuing without it`);
            return null;
          }),
        );
      }
    };
    const presumedRoute: CaptureRoute =
      prepared.mode === "dom" && (!prepared.drawElementReady || job.capture === "screenshot") ? "screenshot" : "dom";
    openLanes(laneCount(nodeDriven(() => presumedRoute)));

    const r0 = performance.now();
    await begin(job.page);

    // ---- route planning (DOM capture) ----
    const plan = await planRoutes(job, main, opening, log);
    const planningMs = performance.now() - r0;
    const routes = mergeRoutes(plan);
    const routeOf = (frame: number): CaptureRoute => routes.find((r) => frame >= r.start && frame < r.end)?.route ?? "dom";
    // Verification can turn intervals over to screenshots, which are Node-driven too.
    const driven = nodeDriven(routeOf);
    if (opening.length === 0) openLanes(laneCount(driven));
    const lanes = [main, ...(await Promise.all(opening)).filter((lane): lane is Lane => lane !== null)];
    // Verification seeks the timeline out of order, quietly. Whatever a timeline callback wrote into
    // the page (a GSAP onUpdate that sets a transform) is left at the last verified moment, and a
    // quiet park before the first frame cannot bring it back; the official renderer never seeks
    // backwards. Lanes that verified hand their range to fresh pages.
    if (job.openWorker && lanes.some((lane) => lane.verified)) {
      const f0 = performance.now();
      let replaced = 0;
      await Promise.all(
        lanes.map(async (lane, i) => {
          if (!lane.verified) return;
          const worker = await job.openWorker!();
          workers.push(worker);
          const next: Lane = { driver: pageDriver(worker.page, job.width), hook: worker.beforeSample, ...(lane.part ? { part: lane.part } : {}) };
          await attach(worker.page, i, i === 0 ? firstLaneSink(next) : (bytes) => appendFile(next.part!, bytes));
          await begin(worker.page);
          // Close the verified page: left open, it holds a second copy of the composition (about
          // 170 MB on a 1080p DOM page) for the whole render.
          await lane.driver.detach();
          if (lane === main) await job.page.close().catch(() => {});
          else await workers.find((w) => w.page === lane.driver.page)?.close().catch(() => {});
          lanes[i] = next;
          replaced++;
        }),
      );
      log(`verified pages replaced by ${replaced} fresh page${replaced === 1 ? "" : "s"} (${Math.round(performance.now() - f0)} ms)`);
    }
    rendering.push(...lanes);
    job.pagesReady?.();
    const ranges = splitRange(job.startFrame, job.frames, lanes.length);
    if (lanes.length > 1) {
      const first = lanes[0]!;
      first.part = partFile(0);
      files.push(first.part);
      await writeFile(first.part, "");
      log(`${lanes.length} pages render ${driven} Node-driven frames in parallel`);
    }

    // ---- frame loop ----
    const loop = { frames: 0, seekMs: 0, hookMs: 0, sampleMs: 0, verifyMs: Math.round(planningMs) };
    let screenshotFrames = 0;
    const stats = await Promise.all(
      ranges.map(async (range, i) => {
        const lane = lanes[i]!;
        // Park the playhead before the first frame without firing callbacks; a later range then
        // replays the timeline's side effects up to its start, so every range sees the state a
        // sequential render would.
        await lane.driver.seek(Math.max(0, (job.startFrame - 1) / job.fps), true);
        if (range.start > job.startFrame) await lane.driver.seek((range.start - 1) / job.fps);
        const result = await renderRange(job, lane, range, routeOf, loop);
        screenshotFrames += result.screenshotFrames;
        const stats = await lane.driver.page.evaluate(() => (window as unknown as FvWindow).__fv.end());
        await job.afterRange?.(lane.driver.page);
        return stats;
      }),
    );
    const pageStats = mergeStats(stats);
    const renderMs = performance.now() - r0;

    // Every range starts on a keyframe with in-band parameter sets: the parts concatenate byte-wise.
    if (lanes.length > 1) {
      for (const lane of lanes) {
        for await (const chunk of createReadStream(lane.part!)) {
          if (streamDump) await appendFile(streamDump, chunk as Buffer);
          await mux.write(chunk as Buffer);
        }
      }
    }
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
    return {
      output,
      bytes: size,
      renderMs: Math.round(renderMs),
      page: pageStats,
      probe,
      plan,
      screenshotFrames,
      nodeLoop,
      workers: lanes.length,
    };
  } finally {
    mux?.kill();
    // Let lanes still opening settle so their pages close too.
    const opened = await Promise.all(opening);
    await Promise.all([main, ...opened, ...rendering].map((lane) => lane?.driver.detach()));
    await Promise.all(workers.map((w) => w.close().catch(() => {})));
    await Promise.all([staging, ...files].map((file) => rm(file, { force: true })));
  }
}

/**
 * Verify sampled frames against native screenshots and route every interval (DOM capture). Samples
 * are shared out over the main page and any worker pages as they come up.
 */
async function planRoutes(
  job: CaptureJob,
  main: Lane,
  opening: Array<Promise<Lane | null>>,
  log: (message: string) => void,
): Promise<IntervalPlan[]> {
  const { prepared } = job;
  if (prepared.mode !== "dom") return [];
  const policy: CapturePolicy = prepared.drawElementReady ? (job.capture ?? "auto") : "screenshot";
  const boundaries = await job.page.evaluate(() => (window as unknown as FvWindow).__fv.boundaries());
  const intervals = buildIntervals(job.startFrame, job.frames, job.fps, boundaries, 4);
  if (policy === "auto" && prepared.hasEmbeddedDocuments) {
    // Verification moves the composition between routes, which reloads iframes.
    log("verification skipped: the composition contains iframes, which reload when moved; using drawElementImage");
    return intervals.map((interval) => ({ ...interval, route: "dom", samples: [], reason: "not verified: iframes reload when moved" }));
  }
  if (policy !== "auto") {
    const route: CaptureRoute = policy === "dom" ? "dom" : "screenshot";
    if (!prepared.drawElementReady && job.capture === "dom") log("drawElementImage is unavailable; using screenshot capture");
    return intervals.map((interval) => ({ ...interval, route, samples: [], reason: `--capture ${policy}` }));
  }
  const queue = [...new Set(intervals.flatMap(sampleFrames))];
  const psnrByFrame = new Map<number, number>();
  const verifyOn = async (lane: Lane) => {
    const { driver, hook } = lane;
    const { page } = driver;
    // Verification seeks are administrative: quiet, so timeline callbacks fire only during the render.
    const quietSeekAndHook = async (t: number) => {
      await driver.seek(t, true);
      if (hook && (job.needsBeforeSample?.(t) ?? true)) {
        await hook(t);
        await driver.settle();
      }
    };
    for (let frame = queue.shift(); frame !== undefined; frame = queue.shift()) {
      lane.verified = true;
      const t = frame / job.fps;
      await quietSeekAndHook(t);
      await page.evaluate(() => (window as unknown as FvWindow).__fv.paintOnly());
      // Moving the composition out of the capture canvas restarts CSS animations: seek again.
      await driver.setRoute("screenshot");
      await quietSeekAndHook(t);
      const shot = await driver.screenshot(null);
      const psnr = await page.evaluate((b64) => (window as unknown as FvWindow).__fv.compareScreenshot(b64), shot);
      psnrByFrame.set(frame, psnr);
      if (process.env.FRAMEVELO_VERIFY_DUMP) {
        const dir = process.env.FRAMEVELO_VERIFY_DUMP;
        const drawn = await page.evaluate(() => (window as unknown as FvWindow).__fv.captureDataUrl());
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `frame${frame}-drawelement.png`), Buffer.from(drawn.slice(drawn.indexOf(",") + 1), "base64"));
        await writeFile(path.join(dir, `frame${frame}-screenshot-${psnr.toFixed(1)}dB.jpg`), Buffer.from(shot, "base64"));
      }
      await driver.setRoute("dom");
    }
  };
  await Promise.all([verifyOn(main), ...opening.map((pending) => pending.then((lane) => lane && verifyOn(lane)))]);
  const plan = routeIntervals(intervals, psnrByFrame, job.verifyThresholdDb ?? 30);
  const failed = plan.filter((p) => p.route === "screenshot");
  if (failed.length) {
    const detail = failed.map((p) => `${(p.start / job.fps).toFixed(2)}-${(p.end / job.fps).toFixed(2)}s: ${p.reason}`).join("; ");
    log(`verification: ${failed.length}/${plan.length} interval(s) use screenshot capture (${detail})`);
  }
  return plan;
}

/** Render one contiguous frame range on one page: page-side loops where possible, Node-driven otherwise. */
async function renderRange(
  job: CaptureJob,
  { driver, hook: beforeSample }: Lane,
  range: { start: number; frames: number },
  routeOf: (frame: number) => CaptureRoute,
  loop: { frames: number; seekMs: number; hookMs: number; sampleMs: number },
): Promise<{ screenshotFrames: number }> {
  const { page } = driver;
  const timed = async <T>(key: "seekMs" | "hookMs" | "sampleMs", work: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await work();
    } finally {
      loop[key] += performance.now() - t;
    }
  };
  const last = job.subframeOffsets.length - 1;
  const blurred = last > 0;
  let screenshotFrames = 0;
  if (range.start > job.startFrame) {
    // Prime this encoder on the frame before the range (dropped), so the range's first keyframe
    // gets settled rate control rather than a cold start. The playhead is already there.
    const frame = range.start - 1;
    const route = routeOf(frame);
    if (job.prepared.mode === "dom") await driver.setRoute(route);
    if (beforeSample && (job.needsBeforeSample?.(frame / job.fps) ?? true)) await beforeSample(frame / job.fps);
    if (route === "screenshot") {
      const shot = await driver.screenshot();
      await page.evaluate((b64) => (window as unknown as FvWindow).__fv.sampleScreenshot(b64, 0), shot);
    } else {
      await page.evaluate((settle) => (window as unknown as FvWindow).__fv.sample(0, undefined, settle), Boolean(beforeSample));
    }
    await page.evaluate((f) => (window as unknown as FvWindow).__fv.encode(f, true), frame);
  }
  const { beforeSample: _, ...rest } = job;
  const segments = planSegments({ ...rest, startFrame: range.start, frames: range.frames, ...(beforeSample ? { beforeSample } : {}) }, routeOf);
  for (const segment of segments) {
    if (job.prepared.mode === "dom") await driver.setRoute(segment.route);
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
      await timed("seekMs", () => driver.seek(frameTime));
      for (let k = 0; k <= last; k++) {
        const t = Math.max(0, frameTime + job.subframeOffsets[k]!);
        if (blurred) await timed("seekMs", () => driver.seek(t, true));
        if (beforeSample) await timed("hookMs", () => beforeSample(t));
        const encodeFrame = k === last ? frameIndex : null;
        if (segment.route === "screenshot") {
          await timed("sampleMs", async () => {
            const shot = await driver.screenshot();
            await page.evaluate(
              (b64, sub, frame) => (window as unknown as FvWindow).__fv.sampleScreenshot(b64, sub, frame ?? undefined),
              shot,
              k,
              encodeFrame,
            );
          });
        } else {
          // Injected frames swap <img> sources: settle one rendering update inside the same call.
          await timed("sampleMs", () =>
            page.evaluate(
              (sub, frame, settle) => (window as unknown as FvWindow).__fv.sample(sub, frame ?? undefined, settle),
              k,
              encodeFrame,
              Boolean(beforeSample),
            ),
          );
        }
      }
      if (blurred) await timed("seekMs", () => driver.seek(frameTime, true));
      if (segment.route === "screenshot") screenshotFrames++;
    }
  }
  return { screenshotFrames };
}
