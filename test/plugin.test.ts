import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (file: string) => JSON.parse(readFileSync(path.join(repo, file), "utf8")) as Record<string, unknown>;

test("the marketplace lists the plugin directory", () => {
  const marketplace = json(".claude-plugin/marketplace.json") as { name: string; owner: { name: string }; plugins: Array<{ name: string; source: string }> };
  assert.equal(marketplace.name, "framevelo");
  assert.ok(marketplace.owner.name);
  assert.deepEqual(
    marketplace.plugins.map((p) => [p.name, p.source]),
    [["framevelo", "./plugin"]],
  );
});

test("the plugin version follows package.json", () => {
  const plugin = json("plugin/.claude-plugin/plugin.json") as { name: string; version: string; description: string };
  assert.equal(plugin.name, "framevelo");
  assert.equal(plugin.version, (json("package.json") as { version: string }).version);
  assert.ok(plugin.description.length > 20);
});

test("the MCP server starts through the launcher script", () => {
  const mcp = json("plugin/.mcp.json") as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(mcp.mcpServers.framevelo, { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh"] });
  execFileSync("sh", ["-n", path.join(repo, "plugin", "scripts", "mcp.sh")]);
});

test("the skill has a name and a description in its front matter", () => {
  const skill = readFileSync(path.join(repo, "plugin", "skills", "framevelo", "SKILL.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  assert.match(front, /^name: framevelo$/m);
  const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
  assert.ok(description.length > 100 && description.length < 1024, `description length ${description.length}`);
});
