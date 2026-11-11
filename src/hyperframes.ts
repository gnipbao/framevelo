// Render HyperFrames projects with the official compiler, media pipeline and runtime, and FrameVelo
// capture and encoding. `@hyperframes/producer` (Apache-2.0) is an optional peer dependency:
//
//   planV2WithPublisher()    compile the project, probe its videos, mix the audio       (official)
//   extractVideoFramesRange  extract the video frames the rendered range shows          (official)
//   createFileServer         serve the compiled site with the HyperFrames runtime       (official)
//   window.__hf.seek         drive time: clips, sub-compositions, nested timelines      (official)
//   video injector           swap <video> elements for the extracted frame of each time (official)
//   drawElementImage → WebCodecs → stream-copy mux with the plan's audio              (FrameVelo)

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "puppeteer-core";

/** The HyperFrames release line FrameVelo is built against; older lines lack Plan v2. */
export const HYPERFRAMES_VERSION_RANGE = "0.9";

/**
 * Asks @hyperframes/shader-transitions to render transitions in the page (a WebGL overlay) instead
 * of leaving the blend to the official Node-side layered pipeline, which FrameVelo does not run.
 * Pages without shader transitions ignore it.
 */
export const PAGE_SIDE_COMPOSITING_FLAG = "window.__HF_PAGE_SIDE_COMPOSITING__ = true;";

/** Frame rates the HyperFrames planner accepts. */
export const HYPERFRAMES_PLAN_FPS = [24, 25, 30, 60] as const;

export function isHyperFramesHtml(html: string): boolean {
  return /<[^>]*\bdata-composition-id\s*=/i.test(html);
}

/** The supported planner frame rate closest to `fps`. */
export function planFps(fps: number): (typeof HYPERFRAMES_PLAN_FPS)[number] {
  return HYPERFRAMES_PLAN_FPS.reduce((best, candidate) => (Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best));
}

// The slices of the HyperFrames API FrameVelo uses, typed structurally so the peer dependency stays optional.
interface ProducerLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}
type PlanTarget = { role: "chunk"; chunkIndex: number } | { role: "assembler" };
interface DistributedApi {
  LocalPlanV2ArtifactPublisher: new (destinationDir: string) => object;
  planV2WithPublisher(
    projectDir: string,
    config: {
      fps: number;
      width: number;
      height: number;
      format: "mp4";
      maxParallelChunks?: number;
      logger?: ProducerLogger;
      abortSignal?: AbortSignal;
    },
    publisher: object,
    options?: { stagingParentDir?: string },
  ): Promise<{ totalFrames: number; producerVersion: string }>;
  materializePlanV2Target(planV2Dir: string, target: PlanTarget, destinationDir: string): { planDir: string; audioPath: string | null };
}
interface ProducerApi {
  createFileServer(options: {
    projectDir: string;
    compiledDir?: string;
    port?: number;
    preHeadScripts?: string[];
    fps?: { num: number; den: number };
  }): Promise<{ url: string; close(): void }>;
  createVideoFrameInjector(
    lookup: unknown,
    options?: { frameSrcResolver?: (framePath: string) => string | null },
  ): ((page: Page, time: number) => Promise<void>) | null;
}
/** A window of a source video, extracted at render time for the frames it shows. */
export interface DeferredFrameRange {
  sourcePath: string;
  startTime: number;
  durationSeconds: number;
  format: "jpg" | "png";
}
/** The engine's `ExtractedFrames`: one video's frames, by frame index of its window. */
export interface ExtractedFrames {
  videoId: string;
  srcPath: string;
  outputDir: string;
  framePattern: string;
  fps: number;
  totalFrames: number;
  metadata: unknown;
  framePaths: Map<number, string>;
  deferredRange?: DeferredFrameRange;
  ownedByLookup?: boolean;
}
export interface FrameRange {
  firstFrame: number;
  frames: number;
}
interface FrameLookupTable {
  getActiveFramePayloads(globalTime: number): Map<string, { frameIndex: number }>;
}
interface EngineApi {
  createFrameLookupTable(videos: unknown[], extracted: ExtractedFrames[], fps?: number): FrameLookupTable;
  extractVideoFramesRange(
    videoPath: string,
    videoId: string,
    startTime: number,
    duration: number,
    options: { fps: { num: number; den: number }; outputDir: string; format?: "jpg" | "png"; frameRanges?: FrameRange[] },
    signal?: AbortSignal,
  ): Promise<{ framePaths: Map<number, string> }>;
  mediaIdPathSegment(id: string): string;
}
export interface HyperFramesApi {
  distributed: DistributedApi;
  producer: ProducerApi;
  engine: EngineApi;
  version: string;
}

