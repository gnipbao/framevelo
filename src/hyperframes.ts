// Render HyperFrames projects with the official compiler, media pipeline and runtime, and FrameVelo
// capture and encoding. `@hyperframes/producer` (Apache-2.0) is an optional peer dependency:
//
//   plan()            compile the project, extract <video> frames, mix the audio   (official)
//   createFileServer  serve the compiled site with the HyperFrames runtime          (official)
//   window.__hf.seek  drive time: clips, sub-compositions, nested timelines         (official)
//   video injector    swap <video> elements for the extracted frame of each time    (official)
//   drawElementImage → WebCodecs → stream-copy mux with the plan's audio            (FrameVelo)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "puppeteer-core";

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
interface DistributedApi {
  plan(
    projectDir: string,
    config: { fps: number; width: number; height: number; format: "mp4"; logger?: ProducerLogger },
    planDir: string,
  ): Promise<{ totalFrames: number; fps: number; width: number; height: number; producerVersion: string }>;
  resolvePlanAudioPath(planDir: string): string | null;
}
interface ProducerApi {
  createFileServer(options: {
    projectDir: string;
    compiledDir?: string;
    port?: number;
    preHeadScripts?: string[];
    fps?: { num: number; den: number };
  }): Promise<{ url: string; close(): void }>;
  createVideoFrameInjector(lookup: unknown): ((page: Page, time: number) => Promise<void>) | null;
}
interface EngineApi {
  createFrameLookupTable(videos: unknown[], extracted: unknown[], fps?: number): unknown;
}
export interface HyperFramesApi {
  distributed: DistributedApi;
  producer: ProducerApi;
  engine: EngineApi;
  version: string;
}

/** Load the optional HyperFrames packages, with an actionable error when they are missing. */
export async function loadHyperFrames(): Promise<HyperFramesApi> {
  try {
    const [distributed, producer, engine] = await Promise.all([
      import("@hyperframes/producer/distributed" as string),
      import("@hyperframes/producer" as string),
      import("@hyperframes/engine" as string),
    ]);
    let version = "unknown";
    try {
      const pkgUrl = import.meta.resolve("@hyperframes/producer").replace(/\/dist\/index\.js$/, "/package.json");
      version = (JSON.parse(readFileSync(new URL(pkgUrl), "utf8")) as { version: string }).version;
    } catch {
      // The version is informational only.
    }
    return { distributed: distributed as DistributedApi, producer: producer as ProducerApi, engine: engine as EngineApi, version };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Rendering a HyperFrames project needs the official compiler and runtime from @hyperframes/producer.\n" +
        "Install it where FrameVelo is installed, for example:\n" +
        "  npm install -g @hyperframes/producer@0.8 @hyperframes/engine@0.8\n" +
        "or pass --no-hyperframes to render the page as a plain seekable HTML file.\n" +
        `(${reason})`,
    );
  }
}

interface PlanVideosJson {
  videos: unknown[];
  extracted: Array<{
    videoId: string;
    srcPath: string;
    framePattern: string;
    fps: number;
    totalFrames: number;
    metadata: unknown;
  }>;
}

/**
 * Rebuild the extracted-frame descriptors of a plan directory (layout "plan-dir-v1"): frames live
 * in video-frames/<videoId>/ and are numbered in presentation order.
 */
export function readPlanVideos(planDir: string): { videos: unknown[]; extracted: unknown[] } | null {
  const metaPath = path.join(planDir, "meta", "videos.json");
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PlanVideosJson;
  if (!meta.extracted?.length) return null;
  const frameNumber = (name: string) => {
    const match = /(\d+)(?=\.[^.]+$)/.exec(name);
    return match ? Number(match[1]) : null;
  };
  const extracted = meta.extracted.map((video) => {
    const outputDir = path.join(planDir, "video-frames", video.videoId);
    if (!existsSync(outputDir)) throw new Error(`The HyperFrames plan has no extracted frames for video "${video.videoId}".`);
    const ext = (path.extname(video.framePattern) || ".jpg").toLowerCase();
    const files = readdirSync(outputDir)
      .filter((name) => name.toLowerCase().endsWith(ext))
      .sort((a, b) => (frameNumber(a) ?? 0) - (frameNumber(b) ?? 0) || a.localeCompare(b));
    return {
      videoId: video.videoId,
      srcPath: video.srcPath,
      outputDir,
      framePattern: video.framePattern,
      fps: video.fps,
      totalFrames: video.totalFrames,
      metadata: video.metadata,
      framePaths: new Map(files.map((name, index) => [index, path.join(outputDir, name)])),
      // The plan directory is ours to delete; the lookup must not clean it up.
      ownedByLookup: false,
    };
  });
  return { videos: meta.videos, extracted };
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

export interface HyperFramesSite {
  url: string;
  planDir: string;
  totalFrames: number;
  planFps: number;
  audioPath: string | null;
  videos: { videos: unknown[]; extracted: unknown[] } | null;
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
  },
): Promise<HyperFramesSite> {
  const log = options.onLog ?? (() => {});
  const logger: ProducerLogger = {
    error: (message) => log(`hyperframes: ${message}`),
    warn: (message) => log(`hyperframes: ${message}`),
    info: () => {},
    debug: () => {},
  };
  const planDir = await mkdtemp(path.join(os.tmpdir(), "framevelo-plan-"));
  try {
    const fps = planFps(options.fps);
    // Parts of the compiler log straight to the console; route them through onLog.
    const plan = await withConsoleRoutedTo(log, () =>
      api.distributed.plan(options.projectDir, { fps, width: options.width, height: options.height, format: "mp4", logger }, planDir),
    );
    const compiledDir = path.join(planDir, "compiled");
    const server = await api.producer.createFileServer({
      projectDir: compiledDir,
      compiledDir,
      port: 0,
      preHeadScripts: options.preHeadScripts,
      fps: { num: fps, den: 1 },
    });
    let audioPath: string | null = null;
    try {
      const resolved = api.distributed.resolvePlanAudioPath(planDir);
      audioPath = resolved && existsSync(resolved) ? resolved : null;
    } catch {
      audioPath = null;
    }
    return {
      url: `${server.url.replace(/\/$/, "")}/index.html`,
      planDir,
      totalFrames: plan.totalFrames,
      planFps: fps,
      audioPath,
      videos: readPlanVideos(planDir),
      producerVersion: plan.producerVersion,
      close: async () => {
        try {
          server.close();
        } catch {
          // Already closed.
        }
        await rm(planDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(planDir, { recursive: true, force: true });
    throw error;
  }
}
