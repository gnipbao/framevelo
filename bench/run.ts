// Benchmark FrameVelo against `hyperframes render` on this machine and write the results as JSON.
//
//   node bench/run.ts [--suite gsap,fixtures,workers,browser,remotion] [--repeats 3] [--fixtures <dir>] [--out <file>]
//
// Suites:
//   gsap      the GSAP showcase (bench/fixtures/gsap-showcase, 10 s) at 1080p and 4K: official
//             default, official --gpu, FrameVelo; median of --repeats interleaved runs
//   fixtures  the official HyperFrames regression fixtures, once each, with per-frame PSNR
//   workers   a 1516-frame video fixture with 1 to 4 FrameVelo pages
//   browser   FrameVelo on chrome-headless-shell against full Google Chrome
//   remotion  `remotion render` against FrameVelo: Remotion's hello-world template at 1080p and 4K,
//             and test/fixtures/remotion (a 3 s 720p scene with <OffthreadVideo> and <Audio>, and a
//             20 s 1080p motion-graphics showcase); median of --repeats
//
// Measure on an idle machine: other renders, screen recorders and video calls skew every number.
// Fixtures come from the HyperFrames repository at the tag of the pinned producer version (cloned into
// ~/.cache/framevelo/bench unless --fixtures points at packages/producer/tests of a checkout).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { findChrome } from "../src/chrome.ts";
import { prepareRemotionFixture } from "../scripts/remotion-fixture.ts";
import { framePsnr, measure, medianRun, round, streams, type Measured } from "./measure.ts";

const HYPERFRAMES = "0.8.186";
const REMOTION = "4.0.539";
/** Official regression fixtures (packages/producer/tests) that render on macOS without extra services. */
export const FIXTURES = [
  "nested-subcomp-depth-3",
  "css-spinner-render-compat",
  "raf-ball-render-compat",
  "gsap-letters-render-compat",
  "many-cuts",
  "speed-ramp",
  "animejs-adapter",
  "html-dir-rtl",
  "transparency-regression",
  "style-1-prod",
  "style-5-prod",
  "sub-composition-video",
  "typegpu-adapter",
  "webgl-video-texture-render-compat",
  "iframe-render-compat",
  "pip-video-late-host",
  "variables-prod",
  "hf2550-video-subcomposition-ghost",
  "nested-sequential-video-local-start",
  "timed-descendant-visibility",
  "vignelli-stacking",
  "page-side-shader-compositor-render-compat",
  "gsap-call-render-seek",
  "sub-comp-t0",
];
const WORKERS_FIXTURE = "hf2550-video-subcomposition-ghost";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(repo, "src", "cli.ts");
const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "gsap,fixtures,workers,browser,remotion" },
    repeats: { type: "string", default: "3" },
    fixtures: { type: "string" },
    out: { type: "string" },
    work: { type: "string", default: path.join(repo, "out", "bench") },
  },
});
const suites = new Set(values.suite!.split(","));
const repeats = Math.max(1, Number(values.repeats));
const work = path.resolve(values.work!);
mkdirSync(work, { recursive: true });
const say = (line: string) => process.stderr.write(`${line}\n`);

type Run = Pick<Measured, "wallS" | "cpuS" | "peakMb">;
const keep = (m: Measured): Run => ({ wallS: round(m.wallS), cpuS: round(m.cpuS, 1), peakMb: m.peakMb });

function check(m: Measured, what: string): Measured {
  if (!m.ok) throw new Error(`${what} failed:\n${m.log.trim().split("\n").slice(-8).join("\n")}`);
  return m;
}

const official = (project: string, output: string, extra: string[] = []) =>
  measure("npx", ["-y", `hyperframes@${HYPERFRAMES}`, "render", project, "-o", output, "--quiet", ...extra]);
const framevelo = (project: string, output: string, extra: string[] = []) =>
  measure(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "render", project, "-o", output, "-q", "--json", ...extra]);

