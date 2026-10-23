#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runDoctor } from "./doctor.ts";
import { parseBitrate, type Codec } from "./options.ts";
import type { CaptureMode } from "./page-runtime.ts";
import { render, type RenderOptions } from "./render.ts";

const HELP = `FrameVelo: a rendering accelerator for code-driven videos.

Usage:
  framevelo render <input> [options]   Render an HTML page or project directory to MP4
  framevelo doctor [--chrome <path>]   Check Chrome, WebCodecs encoders and FFmpeg on this machine
  framevelo --version

The page must be seekable: window.__framevelo = { seek(t), duration }, window.__seek(t), or a paused
GSAP timeline on window.__timelines.main (HyperFrames convention).

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
      --codec <c>         h264 | hevc (default: h264)
      --bitrate <b>       Target bitrate, e.g. 12M (default: scales with size and fps)
      --audio <file>      Audio track to mux (AAC)
      --subframes <n>     Sub-frames averaged per frame for motion blur (default: 1)
      --shutter <f>       Fraction of the frame interval the sub-frames span (default: 0.5)
      --background <css>  Color behind transparent DOM content (default: page background)
      --chrome <path>     Chrome binary (default: FRAMEVELO_CHROME, installed Chrome, Puppeteer cache)
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
      codec: { type: "string" },
      bitrate: { type: "string" },
      audio: { type: "string" },
      subframes: { type: "string" },
      shutter: { type: "string" },
      background: { type: "string" },
      chrome: { type: "string" },
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
  assign("codec", oneOf<Codec>("codec", values.codec, ["h264", "hevc"]));
  assign("bitrate", values.bitrate === undefined ? undefined : parseBitrate(values.bitrate));
  assign("audio", values.audio);
  assign("subframes", numberOption("subframes", values.subframes, (n) => Number.isInteger(n) && n >= 1));
  assign("shutter", numberOption("shutter", values.shutter, (n) => n >= 0 && n <= 1));
  assign("background", values.background);
  assign("chromePath", values.chrome);

  const result = await render(options);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!quiet) {
    const seconds = result.wallMs / 1000;
    process.stderr.write(
      `${path.relative(process.cwd(), result.output) || result.output}: ${result.frames} frames, ${result.width}x${result.height}, ` +
        `${(result.bytes / 1e6).toFixed(1)} MB in ${seconds.toFixed(2)} s (${(result.frames / (result.renderMs / 1000)).toFixed(1)} fps render)\n`,
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
  throw new Error(`Unknown command "${command}". Run framevelo --help.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`framevelo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
