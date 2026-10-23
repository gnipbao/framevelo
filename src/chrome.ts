import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

/** Lowest Chrome major with a usable `drawElementImage` (HTML-in-Canvas) for DOM capture. */
export const MIN_DOM_CHROME_MAJOR = 151;

export interface FindChromeOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (file: string) => boolean;
  listDir?: (dir: string) => string[];
}

/**
 * Locate a Chrome binary: an explicit path, then FRAMEVELO_CHROME, then the installed Google Chrome,
 * then the newest Chrome for Testing in the Puppeteer cache.
 */
export function findChrome(options: FindChromeOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
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

  const installed =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            path.join(env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
            path.join(env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          ]
        : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = installed.find((file) => exists(file));
  if (found) return found;

  // ~/.cache/puppeteer/chrome/<platform>-<version>/... ; newest version first.
  const cacheRoot = path.join(env.PUPPETEER_CACHE_DIR ?? path.join(home, ".cache/puppeteer"), "chrome");
  const versions = listDir(cacheRoot).sort(compareBuildDirs).reverse();
  for (const dir of versions) {
    const base = path.join(cacheRoot, dir);
    const binary =
      platform === "darwin"
        ? path.join(base, `chrome-${dir.startsWith("mac_arm") ? "mac-arm64" : "mac-x64"}`, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
        : platform === "win32"
          ? path.join(base, "chrome-win64", "chrome.exe")
          : path.join(base, "chrome-linux64", "chrome");
    if (exists(binary)) return binary;
  }
  return null;
}

/** Order Puppeteer cache dirs such as "mac_arm-152.0.7977.75" by version. */
function compareBuildDirs(a: string, b: string): number {
  const va = (a.split("-").pop() ?? "").split(".").map(Number);
  const vb = (b.split("-").pop() ?? "").split(".").map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
    headless: true,
    args: chromeArgs(),
    // A long render is one evaluate call; progress arrives through bindings instead.
    protocolTimeout: 0,
  });
}