function tool(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function machine() {
  const chrome = findChrome();
  return {
    model: tool("sysctl", ["-n", "hw.model"]),
    cpu: tool("sysctl", ["-n", "machdep.cpu.brand_string"]) || os.cpus()[0]?.model || "",
    cores: os.availableParallelism(),
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${tool("sw_vers", ["-productName"])} ${tool("sw_vers", ["-productVersion"])}`.trim() || `${os.type()} ${os.release()}`,
    node: process.version,
    chrome: chrome ? `${path.basename(chrome)} ${tool(chrome, ["--version"]).replace(/^\D+/, "")}` : "",
    ffmpeg: tool("ffmpeg", ["-version"]).split("\n")[0]?.replace(/ Copyright.*/, "") ?? "",
  };
}

/** The GSAP showcase with GSAP copied next to it (GSAP is a dev dependency, not checked in). */
function gsapProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "framevelo-bench-gsap-"));
  copyFileSync(path.join(repo, "bench", "fixtures", "gsap-showcase", "index.html"), path.join(dir, "index.html"));
  copyFileSync(path.join(repo, "node_modules", "gsap", "dist", "gsap.min.js"), path.join(dir, "gsap.min.js"));
  return dir;
}

function fixturesDir(): string {
  if (values.fixtures) return path.resolve(values.fixtures);
  const checkout = path.join(os.homedir(), ".cache", "framevelo", "bench", `hyperframes-${HYPERFRAMES}`);
  if (!existsSync(path.join(checkout, "packages", "producer", "tests"))) {
    say(`cloning heygen-com/hyperframes v${HYPERFRAMES} for its regression fixtures...`);
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", `v${HYPERFRAMES}`, "https://github.com/heygen-com/hyperframes", checkout], {
      stdio: "inherit",
    });
  }
  return path.join(checkout, "packages", "producer", "tests");
}

/** Remotion's hello-world template, scaffolded once into the cache at the pinned version. */
function remotionTemplate(): string {
  const dir = path.join(os.homedir(), ".cache", "framevelo", "bench", `remotion-hello-world-${REMOTION}`);
  if (!existsSync(path.join(dir, "node_modules", "@remotion", "cli"))) {
    say(`scaffolding Remotion's hello-world template ${REMOTION}...`);
    rmSync(dir, { recursive: true, force: true });
    execFileSync("npx", ["-y", `create-video@${REMOTION}`, "--yes", "--hello-world", dir], { stdio: "inherit" });
  }
  return dir;
}

const fixtureProject = (tests: string, name: string) =>
  existsSync(path.join(tests, name, "src", "index.html")) ? path.join(tests, name, "src") : path.join(tests, name);

const results: Record<string, unknown> = {
  version: 1,
  date: new Date().toISOString(),
  framevelo: {
    version: (JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string }).version,
    commit: tool("git", ["-C", repo, "rev-parse", "--short", "HEAD"]),
  },
  hyperframes: HYPERFRAMES,
  machine: machine(),
  repeats,
};
const load = os.loadavg()[0]!;
if (load > os.availableParallelism() / 4) say(`warning: load average ${load.toFixed(1)}; other work on this machine will skew the numbers`);
// The 1-minute load average before and after the suites, for the report: other work skews the numbers.
const loadAverage = { start: round(load, 1), end: 0 };
results.loadAverage = loadAverage;

// Fetch the official CLI once so that its first measured run does not include the download.
if (["gsap", "fixtures"].some((suite) => suites.has(suite))) {
  check(await measure("npx", ["-y", `hyperframes@${HYPERFRAMES}`, "--version"]), "installing the official CLI");
}

