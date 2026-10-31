#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findChrome, installHeadlessShell } from "./chrome.ts";
import { runDoctor } from "./doctor.ts";
import { serveMcp } from "./mcp.ts";
import { parseBitrate, type Codec, type Quality } from "./options.ts";
import type { CapturePolicy } from "./capture.ts";
import type { CaptureMode } from "./page-runtime.ts";
import { render, type RenderOptions } from "./render.ts";

const HELP = `FrameVelo: a rendering accelerator for code-driven videos.

Usage:
  framevelo render <input> [options]   Render an HTML page or project directory to MP4
  framevelo doctor [--chrome <path>]   Check Chrome, WebCodecs encoders and FFmpeg on this machine
  framevelo browser install [version]  Install chrome-headless-shell (default: stable) into the
                                       FrameVelo cache; about half the CPU and memory of full Chrome
  framevelo browser path               Print the Chrome binary FrameVelo would use
  framevelo mcp                        Serve the render, doctor and install_browser tools to coding
                                       agents over the Model Context Protocol (stdio)
  framevelo --version

Inputs: a HyperFrames project (compiled with @hyperframes/producer when installed), or any page
that is seekable through window.__framevelo = { seek(t), duration, fps, audio }, window.__seek(t),
or a paused GSAP timeline on window.__timelines.main.

Render options:
  -o, --output <file>     Output .mp4 (default: <input name>.mp4)
      --fps <n>           Frame rate (default: page data-fps or 30)
      --duration <s>      Seconds to render (default: what the page declares)
      --frames <n>        Exact frame count (overrides --duration)
      --start <s>         First frame time in seconds (default: 0)
      --width <px>        Output width (default: captured size x --scale)
      --height <px>       Output height
      --scale <n>         Resolution multiplier, e.g. 2 renders a 1080p layout at 4K (default: 1)
      --viewport <WxH>    CSS viewport (default: data-width/data-height, viewport meta, or 1920x1080)
      --mode <m>          auto | canvas | dom (default: auto)
      --selector <css>    Element (or canvas) to capture
      --capture <c>       DOM pages: auto (verify sampled frames against native screenshots and
                          fall back per interval), dom (drawElementImage only), screenshot
                          (default: auto)
      --verify-threshold <dB>  Verification PSNR below which an interval uses screenshots (default: 30)
      --no-paint-reuse    Repaint every frame, even when a seek changed nothing in the composition
      --no-video-proxy    Plain pages: seek <video data-start> sources as they are instead of cached
                          all-intra proxies (slow for long keyframe intervals)
      --workers <n>       Pages rendering Node-driven frames (HyperFrames video, screenshots) in
                          parallel (default: from the CPU count; 1 turns it off)
      --codec <c>         h264 | hevc (default: h264)
      --quality <q>       draft | standard | high: bitrate preset (default: standard, about x264 CRF 18)
      --bitrate <b>       Target bitrate, e.g. 12M; overrides --quality
      --audio <file>      Audio track to mux (AAC)
      --subframes <n>     Sub-frames averaged per frame for motion blur (default: 1)
      --shutter <f>       Fraction of the frame interval the sub-frames span (default: 0.5)
      --background <css>  Color behind transparent DOM content (default: page background)
      --no-hyperframes    Render a HyperFrames project as a plain page instead of compiling it
                          with the official HyperFrames pipeline (@hyperframes/producer)
      --composition <id>  Remotion projects: the composition to render (default: the only one)
      --props <json|file> Remotion projects: input props, as JSON or a .json file
      --mount <p>=<dir>   Serve another directory under a URL prefix (repeatable), e.g.
                          --mount /vendor/=~/shared/vendor
      --chrome <path>     Chrome binary (default: FRAMEVELO_CHROME, newest chrome-headless-shell 151+
                          in the FrameVelo/HyperFrames/Puppeteer caches, then installed Chrome)
      --json              Print the result as JSON
  -q, --quiet             No progress output
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function numberOption(name: string, raw: string | undefined, check: (n: number) => boolean = (n) => n > 0): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) throw new Error(`Invalid --${name} "${raw}".`);
  return n;
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`--${name} must be one of ${allowed.join(", ")}; got "${raw}".`);
  return raw as T;
}

/** Input props from inline JSON or a .json file. */
function parseProps(value: string): unknown {
  const text = value.trim().startsWith("{") || value.trim().startsWith("[") ? value : readFileSync(path.resolve(value), "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`--props must be JSON or a JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultOutput(input: string): string {
  const resolved = path.resolve(input);
  const base = path.extname(resolved) ? path.basename(resolved, path.extname(resolved)) : path.basename(resolved);
  return `${base === "index" ? path.basename(path.dirname(resolved)) : base}.mp4`;
}

