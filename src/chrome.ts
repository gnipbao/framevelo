import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

/** Lowest Chrome major with a usable `drawElementImage` (HTML-in-Canvas) for DOM capture. */
export const MIN_DOM_CHROME_MAJOR = 151;

/** Path functions for a platform, so that paths for another platform can be built and tested. */
const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** Where `framevelo browser install` puts Chrome for Testing builds. */
export function framevelCacheDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string {
  const p = pathsFor(platform);
  return env.FRAMEVELO_CACHE_DIR ?? p.join(env.XDG_CACHE_HOME ?? p.join(home, ".cache"), "framevelo");
}

export interface FindChromeOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  exists?: (file: string) => boolean;
  listDir?: (dir: string) => string[];
}

export function isHeadlessShell(executablePath: string): boolean {
  // win32.basename splits on both separators.
  return path.win32.basename(executablePath).startsWith("chrome-headless-shell");
}

/** Version of a cache directory named like "mac_arm-152.0.7977.30". */
function buildVersion(dir: string): number[] {
  return (dir.split("-").pop() ?? "").split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Locate a Chrome binary, preferring chrome-headless-shell: it renders the same frames at about half
 * the CPU and memory of a full headless Chrome. Order:
 *
 * 1. an explicit path, then FRAMEVELO_CHROME;
 * 2. the newest chrome-headless-shell 151+ installed by `framevelo browser install`, the HyperFrames
 *    CLI, or Puppeteer;
 * 3. the installed Google Chrome, then the newest Chrome for Testing in the Puppeteer cache.
 */
export function findChrome(options: FindChromeOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? os.homedir();
  const p = pathsFor(platform);
  const exists = options.exists ?? existsSync;
  const listDir =
    options.listDir ??
    ((dir: string) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    });

  for (const candidate of [options.explicitPath, env.FRAMEVELO_CHROME]) {
    if (!candidate) continue;
    if (!exists(candidate)) throw new Error(`Chrome not found at ${candidate}`);
    return candidate;
  }

  const platformDir =
    platform === "darwin" ? (arch === "arm64" ? "mac-arm64" : "mac-x64") : platform === "win32" ? "win64" : "linux64";
  const cacheHome = env.XDG_CACHE_HOME ?? p.join(home, ".cache");
  const puppeteerCache = env.PUPPETEER_CACHE_DIR ?? p.join(cacheHome, "puppeteer");

  // Chrome for Testing cache layout: <cache>/<browser>/<platform>-<version>/<browser>-<platformDir>/<binary>
  const newestInCaches = (browser: "chrome-headless-shell" | "chrome", caches: string[], binary: string, minMajor: number) => {
    const found: Array<{ version: number[]; file: string }> = [];
    for (const cache of caches) {
      const root = p.join(cache, browser);
      for (const dir of listDir(root)) {
        const version = buildVersion(dir);
        if ((version[0] ?? 0) < minMajor) continue;
        const file = p.join(root, dir, `${browser}-${platformDir}`, binary);
        if (exists(file)) found.push({ version, file });
      }
    }
    found.sort((a, b) => compareVersions(b.version, a.version));
    return found[0]?.file ?? null;
  };

  const shellBinary = platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const shell = newestInCaches(
    "chrome-headless-shell",
    [framevelCacheDir(env, home, platform), p.join(cacheHome, "hyperframes", "chrome"), puppeteerCache],
    shellBinary,
    MIN_DOM_CHROME_MAJOR,
  );
  if (shell) return shell;

  const installed =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          p.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [env.PROGRAMFILES ?? "C:\\Program Files", env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", env.LOCALAPPDATA ?? p.join(home, "AppData", "Local")].map(
            (dir) => p.join(dir, "Google", "Chrome", "Application", "chrome.exe"),
          )
        : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = installed.find((file) => exists(file));
  if (found) return found;

  const cftBinary =
    platform === "darwin"
      ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : platform === "win32"
        ? "chrome.exe"
        : "chrome";
  return newestInCaches("chrome", [framevelCacheDir(env, home, platform), puppeteerCache], cftBinary, 0);
}

export function chromeMajor(version: string): number {
  const match = /\/(\d+)\./.exec(version);
  return match ? Number(match[1]) : 0;
}

/**
 * Flags for offline frame rendering: GPU raster on the platform backend, HTML-in-Canvas enabled,
 * and no vsync or background throttling pacing the paint loop.
 */
export function chromeArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--enable-features=CanvasDrawElement",
    "--enable-blink-features=CanvasDrawElement",
    ...(platform === "darwin" ? ["--use-angle=metal"] : []),
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
}

export async function launchChrome(executablePath: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath,
    headless: isHeadlessShell(executablePath) ? "shell" : true,
    args: chromeArgs(),
    // A long render is one evaluate call; progress arrives through bindings instead.
    protocolTimeout: 0,
  });
}

/**
 * Install chrome-headless-shell from Chrome for Testing into the FrameVelo cache and return its
 * executable path. `buildId` is a version such as "155.0.8059.85" or a channel ("stable", "beta").
 */
export async function installHeadlessShell(
  buildId = "stable",
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<{ buildId: string; executablePath: string }> {
  const browsers = await import("@puppeteer/browsers");
  const platform = browsers.detectBrowserPlatform();
  if (!platform) throw new Error(`No Chrome for Testing build for ${process.platform}/${process.arch}.`);
  const resolved = /^\d/.test(buildId)
    ? buildId
    : await browsers.resolveBuildId(browsers.Browser.CHROMEHEADLESSSHELL, platform, buildId as never);
  const installed = await browsers.install({
    cacheDir: framevelCacheDir(),
    browser: browsers.Browser.CHROMEHEADLESSSHELL,
    buildId: resolved,
    platform,
    ...(onProgress ? { downloadProgressCallback: onProgress } : {}),
  });
  return { buildId: resolved, executablePath: installed.executablePath };
}
