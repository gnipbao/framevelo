// Remotion projects, through the project's own Remotion: its CLI bundles the project (honouring
// remotion.config.ts), its renderer serves the bundle together with the <OffthreadVideo> frame
// server and mixes the audio. FrameVelo mounts the composition in its capture page, drives it
// frame by frame through remotion_setFrame, and replaces capture and encoding.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Page } from "puppeteer-core";

/** Remotion versions this integration follows; the bundle's page protocol is checked at load. */
export const REMOTION_SITE_VERSION = "11";

/** Entry points `remotion render` looks for when none is configured. */
export const REMOTION_ENTRY_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.jsx",
  "remotion/index.ts",
  "remotion/index.tsx",
  "remotion/index.js",
  "remotion/index.jsx",
];

/** A directory whose package.json depends on `remotion`. */
export function isRemotionProject(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return Boolean(pkg.dependencies?.remotion ?? pkg.devDependencies?.remotion);
  } catch {
    return false;
  }
}

/**
 * The Remotion project an input names: the project directory itself, or an entry file inside one
 * (the nearest package.json above it that depends on `remotion`). Null for anything else.
 */
export function remotionProjectFor(input: string): { projectDir: string; entry: string | null } | null {
  const resolved = path.resolve(input);
  if (isRemotionProject(resolved)) return { projectDir: resolved, entry: findRemotionEntry(resolved) };
  if (!/\.[cm]?[jt]sx?$/.test(resolved) || !existsSync(resolved)) return null;
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    if (isRemotionProject(dir)) return { projectDir: dir, entry: resolved };
    if (path.dirname(dir) === dir) return null;
  }
}

/** The project's entry file (the one that calls registerRoot), or null. */
export function findRemotionEntry(dir: string): string | null {
  const found = REMOTION_ENTRY_CANDIDATES.find((candidate) => existsSync(path.join(dir, candidate)));
  return found ? path.join(dir, found) : null;
}

interface DownloadMap {
  inlineAudioMixing: { addAsset(options: Record<string, unknown>): void };
}
interface RenderInternals {
  DEFAULT_RENDER_FRAMES_OFFTHREAD_VIDEO_THREADS: number;
  prepareServer(options: Record<string, unknown>): Promise<{
    serveUrl: string;
    offthreadPort: number;
    downloadMap: DownloadMap;
    closeServer(force: boolean): Promise<unknown>;
  }>;
}
export interface RemotionApi {
  version: string;
  cliScript: string;
  renderer: { RenderInternals: RenderInternals; stitchFramesToVideo(options: Record<string, unknown>): Promise<unknown> };
  noReact: { NoReactInternals: { serializeJSONWithSpecialTypes(options: { data: unknown; indent: undefined; staticBase: null }): { serializedString: string } } };
}