if (suites.has("gsap")) {
  const project = gsapProject();
  const configs = [
    { resolution: "1080p", renderer: "official", run: (o: string) => official(project, o) },
    { resolution: "1080p", renderer: "official-gpu", run: (o: string) => official(project, o, ["--gpu"]) },
    { resolution: "1080p", renderer: "framevelo", run: (o: string) => framevelo(project, o) },
    { resolution: "4k", renderer: "official", run: (o: string) => official(project, o, ["--resolution", "4k"]) },
    { resolution: "4k", renderer: "official-gpu", run: (o: string) => official(project, o, ["--resolution", "4k", "--gpu"]) },
    { resolution: "4k", renderer: "framevelo", run: (o: string) => framevelo(project, o, ["--scale", "2"]) },
  ];
  const runs = new Map<(typeof configs)[number], Run[]>(configs.map((c) => [c, []]));
  for (let r = 0; r < repeats; r++) {
    for (const config of configs) {
      const output = path.join(work, `gsap-${config.resolution}-${config.renderer}.mp4`);
      const m = check(await config.run(output), `gsap ${config.resolution} ${config.renderer}`);
      runs.get(config)!.push(keep(m));
      say(`gsap ${config.resolution} ${config.renderer} #${r + 1}: ${m.wallS.toFixed(1)} s, ${m.cpuS.toFixed(1)} s CPU, ${m.peakMb} MB`);
    }
  }
  results.gsap = configs.map((config) => {
    const output = path.join(work, `gsap-${config.resolution}-${config.renderer}.mp4`);
    const psnr = config.renderer === "official" ? null : framePsnr(output, path.join(work, `gsap-${config.resolution}-official.mp4`));
    return {
      resolution: config.resolution,
      renderer: config.renderer,
      ...medianRun(runs.get(config)!),
      runs: runs.get(config),
      frames: streams(output).frames,
      mb: round(statSync(output).size / 1e6, 1),
      ...(psnr ? { psnrAvg: round(psnr.average, 1), psnrMin: round(psnr.min, 1) } : {}),
    };
  });
}

let tests: string | undefined;
if (suites.has("fixtures")) {
  tests = fixturesDir();
  const rows = [];
  for (const name of FIXTURES) {
    const project = fixtureProject(tests, name);
    const a = path.join(work, `${name}.official.mp4`);
    const b = path.join(work, `${name}.framevelo.mp4`);
    const hf = await official(project, a);
    const fv = await framevelo(project, b);
    const row: Record<string, unknown> = { name, official: { ok: hf.ok, ...keep(hf) }, framevelo: { ok: fv.ok, ...keep(fv) } };
    if (hf.ok && fv.ok) {
      const psnr = framePsnr(b, a);
      Object.assign(row, {
        frames: streams(b).frames,
        officialFrames: streams(a).frames,
        audio: streams(b).audio,
        officialAudio: streams(a).audio,
        ...(psnr ? { psnrAvg: round(psnr.average, 1), psnrMin: round(psnr.min, 1) } : {}),
      });
    } else {
      row.error = (fv.ok ? hf : fv).log.trim().split("\n").slice(-3).join(" | ");
    }
    rows.push(row);
    say(`${name}: ${hf.wallS.toFixed(1)} s -> ${fv.wallS.toFixed(1)} s${row.psnrAvg !== undefined ? `, ${row.psnrAvg} dB` : ` (${row.error})`}`);
  }
  results.fixtures = rows;
}

if (suites.has("workers")) {
  tests ??= fixturesDir();
  const project = fixtureProject(tests, WORKERS_FIXTURE);
  const reference = path.join(work, `${WORKERS_FIXTURE}.official.mp4`);
  const rows = [];
  for (const n of [1, 2, 3, 4]) {
    const output = path.join(work, `workers-${n}.mp4`);
    const m = check(await framevelo(project, output, ["--workers", String(n)]), `workers ${n}`);
    const json = JSON.parse(m.stdout) as { stages: { renderMs: number }; workers: number };
    const psnr = existsSync(reference) ? framePsnr(output, reference) : null;
    rows.push({ workers: n, pages: json.workers, renderS: round(json.stages.renderMs / 1000), ...keep(m), ...(psnr ? { psnrAvg: round(psnr.average, 1), psnrMin: round(psnr.min, 1) } : {}) });
    say(`workers ${n}: render ${(json.stages.renderMs / 1000).toFixed(1)} s, ${m.cpuS.toFixed(1)} s CPU, ${m.peakMb} MB`);
  }
  results.workers = { fixture: WORKERS_FIXTURE, rows };
}

