import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultOutputFor, renderOptionsFromArgs } from "../src/mcp.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const examples = path.join(here, "..", "examples");

test("defaultOutputFor puts <name>.mp4 next to the input", () => {
  assert.equal(defaultOutputFor("/work/promo"), "/work/promo.mp4");
  assert.equal(defaultOutputFor("/work/promo/"), "/work/promo.mp4");
  assert.equal(defaultOutputFor("/work/promo/index.html"), "/work/promo.mp4");
  assert.equal(defaultOutputFor("/work/scenes/intro.html"), "/work/scenes/intro.mp4");
});

test("renderOptionsFromArgs maps and checks tool arguments", () => {
  const options = renderOptionsFromArgs({
    input: "/work/promo",
    output: "/out/a.mp4",
    frames: 30,
    viewport: "1080x1920",
    quality: "draft",
    bitrate: "12M",
    hyperframes: false,
    mounts: { "/@skill/": "/skills/code-video" },
  });
  assert.equal(options.output, "/out/a.mp4");
  assert.equal(options.frames, 30);
  assert.deepEqual(options.viewport, { width: 1080, height: 1920 });
  assert.equal(options.quality, "draft");
  assert.equal(options.bitrate, 12_000_000);
  assert.equal(options.hyperframes, "off");
  assert.deepEqual(options.mounts, { "/@skill/": "/skills/code-video" });
  assert.equal(renderOptionsFromArgs({ input: "/work/promo" }).output, "/work/promo.mp4");
  assert.throws(() => renderOptionsFromArgs({}), /input is required/);
  assert.throws(() => renderOptionsFromArgs({ input: "/a", frames: 1.5 }), /frames must be an integer/);
  assert.throws(() => renderOptionsFromArgs({ input: "/a", codec: "vp9" }), /codec must be one of/);
  assert.throws(() => renderOptionsFromArgs({ input: "/a", fsp: 30 }), /Unknown argument\(s\): fsp/);
});

/** A minimal MCP client over the server's stdio. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  private nextId = 1;
  private waiting = new Map<number, (message: Record<string, unknown>) => void>();
  stderr = "";

  constructor(cwd: string) {
    this.child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.id !== undefined && message.id !== null) this.waiting.get(message.id as number)?.(message);
      else if (message.method) this.notifications.push(message as never);
      else this.notifications.push({ method: "error", params: message });
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}): { id: number; response: Promise<Record<string, unknown>> } {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    this.send({ id, method, params });
    return { id, response };
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request(method, params).response;
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.on("close", resolve));
  }
}

describe("mcp server (protocol)", () => {
  let client: Client;
  before(() => {
    client = new Client(os.tmpdir());
  });
  after(async () => {
    await client.close();
  });

  test("initialize negotiates the protocol and lists the tools", async () => {
    const init = (await client.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    })) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown>; instructions: string } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "framevelo");
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /absolute paths/);
    client.send({ method: "notifications/initialized" });
    const list = (await client.call("tools/list")) as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["render", "doctor", "install_browser"]);
    assert.deepEqual(list.result.tools[0]!.inputSchema.required, ["input"]);
  });

  test("an unknown protocol version gets the newest supported one", async () => {
    const init = (await client.call("initialize", { protocolVersion: "1999-01-01", capabilities: {} })) as { result: { protocolVersion: string } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
  });

  test("protocol errors: unknown method, unknown tool, malformed JSON", async () => {
    const method = (await client.call("resources/list")) as { error: { code: number } };
    assert.equal(method.error.code, -32601);
    const tool = (await client.call("tools/call", { name: "nope", arguments: {} })) as { error: { code: number } };
    assert.equal(tool.error.code, -32602);
    client.child.stdin.write("{not json\n");
    const ping = (await client.call("ping")) as { result: unknown };
    assert.deepEqual(ping.result, {});
    assert.ok(client.notifications.some((n) => n.method === "error" && (n.params.error as { code: number }).code === -32700));
  });

  test("tool failures come back as results the model can read", async () => {
    const missing = (await client.call("tools/call", { name: "render", arguments: { input: "/no/such/project" } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0]!.text, /not found/i);
    const invalid = (await client.call("tools/call", { name: "render", arguments: { input: "/a", quality: "ultra" } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0]!.text, /quality must be one of/);
  });
});

describe("mcp server (integration)", { skip: process.env.FRAMEVELO_INTEGRATION !== "1" && "set FRAMEVELO_INTEGRATION=1" }, () => {
  let dir: string;
  let client: Client;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-mcp-"));
    client = new Client(dir);
    await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    client.send({ method: "notifications/initialized" });
  });
  after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("render reports progress and returns a summary", async () => {
    const output = path.join(dir, "cards.mp4");
    const response = (await client.call("tools/call", {
      name: "render",
      arguments: { input: path.join(examples, "dom-cards"), output, frames: 30, quality: "draft" },
      _meta: { progressToken: "p1" },
    })) as { result: { isError?: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> } };
    assert.ok(!response.result.isError, response.result.content[0]?.text);
    const summary = response.result.structuredContent;
    assert.equal(summary.output, output);
    assert.equal(summary.frames, 30);
    assert.equal(summary.mode, "dom");
    assert.ok(Array.isArray(summary.log));
    assert.deepEqual(JSON.parse(response.result.content[0]!.text), summary);
    assert.ok(existsSync(output));
    const progress = client.notifications.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "p1");
    assert.ok(progress.length > 0);
    assert.equal(progress.at(-1)!.params.progress, 30);
  });

  test("a cancelled render stops and leaves no files", async () => {
    const output = path.join(dir, "cancelled.mp4");
    const { id } = client.request("tools/call", {
      name: "render",
      arguments: { input: path.join(examples, "dom-cards"), output, frames: 600, scale: 2 },
      _meta: { progressToken: "p2" },
    });
    while (!client.notifications.some((n) => n.method === "notifications/progress" && n.params.progressToken === "p2")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    client.send({ method: "notifications/cancelled", params: { requestId: id, reason: "test" } });
    // The server stays usable and the next request is answered once the render has stopped.
    const ping = (await client.call("ping")) as { result: unknown };
    assert.deepEqual(ping.result, {});
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await readdir(dir)).some((name) => name.includes("cancelled"))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes("cancelled")), []);
  });
});