/** Load the project's own Remotion packages, so that the bundle, server and page protocol match. */
export function loadRemotion(projectDir: string): RemotionApi {
  const fromProject = createRequire(path.join(projectDir, "package.json"));
  try {
    const cliPackage = fromProject.resolve("@remotion/cli/package.json");
    // The renderer comes with the CLI; resolve it from there when the package manager does not hoist it.
    const fromCli = createRequire(cliPackage);
    const load = (name: string) => {
      try {
        return fromProject(name) as unknown;
      } catch {
        return fromCli(name) as unknown;
      }
    };
    return {
      version: (JSON.parse(readFileSync(fromCli.resolve("remotion/package.json"), "utf8")) as { version: string }).version,
      cliScript: path.join(path.dirname(cliPackage), "remotion-cli.js"),
      renderer: load("@remotion/renderer") as RemotionApi["renderer"],
      noReact: load("remotion/no-react") as RemotionApi["noReact"],
    };
  } catch (error) {
    throw new Error(
      `Rendering a Remotion project needs the project's own Remotion packages (@remotion/cli, which brings @remotion/renderer).\n` +
        `Install the project's dependencies first: npm install (in ${projectDir}).\n` +
        `(${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
  }
}

export interface RemotionSite {
  serveUrl: string;
  proxyPort: number;
  downloadMap: DownloadMap;
  close(): Promise<void>;
}

/** Bundle the project with its own CLI (so remotion.config.ts applies) and serve the bundle. */
export async function prepareRemotionSite(
  api: RemotionApi,
  options: { projectDir: string; entry: string; onLog?: (line: string) => void },
): Promise<RemotionSite> {
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), "framevelo-remotion-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [api.cliScript, "bundle", options.entry, "--out-dir", bundleDir, "--log=error"], {
        cwd: options.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`remotion bundle failed (exit ${code}):\n${output.trim().slice(-2000)}`))));
    });
    const server = await api.renderer.RenderInternals.prepareServer({
      webpackConfigOrServeUrl: bundleDir,
      port: null,
      remotionRoot: options.projectDir,
      // The <OffthreadVideo> compositor needs a thread count: Remotion's own default.
      offthreadVideoThreads: api.renderer.RenderInternals.DEFAULT_RENDER_FRAMES_OFFTHREAD_VIDEO_THREADS,
      logLevel: "error",
      indent: false,
      offthreadVideoCacheSizeInBytes: null,
      binariesDirectory: null,
      forceIPv4: false,
      sampleRate: 48000,
    });
    return {
      serveUrl: server.serveUrl,
      proxyPort: server.offthreadPort,
      downloadMap: server.downloadMap,
      close: async () => {
        await server.closeServer(true);
        await rm(bundleDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(bundleDir, { recursive: true, force: true });
    throw error;
  }
}

/** Input props as the page expects them (Remotion's JSON with special types). */
export function serializeInputProps(api: RemotionApi, props: unknown): string {
  return api.noReact.NoReactInternals.serializeJSONWithSpecialTypes({ data: props ?? {}, indent: undefined, staticBase: null }).serializedString;
}

/** The globals a Remotion render page reads before the bundle loads (as @remotion/renderer sets them). */
export async function setUpRemotionPage(page: Page, options: { serializedInputProps: string; proxyPort: number; timeoutMs: number }): Promise<void> {
  await page.evaluateOnNewDocument(
    (props: string, port: number, timeout: number) => {
      const w = window as unknown as Record<string, unknown> & { process?: { env?: Record<string, string> } };
      w.remotion_puppeteerTimeout = timeout;
      w.remotion_isMainTab = true;
      w.remotion_mediaCacheSizeInBytes = null;
      w.remotion_initialMemoryAvailable = null;
      w.remotion_sampleRate = 48000;
      w.process ??= {};
      w.process.env ??= {};
      w.process.env.NODE_ENV = "production";
      w.remotion_broadcastChannel = new BroadcastChannel("remotion-video-frame-extraction");
      w.remotion_inputProps = props;
      w.remotion_initialFrame = 0;
      w.remotion_attempt = 1;
      w.remotion_proxyPort = port;
      w.remotion_audioEnabled = true;
      w.remotion_videoEnabled = true;
      w.remotion_logLevel = "error";
      const fail = (what: string) => () => {
        w.remotion_cancelledError = new Error(`${what}() was called. It cannot be called in a headless browser.`).stack;
        return false;
      };
      w.alert = fail("alert");
      w.confirm = fail("confirm");
    },
    options.serializedInputProps,
    options.proxyPort,
    options.timeoutMs,
  );
}

export interface RemotionComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

const ready = (page: Page, timeoutMs: number) =>
  page
    .waitForFunction("window.remotion_renderReady === true || window.remotion_cancelledError !== undefined", { timeout: timeoutMs, polling: 10 })
    .then(() => page.evaluate(() => (window as unknown as { remotion_cancelledError?: string }).remotion_cancelledError))
    .then((cancelled) => {
      if (cancelled !== undefined) throw new Error(`The Remotion composition failed: ${String(cancelled).split("\n")[0]}`);
    });

/**
 * Mount composition `id` (or the only one) in a page that loaded the bundle: resolve its metadata
 * (calculateMetadata, resolved props) and switch the bundle to render it.
 */
export async function mountRemotionComposition(page: Page, options: { id?: string; timeoutMs: number }): Promise<RemotionComposition> {
  type W = {
    siteVersion?: string;
    remotion_setBundleMode(mode: Record<string, unknown>): void;
    getStaticCompositions(): Promise<Array<{ id: string }>>;
    remotion_calculateComposition(id: string): Promise<Record<string, unknown> & RemotionComposition & { serializedResolvedPropsWithCustomSchema: string }>;
    __fvRemotion?: unknown;
  };
  const siteVersion = await page.evaluate(() => (window as unknown as W).siteVersion);
  if (siteVersion !== REMOTION_SITE_VERSION) {
    throw new Error(`This Remotion bundle uses page protocol ${siteVersion ?? "unknown"}; FrameVelo supports Remotion 4 bundles with protocol ${REMOTION_SITE_VERSION}.`);
  }
  await page.evaluate(() => (window as unknown as W).remotion_setBundleMode({ type: "evaluation" }));
  await ready(page, options.timeoutMs);
  const ids = await page.evaluate(async () => (await (window as unknown as W).getStaticCompositions()).map((c) => c.id));
  const id = options.id ?? (ids.length === 1 ? ids[0] : undefined);
  if (!id || !ids.includes(id)) {
    throw new Error(
      options.id
        ? `No composition "${options.id}" in this Remotion project; it has: ${ids.join(", ")}.`
        : `This Remotion project has ${ids.length} compositions; pick one with --composition: ${ids.join(", ")}.`,
    );
  }
  // calculateMetadata() and the resolved props; kept in the page for the switch below.
  const composition = await page.evaluate(async (compositionId) => {
    const c = await (window as unknown as W).remotion_calculateComposition(compositionId);
    (window as unknown as { __fvRemotionMetadata?: unknown }).__fvRemotionMetadata = c;
    return { id: compositionId, width: c.width, height: c.height, fps: c.fps, durationInFrames: c.durationInFrames };
  }, id);
  // The composition renders at its own size, as in Remotion's render pages.
  await page.setViewport({ width: composition.width, height: composition.height, deviceScaleFactor: 1 });
  await page.evaluate((compositionId) => {
    const c = (window as unknown as { __fvRemotionMetadata: Record<string, unknown> & { serializedResolvedPropsWithCustomSchema: string } }).__fvRemotionMetadata;
    (window as unknown as W).remotion_setBundleMode({
      type: "composition",
      compositionName: compositionId,
      serializedResolvedPropsWithSchema: c.serializedResolvedPropsWithCustomSchema,
      compositionDurationInFrames: c.durationInFrames,
      compositionFps: c.fps,
      compositionHeight: c.height,
      compositionWidth: c.width,
      compositionDefaultCodec: c.defaultCodec,
      compositionDefaultOutName: c.defaultOutName,
      compositionDefaultVideoImageFormat: c.defaultVideoImageFormat,
      compositionDefaultPixelFormat: c.defaultPixelFormat,
      compositionDefaultProResProfile: c.defaultProResProfile,
      compositionDefaultSampleRate: c.defaultSampleRate,
    });
  }, id);
  await ready(page, options.timeoutMs);
  // The page-side time driver reads this.
  await page.evaluate((c) => {
    (window as unknown as W).__fvRemotion = { id: c.id, fps: c.fps, durationInFrames: c.durationInFrames, collectAssets: true };
  }, composition);
  return composition;
}

type Asset = { type: string; [key: string]: unknown };

/**
 * Mix the composition's audio from the media assets collected for each rendered frame, with
 * Remotion's own mixer (volume curves, playback rate, trims, inline audio). Returns the AAC file,
 * or null when no frame has audio.
 */
export async function mixRemotionAudio(
  api: RemotionApi,
  site: RemotionSite,
  options: { assetsByFrame: Record<number, Asset[]>; startFrame: number; frames: number; fps: number; width: number; height: number; output: string },
): Promise<string | null> {
  const { startFrame, frames, fps } = options;
  const perFrame = [];
  let media = 0;
  for (let frame = startFrame; frame < startFrame + frames; frame++) {
    const assets = options.assetsByFrame[frame] ?? [];
    const audioAndVideoAssets = assets.filter((a) => a.type === "audio" || a.type === "video");
    const inlineAudioAssets = assets.filter((a) => a.type === "inline-audio");
    media += audioAndVideoAssets.length + inlineAudioAssets.length;
    for (const asset of inlineAudioAssets) {
      site.downloadMap.inlineAudioMixing.addAsset({
        asset: { ...asset, frame },
        fps,
        totalNumberOfFrames: frames,
        firstFrame: startFrame,
        trimLeftOffset: 0,
        trimRightOffset: 0,
      });
    }
    perFrame.push({ frame, audioAndVideoAssets, artifactAssets: [], inlineAudioAssets });
  }
  if (media === 0) return null;
  await api.renderer.stitchFramesToVideo({
    fps,
    width: options.width,
    height: options.height,
    codec: "aac",
    audioCodec: "aac",
    outputLocation: options.output,
    force: true,
    assetsInfo: {
      assets: perFrame,
      imageSequenceName: "element-[frame].jpeg",
      firstFrameIndex: startFrame,
      downloadMap: site.downloadMap,
      chunkLengthInSeconds: frames / fps,
      trimLeftOffset: 0,
      trimRightOffset: 0,
      forSeamlessAacConcatenation: false,
    },
  });
  return options.output;
}