if (suites.has("browser")) {
  const shell = findChrome();
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (shell && existsSync(chrome) && shell !== chrome) {
    const project = gsapProject();
    const browsers = [
      { browser: "chrome-headless-shell", args: ["--chrome", shell] },
      { browser: "chrome", args: ["--chrome", chrome] },
    ];
    const runs = new Map<string, Run[]>(browsers.map((b) => [b.browser, []]));
    for (let r = 0; r < repeats; r++) {
      for (const b of browsers) {
        const m = check(await framevelo(project, path.join(work, `browser-${b.browser}.mp4`), b.args), `browser ${b.browser}`);
        runs.get(b.browser)!.push(keep(m));
      }
    }
    results.browser = browsers.map((b) => ({ browser: b.browser, ...medianRun(runs.get(b.browser)!), runs: runs.get(b.browser) }));
  } else {
    say("browser suite skipped: needs both chrome-headless-shell and Google Chrome");
  }
}

if (suites.has("remotion")) {
  const hello = remotionTemplate();
  const fixture = prepareRemotionFixture();
  const remotionCli = (dir: string) => path.join(dir, "node_modules", "@remotion", "cli", "remotion-cli.js");
  const cases = [
    { name: "hello-world", label: "Hello World, 1080p", dir: hello, composition: "HelloWorld", extra: [] as string[] },
    { name: "hello-world-4k", label: "Hello World, 4K", dir: hello, composition: "HelloWorld", extra: ["--scale", "2"] },
    { name: "fixture", label: "Video + audio, 720p", dir: fixture, composition: "Scene", extra: [] as string[] },
    { name: "showcase", label: "Showcase 20 s, 1080p", dir: fixture, composition: "Showcase", extra: [] as string[] },
  ];
  const renderers = [
    // BT.709 like FrameVelo (Remotion 4 defaults to BT.601), so that the PSNR compares like with like.
    { renderer: "remotion", run: (c: (typeof cases)[number], o: string) => measure(process.execPath, [remotionCli(c.dir), "render", c.composition, o, "--log=error", "--color-space=bt709", ...c.extra], { cwd: c.dir }) },
    { renderer: "framevelo", run: (c: (typeof cases)[number], o: string) => framevelo(c.dir, o, ["--composition", c.composition, ...c.extra]) },
  ];
  // Remotion fetches its browser on first use: keep that out of the measured runs.
  check(await renderers[0]!.run(cases[2]!, path.join(work, "remotion-warmup.mp4")), "remotion render (warm-up)");
  const runs = new Map<string, Run[]>();
  for (let r = 0; r < repeats; r++) {
    for (const c of cases) {
      for (const { renderer, run } of renderers) {
        const key = `${c.name}/${renderer}`;
        const m = check(await run(c, path.join(work, `remotion-${c.name}-${renderer}.mp4`)), `remotion ${key}`);
        runs.set(key, [...(runs.get(key) ?? []), keep(m)]);
        say(`remotion ${key} #${r + 1}: ${m.wallS.toFixed(1)} s, ${m.cpuS.toFixed(1)} s CPU, ${m.peakMb} MB`);
      }
    }
  }
  results.remotion = {
    version: REMOTION,
    rows: cases.flatMap((c) =>
      renderers.map(({ renderer }) => {
        const output = path.join(work, `remotion-${c.name}-${renderer}.mp4`);
        const reference = path.join(work, `remotion-${c.name}-remotion.mp4`);
        const psnr = renderer === "remotion" ? null : framePsnr(output, reference);
        const info = streams(output);
        return {
          case: c.name,
          label: c.label,
          renderer,
          ...medianRun(runs.get(`${c.name}/${renderer}`)!),
          runs: runs.get(`${c.name}/${renderer}`),
          frames: info.frames,
          audio: info.audio,
          mb: round(statSync(output).size / 1e6, 1),
          ...(psnr ? { psnrAvg: round(psnr.average, 1), psnrMin: round(psnr.min, 1) } : {}),
        };
      }),
    ),
  };
}

loadAverage.end = round(os.loadavg()[0]!, 1);
const out = path.resolve(values.out ?? path.join(repo, "bench", "results", `${new Date().toISOString().slice(0, 10)}.json`));
mkdirSync(path.dirname(out), { recursive: true });
let previous: Record<string, unknown> = {};
// Re-running some suites keeps the others from the same day's file.
if (existsSync(out)) previous = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
writeFileSync(out, `${JSON.stringify({ ...previous, ...results }, null, 2)}\n`);
say(`results: ${path.relative(process.cwd(), out)}`);
