// Model Context Protocol server over stdio, so coding agents can call FrameVelo as tools:
// `framevelo mcp`. Newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.
import path from "node:path";
import { createInterface } from "node:readline";
import { installHeadlessShell } from "./chrome.ts";
import { runDoctor } from "./doctor.ts";
import { parseBitrate } from "./options.ts";
import { render, type RenderOptions, type RenderResult } from "./render.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `FrameVelo renders code-driven videos to MP4 on the GPU and the hardware encoder.
- Inputs: a HyperFrames project, or an HTML page that is a pure function of
  time (window.__framevelo = { seek(t), duration }, window.__seek(t), or a paused GSAP timeline on
  window.__timelines.main). Pages driven by requestAnimationFrame loops or wall-clock time cannot be rendered.
- Use absolute paths. Renders run one at a time.
- Check a composition cheaply first: render a slice (start, frames: 30) with quality "draft".
- If a render fails before capturing (no Chrome, no FFmpeg), call doctor; install_browser fixes a missing Chrome.`;

const TOOLS = [
  {
    name: "render",
    title: "Render to MP4",
    description:
      "Render a code-driven video to MP4: a HyperFrames project, or any HTML page that is a pure function of time. " +
      "Returns the output path, frame count, size, timings and warnings. Duration, fps and size default to what the page declares.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "An .html file, or a directory containing index.html (absolute path)." },
        output: { type: "string", description: "Output .mp4 path. Default: <name>.mp4 next to the input." },
        fps: { type: "number", exclusiveMinimum: 0, description: "Frame rate; integers and NTSC rates (29.97, 59.94)." },
        duration: { type: "number", exclusiveMinimum: 0, description: "Seconds to render." },
        frames: { type: "integer", minimum: 1, description: "Exact frame count; overrides duration." },
        start: { type: "number", minimum: 0, description: "First frame time in seconds; audio is offset to match." },
        width: { type: "integer", minimum: 2, description: "Output width in pixels." },
        height: { type: "integer", minimum: 2, description: "Output height in pixels." },
        scale: { type: "number", exclusiveMinimum: 0, description: "Resolution multiplier: 2 renders a 1080p layout at 4K." },
        viewport: { type: "string", pattern: "^\\d+x\\d+$", description: "CSS viewport, e.g. 1080x1920. Default: declared by the page, else 1920x1080." },
        codec: { type: "string", enum: ["h264", "hevc"] },
        quality: { type: "string", enum: ["draft", "standard", "high"], description: "Bitrate preset; standard is about x264 CRF 18." },
        bitrate: { type: "string", description: "Target bitrate such as 12M; overrides quality." },
        audio: { type: "string", description: "Audio file to mux instead of the composition's own soundtrack." },
        subframes: { type: "integer", minimum: 1, description: "Sub-frames averaged per frame for motion blur." },
        shutter: { type: "number", minimum: 0, maximum: 1, description: "Fraction of the frame interval the sub-frames span (default 0.5)." },
        background: { type: "string", description: "CSS color behind transparent DOM content." },
        mode: { type: "string", enum: ["auto", "canvas", "dom"] },
        selector: { type: "string", description: "CSS selector of the element or canvas to capture." },
        capture: {
          type: "string",
          enum: ["auto", "dom", "screenshot"],
          description: "DOM pages: auto verifies drawElementImage against screenshots and falls back per interval.",
        },
        hyperframes: { type: "boolean", description: "false renders a HyperFrames project as a plain page." },
        workers: { type: "integer", minimum: 1, maximum: 16, description: "Most pages for Node-driven frames; 1 turns parallel pages off." },
        mounts: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Extra directories to serve, by URL prefix, e.g. {"/vendor/": "/path/to/vendor"}.',
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "doctor",
    title: "Check the machine",
    description: "Check Node, FFmpeg, Chrome, drawElementImage, the hardware encoders and HyperFrames support. Returns each check and whether FrameVelo can render.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "install_browser",
    title: "Install chrome-headless-shell",
    description: "Download chrome-headless-shell (about 100 MB) into the FrameVelo cache. Needed when no Chrome 151+ is installed; uses about half the CPU and memory of full Chrome.",
    inputSchema: {
      type: "object",
      properties: { version: { type: "string", description: "stable (default), beta, or a version number." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

type Json = Record<string, unknown>;
interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}
type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Json; isError?: boolean };

/** `<name>.mp4` next to the input: the page's name, or the project directory's name for index.html. */
export function defaultOutputFor(input: string): string {
  const resolved = path.resolve(input);
  const ext = path.extname(resolved);
  const base = ext ? path.basename(resolved, ext) : path.basename(resolved);
  if (ext && base !== "index") return path.join(path.dirname(resolved), `${base}.mp4`);
  const project = ext ? path.dirname(resolved) : resolved;
  return path.join(path.dirname(project), `${path.basename(project)}.mp4`);
}

/** Map `render` tool arguments onto RenderOptions; JSON Schema types are checked here too. */
export function renderOptionsFromArgs(args: Json): RenderOptions {
  const known = new Set(Object.keys(TOOLS[0]!.inputSchema.properties));
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}.`);
  const string = (key: string) => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string.`);
    return value;
  };
  const number = (key: string, integer = false) => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      throw new Error(`${key} must be ${integer ? "an integer" : "a number"}.`);
    }
    return value;
  };
  const choice = <T extends string>(key: string, allowed: readonly T[]) => {
    const value = string(key);
    if (value !== undefined && !allowed.includes(value as T)) throw new Error(`${key} must be one of ${allowed.join(", ")}.`);
    return value as T | undefined;
  };
  const input = string("input");
  if (!input) throw new Error("input is required: an .html file or a project directory.");
  const options: RenderOptions = { input, output: path.resolve(string("output") ?? defaultOutputFor(input)) };
  const set = <K extends keyof RenderOptions>(key: K, value: RenderOptions[K] | undefined) => {
    if (value !== undefined) options[key] = value;
  };
  set("fps", number("fps"));
  set("duration", number("duration"));
  set("frames", number("frames", true));
  set("start", number("start"));
  set("width", number("width", true));
  set("height", number("height", true));
  set("scale", number("scale"));
  const viewport = string("viewport");
  if (viewport !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(viewport);
    if (!match) throw new Error("viewport must be WIDTHxHEIGHT, such as 1920x1080.");
    options.viewport = { width: Number(match[1]), height: Number(match[2]) };
  }
  set("codec", choice("codec", ["h264", "hevc"] as const));
  set("quality", choice("quality", ["draft", "standard", "high"] as const));
  const bitrate = args.bitrate;
  if (bitrate !== undefined) options.bitrate = typeof bitrate === "number" ? bitrate : parseBitrate(String(bitrate));
  set("audio", string("audio"));
  set("subframes", number("subframes", true));
  set("shutter", number("shutter"));
  set("background", string("background"));
  set("mode", choice("mode", ["auto", "canvas", "dom"] as const));
  set("selector", string("selector"));
  set("capture", choice("capture", ["auto", "dom", "screenshot"] as const));
  set("workers", number("workers", true));
  if (args.hyperframes !== undefined) {
    if (typeof args.hyperframes !== "boolean") throw new Error("hyperframes must be a boolean.");
    if (!args.hyperframes) options.hyperframes = "off";
  }
  if (args.mounts !== undefined) {
    const mounts = args.mounts;
    if (!mounts || typeof mounts !== "object" || Array.isArray(mounts) || Object.values(mounts).some((dir) => typeof dir !== "string")) {
      throw new Error('mounts must map URL prefixes to directories, e.g. {"/vendor/": "/path/to/vendor"}.');
    }
    options.mounts = Object.fromEntries(Object.entries(mounts as Record<string, string>).map(([prefix, dir]) => [prefix, path.resolve(dir)]));
  }
  return options;
}

/** The parts of a render result an agent acts on; the full route plan and page stats stay out. */
function summarize(result: RenderResult, log: string[]): Json {
  return {
    output: result.output,
    frames: result.frames,
    fps: result.fps,
    width: result.width,
    height: result.height,
    codec: result.codec,
    bitrate: result.bitrate,
    bytes: result.bytes,
    audio: result.audio,
    pipeline: result.pipeline,
    driver: result.driver,
    mode: result.mode,
    hardwareEncoder: result.hardwareEncoder,
    wallMs: result.wallMs,
    stages: result.stages,
    screenshotFrames: result.screenshotFrames,
    workers: result.workers,
    warnings: result.warnings,
    log: log.slice(-40),
  };
}

const text = (value: unknown): ToolResult["content"] => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];

/** Run the server until stdin closes. */
export async function serveMcp(version: string): Promise<void> {
  // stdout carries protocol messages only: anything a dependency logs goes to stderr.
  for (const method of ["log", "info", "debug", "warn"] as const) console[method] = (...args: unknown[]) => console.error(...args);
  const send = (message: Json): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const running = new Map<string | number, AbortController>();
  let queue: Promise<unknown> = Promise.resolve();

  const callTool = async (name: string, args: Json, progressToken: unknown, signal: AbortSignal): Promise<ToolResult> => {
    if (name === "doctor") {
      const checks = await runDoctor();
      const ready = !checks.some((check) => !check.ok && !check.optional);
      return { content: text({ ready, checks }), structuredContent: { ready, checks } };
    }
    if (name === "install_browser") {
      const version = typeof args.version === "string" ? args.version : "stable";
      const installed = await installHeadlessShell(version);
      const result = { version: installed.buildId, executablePath: installed.executablePath };
      return { content: text(result), structuredContent: result };
    }
    const options = renderOptionsFromArgs(args);
    const log: string[] = [];
    let lastProgress = 0;
    // One render at a time: they share the GPU and the hardware encoder.
    const run = queue.then(() =>
      render({
        ...options,
        signal,
        onLog: (line) => {
          log.push(line);
          process.stderr.write(`${line}\n`);
        },
        onProgress: (done, total) => {
          if (progressToken === undefined) return;
          const now = performance.now();
          if (done < total && now - lastProgress < 500) return;
          lastProgress = now;
          send({ method: "notifications/progress", params: { progressToken, progress: done, total, message: `${done}/${total} frames` } });
        },
      }),
    );
    queue = run.catch(() => {});
    const summary = summarize(await run, log);
    return { content: text(summary), structuredContent: summary };
  };

  const handle = async (message: Message): Promise<void> => {
    const { id, method, params = {} } = message;
    if (method === undefined) return; // a response to a request we never send
    if (id === undefined || id === null) {
      if (method === "notifications/cancelled") running.get(params.requestId as string | number)?.abort(new Error("Cancelled by the client."));
      return;
    }
    const reply = (result: Json) => send({ id, result });
    const fail = (code: number, text: string) => send({ id, error: { code, message: text } });
    if (method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "framevelo", title: "FrameVelo", version },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method !== "tools/call") return fail(-32601, `Method not found: ${method}`);
    const name = String(params.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool: ${name}`);
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const args = (params.arguments ?? {}) as Json;
      const progressToken = (params._meta as Json | undefined)?.progressToken;
      const result = await callTool(name, args, progressToken, controller.signal);
      if (!controller.signal.aborted) reply(result);
    } catch (error) {
      // Tool failures are results the model can read and act on, not protocol errors.
      if (!controller.signal.aborted) reply({ content: text(error instanceof Error ? error.message : String(error)), isError: true });
    } finally {
      running.delete(id);
    }
  };

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const task = handle(message).catch((error: unknown) => {
      process.stderr.write(`framevelo mcp: ${String(error)}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  // The client went away: stop renders so their pages close and partial files are removed.
  for (const controller of running.values()) controller.abort(new Error("The client disconnected."));
  await Promise.all(pending);
}