async function renderCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      fps: { type: "string" },
      duration: { type: "string" },
      frames: { type: "string" },
      start: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      scale: { type: "string" },
      viewport: { type: "string" },
      mode: { type: "string" },
      selector: { type: "string" },
      capture: { type: "string" },
      "verify-threshold": { type: "string" },
      "no-paint-reuse": { type: "boolean" },
      "no-video-proxy": { type: "boolean" },
      workers: { type: "string" },
      codec: { type: "string" },
      bitrate: { type: "string" },
      quality: { type: "string" },
      audio: { type: "string" },
      subframes: { type: "string" },
      shutter: { type: "string" },
      background: { type: "string" },
      chrome: { type: "string" },
      mount: { type: "string", multiple: true },
      "no-hyperframes": { type: "boolean" },
      composition: { type: "string" },
      props: { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
    },
  });
  const input = positionals[0];
  if (!input || positionals.length > 1) throw new Error("render takes exactly one input: an .html file or a project directory.");

  let viewport: RenderOptions["viewport"];
  if (values.viewport) {
    const match = /^(\d+)x(\d+)$/.exec(values.viewport);
    if (!match) throw new Error(`Invalid --viewport "${values.viewport}"; use WIDTHxHEIGHT such as 1920x1080.`);
    viewport = { width: Number(match[1]), height: Number(match[2]) };
  }

  const quiet = values.quiet === true;
  const showProgress = !quiet && !values.json && process.stderr.isTTY;
  const startedAt = performance.now();
  const options: RenderOptions = {
    input,
    output: values.output ?? defaultOutput(input),
    ...(viewport ? { viewport } : {}),
    onLog: (message) => {
      if (!quiet && !values.json) process.stderr.write(`${message}\n`);
    },
    onProgress: (done, total) => {
      if (!showProgress) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      process.stderr.write(`\r  ${done}/${total} frames  ${(done / Math.max(elapsed, 1e-3)).toFixed(1)} fps   `);
      if (done === total) process.stderr.write("\n");
    },
  };
  const assign = <K extends keyof RenderOptions>(key: K, value: RenderOptions[K] | undefined) => {
    if (value !== undefined) options[key] = value;
  };
  assign("fps", numberOption("fps", values.fps));
  assign("duration", numberOption("duration", values.duration));
  assign("frames", numberOption("frames", values.frames, (n) => Number.isInteger(n) && n > 0));
  assign("start", numberOption("start", values.start, (n) => n >= 0));
  assign("width", numberOption("width", values.width, (n) => Number.isInteger(n) && n >= 2));
  assign("height", numberOption("height", values.height, (n) => Number.isInteger(n) && n >= 2));
  assign("scale", numberOption("scale", values.scale));
  assign("mode", oneOf<CaptureMode>("mode", values.mode, ["auto", "canvas", "dom"]));
  assign("selector", values.selector);
  assign("capture", oneOf<CapturePolicy>("capture", values.capture, ["auto", "dom", "screenshot"]));
  assign("verifyThresholdDb", numberOption("verify-threshold", values["verify-threshold"]));
  if (values["no-paint-reuse"]) options.reusePaints = false;
  if (values["no-video-proxy"]) options.videoProxies = false;
  assign("workers", numberOption("workers", values.workers, (n) => Number.isInteger(n) && n >= 1 && n <= 16));
  assign("codec", oneOf<Codec>("codec", values.codec, ["h264", "hevc"]));
  assign("bitrate", values.bitrate === undefined ? undefined : parseBitrate(values.bitrate));
  assign("quality", oneOf<Quality>("quality", values.quality, ["draft", "standard", "high"]));
  assign("audio", values.audio);
  assign("subframes", numberOption("subframes", values.subframes, (n) => Number.isInteger(n) && n >= 1));
  assign("shutter", numberOption("shutter", values.shutter, (n) => n >= 0 && n <= 1));
  assign("background", values.background);
  assign("chromePath", values.chrome);
  if (values["no-hyperframes"]) options.hyperframes = "off";
  assign("composition", values.composition);
  if (values.props !== undefined) options.props = parseProps(values.props);
  if (values.mount?.length) {
    const mounts: Record<string, string> = {};
    for (const spec of values.mount) {
      const eq = spec.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid --mount "${spec}"; use PREFIX=DIR such as /vendor/=./vendor.`);
      const dir = spec.slice(eq + 1).replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
      mounts[spec.slice(0, eq)] = path.resolve(dir);
    }
    options.mounts = mounts;
  }

  const result = await render(options);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!quiet) {
    const seconds = result.wallMs / 1000;
    process.stderr.write(
      `${path.relative(process.cwd(), result.output) || result.output}: ${result.frames} frames, ${result.width}x${result.height}, ` +
        `${(result.bytes / 1e6).toFixed(1)} MB in ${seconds.toFixed(2)} s (${(result.frames / (result.renderMs / 1000)).toFixed(1)} fps render` +
        `${result.screenshotFrames ? `, ${result.screenshotFrames} screenshot frames` : ""})\n`,
    );
  }
}

async function doctorCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { chrome: { type: "string" }, json: { type: "boolean" } } });
  const checks = await runDoctor(values.chrome ? { chromePath: values.chrome } : {});
  if (values.json) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const mark = check.ok ? "ok  " : check.optional ? "warn" : "FAIL";
      process.stdout.write(`${mark}  ${check.name.padEnd(32)} ${check.detail}\n`);
    }
  }
  if (checks.some((check) => !check.ok && !check.optional)) process.exitCode = 1;
}

async function browserCommand(argv: string[]): Promise<void> {
  const [action, buildId] = argv;
  if (action === "path") {
    const found = findChrome();
    if (!found) throw new Error("No Chrome found. Run: framevelo browser install");
    process.stdout.write(`${found}\n`);
    return;
  }
  if (action !== "install") throw new Error('Usage: framevelo browser install [version|stable|beta] | framevelo browser path');
  let last = 0;
  const { buildId: installed, executablePath } = await installHeadlessShell(buildId ?? "stable", (done, total) => {
    const percent = total ? Math.floor((done / total) * 100) : 0;
    if (process.stderr.isTTY && percent !== last) {
      last = percent;
      process.stderr.write(`\r  downloading chrome-headless-shell: ${percent}%   `);
    }
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  process.stdout.write(`chrome-headless-shell ${installed}\n${executablePath}\n`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (command === "render") return renderCommand(rest);
  if (command === "doctor") return doctorCommand(rest);
  if (command === "browser") return browserCommand(rest);
  if (command === "mcp") return serveMcp(version());
  throw new Error(`Unknown command "${command}". Run framevelo --help.`);
}

const argv = process.argv.slice(2);
main(argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`framevelo: ${message}\n`);
  // --json callers parse stdout: give them the failure there too.
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
