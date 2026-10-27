// Start the FrameVelo MCP server on stdio, on macOS, Linux and Windows.
// - A global install (npm install -g github:gnipbao/framevelo ...) starts at once.
// - Otherwise FrameVelo and the HyperFrames packages are installed once into the user's cache, per
//   plugin version, and reused. The first start takes about a minute.
// Nothing but the server writes to stdout: this script logs to stderr.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(here, "..", ".claude-plugin", "plugin.json"), "utf8"));
const dir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "framevelo", `agent-${version}`);
const lock = path.join(dir, ".installing");
const cliIn = (modules) => path.join(modules, "framevelo", "dist", "cli.js");

/** Run the server in a child that owns stdio, and exit with it. */
function serve(cli) {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: "inherit", windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const globalModules = spawnSync(npm, ["root", "-g"], { encoding: "utf8", shell: windows, windowsHide: true }).stdout?.trim();
if (globalModules && existsSync(cliIn(globalModules))) {
  serve(cliIn(globalModules));
} else {
  const cli = cliIn(path.join(dir, "node_modules"));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The install runs detached, so a client that gives up on the slow first start does not kill it
  // halfway; the next start finds it finished. The HyperFrames packages depend on puppeteer, whose
  // own Chrome download FrameVelo does not need.
  const installer = `
    const { spawnSync } = require("node:child_process");
    const { rmSync } = require("node:fs");
    const [dir, lock, spec] = process.argv.slice(1);
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? "npm.cmd" : "npm",
      ["install", "--no-fund", "--no-audit", "--loglevel=error", spec, "@hyperframes/producer@0.8.186", "@hyperframes/engine@0.8.186"],
      { cwd: dir, stdio: "inherit", shell: windows, windowsHide: true, env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" } });
    rmSync(lock, { recursive: true, force: true });
    process.exit(result.status ?? 1);`;
  let attempts = 0;
  const wait = () => {
    if (existsSync(cli) && !existsSync(lock)) return serve(cli);
    if (!existsSync(cli)) {
      mkdirSync(dir, { recursive: true });
      let owner = false;
      try {
        mkdirSync(lock);
        owner = true;
      } catch {
        // Another start is installing: wait for it.
      }
      if (owner) {
        if (attempts >= 2) {
          rmSync(lock, { recursive: true, force: true });
          process.stderr.write(`framevelo: install failed; see ${path.join(dir, "install.log")}\n`);
          process.exit(1);
        }
        attempts++;
        process.stderr.write(`framevelo: first start, installing into ${dir} (about a minute)\n`);
        const log = openSync(path.join(dir, "install.log"), "w");
        const spec = process.env.FRAMEVELO_SPEC ?? "github:gnipbao/framevelo";
        const child = spawn(process.execPath, ["-e", installer, dir, lock, spec], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
        writeFileSync(path.join(lock, "pid"), String(child.pid));
        child.unref();
      }
    }
    // An install killed along with its client leaves a stale lock: the next pass retries.
    let pid = 0;
    try {
      pid = Number(readFileSync(path.join(lock, "pid"), "utf8"));
    } catch {
      // No lock, or one being written.
    }
    if (pid && !alive(pid)) rmSync(lock, { recursive: true, force: true });
    setTimeout(wait, 1000);
  };
  wait();
}
