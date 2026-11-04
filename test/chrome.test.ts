import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// The darwin and linux cases build POSIX paths whatever the host is.
const posix = path.posix;
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import {
  chromeArgs,
  chromeMajor,
  extraChromeArgs,
  findChrome,
  formatChromeArgs,
  framevelCacheDir,
  isHeadlessShell,
  parseChromeArgs,
} from "../src/chrome.ts";

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

test("FRAMEVELO_CHROME_ARGS splits at whitespace, and each flag keeps its value", () => {
  assert.deepEqual(parseChromeArgs(""), []);
  assert.deepEqual(parseChromeArgs(" \n\t "), []);
  assert.deepEqual(parseChromeArgs(" --use-angle=d3d11  --force_high_performance_gpu\t--disable-gpu-driver-bug-workarounds\n"), [
    "--use-angle=d3d11",
    "--force_high_performance_gpu",
    "--disable-gpu-driver-bug-workarounds",
  ]);
  assert.deepEqual(parseChromeArgs("--enable-features=A,B --js-flags=--expose-gc"), ["--enable-features=A,B", "--js-flags=--expose-gc"]);
});

test("quotes keep spaces in a value, and backslashes stay as they are", () => {
  assert.deepEqual(parseChromeArgs(`--js-flags="--expose-gc --max-old-space-size=8192" '--user-data-dir=C:\\Users\\Jane Doe\\fv' --a="b c"'d "e"'`), [
    "--js-flags=--expose-gc --max-old-space-size=8192",
    "--user-data-dir=C:\\Users\\Jane Doe\\fv",
    '--a=b cd "e"',
  ]);
});

test("a malformed flag fails and names where it came from", () => {
  assert.throws(() => parseChromeArgs(`--js-flags="--expose-gc`, "FRAMEVELO_CHROME_ARGS"), /^Error: FRAMEVELO_CHROME_ARGS has an unclosed "/);
  // A word that is not a switch would reach Chrome as a URL to open.
  for (const bad of ["use-angle=d3d11", "--", "---x", "--=x", '""']) {
    assert.throws(() => parseChromeArgs(bad, "FRAMEVELO_CHROME_ARGS"), /^Error: FRAMEVELO_CHROME_ARGS: .* is not a Chrome flag/, bad);
  }
  assert.throws(() => extraChromeArgs(["use-angle=d3d11"], {}), /^Error: --chrome-arg: "use-angle=d3d11" is not a Chrome flag/);
});

test("formatChromeArgs writes a line that parses back to the same flags", () => {
  const flags = ["--use-angle=d3d11", "--js-flags=--expose-gc --max-old-space-size=8192", "--a=it's", '--b=say "hi"', `--c='"'`];
  assert.equal(formatChromeArgs(flags.slice(0, 2)), '--use-angle=d3d11 "--js-flags=--expose-gc --max-old-space-size=8192"');
  assert.deepEqual(parseChromeArgs(formatChromeArgs(flags)), flags);
});

test("the user's flags come after FrameVelo's: FRAMEVELO_CHROME_ARGS, then --chrome-arg", () => {
  const env = { FRAMEVELO_CHROME_ARGS: "--use-angle=d3d11 --force_high_performance_gpu" };
  const extra = extraChromeArgs(["--disable-gpu-driver-bug-workarounds"], env);
  assert.deepEqual(extra, ["--use-angle=d3d11", "--force_high_performance_gpu", "--disable-gpu-driver-bug-workarounds"]);
  assert.deepEqual(chromeArgs("win32", extra), [...chromeArgs("win32"), ...extra]);
  assert.deepEqual(extraChromeArgs([], {}), []);
});

test("Puppeteer keeps the user's flags last and merges feature lists", async () => {
  const args = await puppeteer.defaultArgs({ browser: "chrome", headless: "shell", args: chromeArgs("darwin", ["--use-angle=gl", "--enable-features=Vulkan"]) });
  // Chrome takes the last value of a repeated switch, so the user's --use-angle replaces FrameVelo's.
  assert.deepEqual(args.filter((arg) => arg.startsWith("--use-angle=")), ["--use-angle=metal", "--use-angle=gl"]);
  assert.equal(args.at(-1), "--use-angle=gl");
  // The user's --enable-features joins FrameVelo's instead of turning HTML-in-Canvas off.
  const features = args.filter((arg) => arg.startsWith("--enable-features=")).map((arg) => arg.slice("--enable-features=".length).split(","));
  assert.equal(features.length, 1);
  assert.ok(features[0]!.includes("CanvasDrawElement") && features[0]!.includes("Vulkan"), String(features[0]));
});

test("the CLI reads --chrome-arg --flag, and doctor reports a malformed flag", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const argv = ["--disable-warning=ExperimentalWarning", cli, "doctor", "--chrome-arg", "--use-angle=d3d11", "--chrome-arg", "nodash", "--json"];
  const run = spawnSync(process.execPath, argv, { encoding: "utf8", env: { ...process.env, FRAMEVELO_CHROME_ARGS: "" } });
  assert.equal(run.status, 1, run.stderr);
  // parseArgs alone refuses "--chrome-arg --use-angle=d3d11" and prints {"error": ...} instead.
  const checks = JSON.parse(run.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
  const flags = checks.find((check) => check.name === "Chrome flags");
  assert.equal(flags?.ok, false);
  assert.match(flags?.detail ?? "", /"nodash" is not a Chrome flag/);
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