function installHint(): string {
  return (
    "Install it where FrameVelo is installed, for example:\n" +
    `  npm install -g @hyperframes/producer@${HYPERFRAMES_VERSION_RANGE} @hyperframes/engine@${HYPERFRAMES_VERSION_RANGE}\n` +
    "or pass --no-hyperframes to render the page as a plain seekable HTML file."
  );
}

/** Load the optional HyperFrames packages, with an actionable error when they are missing. */
export async function loadHyperFrames(): Promise<HyperFramesApi> {
  let modules: [unknown, unknown, unknown];
  try {
    modules = await Promise.all([
      import("@hyperframes/producer/distributed" as string),
      import("@hyperframes/producer" as string),
      import("@hyperframes/engine" as string),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Rendering a HyperFrames project needs the official compiler and runtime from @hyperframes/producer.\n${installHint()}\n(${reason})`,
    );
  }
  const [distributed, producer, engine] = modules as [DistributedApi, ProducerApi, EngineApi];
  let version = "unknown";
  try {
    const pkgUrl = import.meta.resolve("@hyperframes/producer").replace(/\/dist\/index\.js$/, "/package.json");
    version = (JSON.parse(readFileSync(new URL(pkgUrl), "utf8")) as { version: string }).version;
  } catch {
    // The version is informational only.
  }
  if (typeof distributed.planV2WithPublisher !== "function" || typeof engine.extractVideoFramesRange !== "function") {
    throw new Error(`FrameVelo needs @hyperframes/producer and @hyperframes/engine ${HYPERFRAMES_VERSION_RANGE}; found ${version}.\n${installHint()}`);
  }
  return { distributed, producer, engine, version };
}

interface PlanVideosJson {
  videos: unknown[];
  extracted: Array<Omit<ExtractedFrames, "outputDir" | "framePaths" | "ownedByLookup">>;
}

/** The videos of a plan: frames the plan extracted, and windows it left for the render to extract. */
export interface PlanVideos {
  videos: unknown[];
  /** Short windows the plan extracted, keyed by the frame numbers in their file names. */
  extracted: ExtractedFrames[];
  /** Long constant-rate windows, extracted by {@link extractShownVideoFrames} for the frames a render shows. */
  deferred: ExtractedFrames[];
}

function frameNumber(name: string): number | null {
  const match = /(\d+)(?=\.[^.]+$)/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Read the videos of a materialized Plan v2 directory. Frames the plan extracted sit in
 * `framesDir/<segment(videoId)>/`, numbered from 1 by their frame index in the video's window.
 */
export function readPlanVideos(
  planDir: string,
  framesDir = path.join(planDir, "video-frames"),
  segment: (videoId: string) => string = (id) => id,
): PlanVideos | null {
  const metaPath = path.join(planDir, "meta", "videos.json");
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PlanVideosJson;
  if (!meta.extracted?.length) return null;
  const extracted: ExtractedFrames[] = [];
  const deferred: ExtractedFrames[] = [];
  for (const video of meta.extracted) {
    const outputDir = path.join(framesDir, segment(video.videoId));
    // The plan directory is ours to delete; the lookup must not clean it up.
    const entry = { ...video, outputDir, framePaths: new Map<number, string>(), ownedByLookup: false };
    if (video.deferredRange) {
      deferred.push(entry);
      continue;
    }
    if (!existsSync(outputDir)) throw new Error(`The HyperFrames plan has no extracted frames for video "${video.videoId}".`);
    const ext = (path.extname(video.framePattern) || ".jpg").toLowerCase();
    const files = readdirSync(outputDir)
      .filter((name) => name.toLowerCase().endsWith(ext))
      .sort((a, b) => (frameNumber(a) ?? 0) - (frameNumber(b) ?? 0) || a.localeCompare(b));
    files.forEach((name, i) => {
      const number = frameNumber(name);
      entry.framePaths.set(number === null ? i : number - 1, path.join(outputDir, name));
    });
    extracted.push(entry);
  }
  return { videos: meta.videos, extracted, deferred };
}

/**
 * Sorted frame indexes as the runs an extraction takes. Each run is an FFmpeg process that seeks to a
 * keyframe and decodes from there, so runs closer than `maxGap` frames merge: a sped-up video shows
 * every few frames, and one run per shown frame cost a 4 s clip 6 s of extraction.
 */
export function contiguousRuns(sortedIndexes: Iterable<number>, maxGap = 0): FrameRange[] {
  const runs: FrameRange[] = [];
  for (const index of sortedIndexes) {
    const last = runs.at(-1);
    const gap = last ? index - (last.firstFrame + last.frames) : Infinity;
    if (last && gap <= maxGap) last.frames += gap + 1;
    else runs.push({ firstFrame: index, frames: 1 });
  }
  return runs;
}

/**
 * Extract the frames of deferred videos that the render shows at `times`, as the official chunk
 * renderer does for its frames (`extractDeferredFrames` in @hyperframes/producer), and return every
 * video's frames for the lookup table. Times beyond the official frame grid (sub-frames, other
 * frame rates) are fine: the lookup that picks the frames here is the one the injector uses.
 */
export async function extractShownVideoFrames(
  engine: EngineApi,
  plan: PlanVideos & { planDir: string; framesDir: string; fps: number },
  times: Iterable<number>,
  signal?: AbortSignal,
): Promise<ExtractedFrames[]> {
  if (plan.deferred.length === 0) return plan.extracted;
  const table = engine.createFrameLookupTable(
    plan.videos,
    plan.deferred.map((video) => ({ ...video, framePaths: new Map(Array.from({ length: video.totalFrames }, (_, i) => [i, String(i)])) })),
    plan.fps,
  );
  const shown = new Map<string, Set<number>>();
  for (const time of times) {
    for (const [videoId, payload] of table.getActiveFramePayloads(time)) {
      const indexes = shown.get(videoId) ?? new Set<number>();
      indexes.add(payload.frameIndex);
      shown.set(videoId, indexes);
    }
  }
  const filled = await Promise.all(
    plan.deferred.map(async (video) => {
      const indexes = [...(shown.get(video.videoId) ?? [])].sort((a, b) => a - b);
      const range = video.deferredRange!;
      if (indexes.length === 0) return video;
      const extracted = await engine.extractVideoFramesRange(
        path.join(plan.planDir, ...range.sourcePath.split("/")),
        video.videoId,
        range.startTime,
        range.durationSeconds,
        { fps: { num: plan.fps, den: 1 }, outputDir: plan.framesDir, format: range.format, frameRanges: contiguousRuns(indexes, plan.fps) },
        signal,
      );
      const missing = indexes.find((index) => !extracted.framePaths.has(index));
      if (missing !== undefined) {
        throw new Error(`HyperFrames video "${video.videoId}" has no frame ${missing}; the plan expected ${video.totalFrames} frames from ${range.sourcePath}.`);
      }
      return { ...video, framePaths: extracted.framePaths };
    }),
  );
  return [...plan.extracted, ...filled];
}

/**
 * Run `fn` with console output captured: warnings and errors go to `log`, the rest is dropped.
 * Only for in-process library calls that print instead of taking a logger.
 */
export async function withConsoleRoutedTo<T>(log: (message: string) => void, fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const format = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");
  const forward = (...args: unknown[]) => {
    const message = format(args);
    if (/^\[(INFO|DEBUG)\]/.test(message)) return;
    log(`hyperframes: ${message.replace(/^\[(WARN|ERROR)\]\s*/, "")}`);
  };
  console.log = console.info = console.debug = () => {};
  console.warn = console.error = forward;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Directory inside the served site that holds the video frames. */
export const SERVED_FRAMES_DIR = "__fv_video_frames";

export interface HyperFramesSite {
  url: string;
  planDir: string;
  totalFrames: number;
  planFps: number;
  audioPath: string | null;
  videos: PlanVideos | null;
  /** Every video's frames for the lookup table, extracting the deferred ones shown at `times`. */
  videoFrames(times: Iterable<number>, signal?: AbortSignal): Promise<ExtractedFrames[]>;
  /**
   * Same-origin URL of an extracted frame. The page loads frames over HTTP instead of receiving
   * base64 data URIs through the DevTools protocol; same origin keeps the capture canvas untainted.
   */
  frameUrl(framePath: string): string | null;
  producerVersion: string;
  close(): Promise<void>;
}

/** Compile a project with the official planner and serve the result with the HyperFrames runtime. */
export async function prepareHyperFramesSite(
  api: HyperFramesApi,
  options: {
    projectDir: string;
    width: number;
    height: number;
    fps: number;
    preHeadScripts: string[];
    onLog?: (message: string) => void;
    signal?: AbortSignal;
  },
): Promise<HyperFramesSite> {
  const log = options.onLog ?? (() => {});
  const logger: ProducerLogger = {
    error: (message) => log(`hyperframes: ${message}`),
    warn: (message) => log(`hyperframes: ${message}`),
    info: () => {},
    debug: () => {},
  };
  const workDir = await mkdtemp(path.join(os.tmpdir(), "framevelo-plan-"));
  try {
    const fps = planFps(options.fps);
    const store = path.join(workDir, "store");
    // Parts of the compiler log straight to the console; route them through onLog. One chunk: its
    // materialized directory holds the whole site, the plan's video frames and every deferred source.
    const plan = await withConsoleRoutedTo(log, () =>
      api.distributed.planV2WithPublisher(
        options.projectDir,
        {
          fps,
          width: options.width,
          height: options.height,
          format: "mp4",
          maxParallelChunks: 1,
          logger,
          ...(options.signal ? { abortSignal: options.signal } : {}),
        },
        new api.distributed.LocalPlanV2ArtifactPublisher(store),
        { stagingParentDir: workDir },
      ),
    );
    const { planDir } = api.distributed.materializePlanV2Target(store, { role: "chunk", chunkIndex: 0 }, path.join(workDir, "chunk"));
    // The assembler's audio is the delivery mix: cut to the frame count and held to the official
    // −1 dBTP AAC true peak, so it goes straight into the output.
    const { audioPath } = api.distributed.materializePlanV2Target(store, { role: "assembler" }, path.join(workDir, "assembler"));
    await rm(store, { recursive: true, force: true });
    const compiledDir = path.join(planDir, "compiled");
    // Serve the video frames from the site itself.
    const framesDir = path.join(compiledDir, SERVED_FRAMES_DIR);
    if (existsSync(path.join(planDir, "video-frames"))) renameSync(path.join(planDir, "video-frames"), framesDir);
    const videos = readPlanVideos(planDir, framesDir, api.engine.mediaIdPathSegment);
    const server = await api.producer.createFileServer({
      projectDir: compiledDir,
      compiledDir,
      port: 0,
      preHeadScripts: options.preHeadScripts,
      fps: { num: fps, den: 1 },
    });
    const origin = server.url.replace(/\/$/, "");
    return {
      url: `${origin}/index.html`,
      planDir,
      totalFrames: plan.totalFrames,
      planFps: fps,
      audioPath: audioPath && existsSync(audioPath) ? audioPath : null,
      videos,
      videoFrames: async (times, signal) =>
        videos ? extractShownVideoFrames(api.engine, { ...videos, planDir, framesDir, fps }, times, signal) : [],
      frameUrl: (framePath) => {
        const relative = path.relative(framesDir, framePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
        return `${origin}/${SERVED_FRAMES_DIR}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
      },
      producerVersion: plan.producerVersion,
      close: async () => {
        try {
          server.close();
        } catch {
          // Already closed.
        }
        await rm(workDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}
