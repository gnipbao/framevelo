import assert from "node:assert/strict";
import path from "node:path";

// The darwin and linux cases build POSIX paths whatever the host is.
const posix = path.posix;
import { test } from "node:test";
import { chromeArgs, chromeMajor, findChrome, framevelCacheDir, isHeadlessShell } from "../src/chrome.ts";

const fakeFs = (files: string[], dirs: Record<string, string[]> = {}) => ({
  exists: (file: string) => files.includes(file),
  listDir: (dir: string) => dirs[dir] ?? [],
});

test("an explicit path wins and must exist", () => {
  const fs = fakeFs(["/opt/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, explicitPath: "/opt/chrome", platform: "darwin", env: {} }), "/opt/chrome");
  assert.throws(() => findChrome({ ...fs, explicitPath: "/missing", platform: "darwin", env: {} }), /not found/);
});

test("FRAMEVELO_CHROME comes before installed browsers", () => {
  const fs = fakeFs(["/env/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, platform: "darwin", env: { FRAMEVELO_CHROME: "/env/chrome" } }), "/env/chrome");
});

test("finds installed Google Chrome on macOS", () => {
  const fs = fakeFs(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, platform: "darwin", arch: "arm64", env: {}, home: "/Users/me" }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("prefers the newest chrome-headless-shell 151+ across the FrameVelo, HyperFrames and Puppeteer caches", () => {
  const shell = (cache: string, dir: string) => posix.join(cache, "chrome-headless-shell", dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  const fv = "/Users/me/.cache/framevelo";
  const hf = "/Users/me/.cache/hyperframes/chrome";
  const pp = "/Users/me/.cache/puppeteer";
  const fs = fakeFs(
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      shell(hf, "mac_arm-152.0.7977.30"),
      shell(pp, "mac_arm-155.0.8059.85"),
      shell(pp, "mac_arm-150.0.1.1"),
      shell(fv, "mac_arm-126.0.6478.126"),
    ],
    {
      [posix.join(hf, "chrome-headless-shell")]: ["mac_arm-152.0.7977.30"],
      [posix.join(pp, "chrome-headless-shell")]: ["mac_arm-155.0.8059.85", "mac_arm-150.0.1.1"],
      [posix.join(fv, "chrome-headless-shell")]: ["mac_arm-126.0.6478.126"],
    },
  );
  const found = findChrome({ ...fs, platform: "darwin", arch: "arm64", env: {}, home: "/Users/me" });
  assert.equal(found, shell(pp, "mac_arm-155.0.8059.85"));
  assert.equal(isHeadlessShell(found!), true);
  assert.equal(isHeadlessShell("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), false);
});

test("an old headless shell is skipped in favor of a full Chrome", () => {
  const old = "/Users/me/.cache/puppeteer/chrome-headless-shell/mac_arm-126.0.6478.126/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const fs = fakeFs([old, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], {
    "/Users/me/.cache/puppeteer/chrome-headless-shell": ["mac_arm-126.0.6478.126"],
  });
  assert.equal(findChrome({ ...fs, platform: "darwin", arch: "arm64", env: {}, home: "/Users/me" }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("falls back to the newest Chrome for Testing in the Puppeteer cache", () => {
  const cache = "/Users/me/.cache/puppeteer/chrome";
  const binary = (dir: string) => posix.join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  const fs = fakeFs([binary("mac_arm-126.0.6478.126"), binary("mac_arm-152.0.7977.75")], {
    [cache]: ["mac_arm-126.0.6478.126", "mac_arm-152.0.7977.75", "mac_arm-99.0.1.1"],
  });
  assert.equal(findChrome({ ...fs, platform: "darwin", arch: "arm64", env: {}, home: "/Users/me" }), binary("mac_arm-152.0.7977.75"));
});

test("returns null when nothing is installed", () => {
  assert.equal(findChrome({ ...fakeFs([]), platform: "linux", env: {}, home: "/home/me" }), null);
});

test("chromeMajor parses browser version strings", () => {
  assert.equal(chromeMajor("Chrome/155.0.8059.85"), 155);
  assert.equal(chromeMajor("HeadlessChrome/152.0.7977.30"), 152);
  assert.equal(chromeMajor("unknown"), 0);
});

test("chromeArgs enables HTML-in-Canvas and removes vsync pacing", () => {
  const args = chromeArgs("darwin");
  assert.ok(args.includes("--enable-features=CanvasDrawElement"));
  assert.ok(args.includes("--disable-gpu-vsync"));
  assert.ok(args.includes("--disable-frame-rate-limit"));
  assert.ok(args.includes("--use-angle=metal"));
  assert.ok(!chromeArgs("linux").includes("--use-angle=metal"));
});

test("the FrameVelo cache honors FRAMEVELO_CACHE_DIR and XDG_CACHE_HOME", () => {
  assert.equal(framevelCacheDir({ FRAMEVELO_CACHE_DIR: "/tmp/fv" }, "/Users/me", "darwin"), "/tmp/fv");
  assert.equal(framevelCacheDir({ XDG_CACHE_HOME: "/xdg" }, "/Users/me", "darwin"), "/xdg/framevelo");
  assert.equal(framevelCacheDir({}, "/Users/me", "darwin"), "/Users/me/.cache/framevelo");
  assert.equal(framevelCacheDir({}, "C:\\Users\\me", "win32"), "C:\\Users\\me\\.cache\\framevelo");
});

test("on Windows: the headless shell in the cache, then Chrome in either Program Files or the user's AppData", () => {
  const home = "C:\\Users\\me";
  const shell = "C:\\Users\\me\\.cache\\framevelo\\chrome-headless-shell\\win64-156.0.8078.47\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
  const x86 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const local = "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const dirs = { "C:\\Users\\me\\.cache\\framevelo\\chrome-headless-shell": ["win64-156.0.8078.47"] };
  assert.equal(findChrome({ ...fakeFs([shell, x86], dirs), platform: "win32", env: {}, home }), shell);
  assert.equal(findChrome({ ...fakeFs([x86]), platform: "win32", env: {}, home }), x86);
  assert.equal(findChrome({ ...fakeFs([local]), platform: "win32", env: {}, home }), local, "AppData without LOCALAPPDATA set");
  assert.equal(isHeadlessShell(shell), true);
  assert.equal(isHeadlessShell(x86), false);
});
