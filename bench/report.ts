// Turn a results file from bench/run.ts into docs/benchmarks.md and its charts (light and dark SVG).
//
//   node bench/report.ts [bench/results/<file>.json...]   (default: every file in bench/results)
//
// Each suite comes from the newest file that has it; the report lists which run each suite is from.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Run {
  wallS: number;
  cpuS: number;
  peakMb: number;
}
interface GsapRow extends Run {
  resolution: string;
  renderer: "official" | "official-gpu" | "framevelo";
  runs: Run[];
  frames: number;
  mb: number;
  psnrAvg?: number;
  psnrMin?: number;
}
interface FixtureRow {
  name: string;
  official: Run & { ok: boolean };
  framevelo: Run & { ok: boolean };
  frames?: number;
  officialFrames?: number;
  audio?: boolean;
  officialAudio?: boolean;
  psnrAvg?: number;
  psnrMin?: number;
  error?: string;
}
interface Results {
  date: string;
  framevelo: { version: string; commit: string };
  hyperframes: string;
  machine: { model: string; cpu: string; cores: number; memoryGb: number; os: string; node: string; chrome: string; ffmpeg: string };
  repeats: number;
  loadAverage?: { start: number; end: number };
  gsap?: GsapRow[];
  fixtures?: FixtureRow[];
  workers?: { fixture: string; rows: Array<Run & { workers: number; pages: number; renderS: number; psnrAvg?: number; psnrMin?: number }> };
  browser?: Array<Run & { browser: string }>;
  remotion?: {
    version: string;
    rows: Array<Run & { case: string; label: string; renderer: string; frames: number; audio: boolean; mb: number; runs: Run[]; psnrAvg?: number; psnrMin?: number }>;
  };
}

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const resultsDir = path.join(repo, "bench", "results");
const SUITES = ["gsap", "fixtures", "workers", "browser", "remotion"] as const;
const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(resultsDir, f));
const runsByDate = files.map((file) => ({ file, data: JSON.parse(readFileSync(file, "utf8")) as Results })).sort((a, b) => a.data.date.localeCompare(b.data.date));
const newest = runsByDate.at(-1)!;
/** The newest run that measured each suite. */
const sourceOf = new Map(SUITES.flatMap((suite) => {
  const run = runsByDate.findLast((r) => r.data[suite] !== undefined);
  return run ? [[suite, run] as const] : [];
}));
const results: Results = { ...newest.data };
for (const suite of SUITES) (results as unknown as Record<string, unknown>)[suite] = sourceOf.get(suite)?.data[suite];
/** Repeats as the run that measured the charted suite used them. */
const repeatsOf = (suite: (typeof SUITES)[number]) => sourceOf.get(suite)?.data.repeats ?? results.repeats;
const assets = path.join(repo, "docs", "assets");

// ---------- charts ----------

/** Chart tokens: the reference data-viz palette, light and dark steps of the same hues. */
const THEMES = {
  light: {
    surface: "#fcfcfb",
    border: "rgba(11,11,11,0.10)",
    ink: "#0b0b0b",
    secondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    framevelo: "#2a78d6",
    official: "#eb6834",
    officialGpu: "#1baf7a",
  },
  dark: {
    surface: "#1a1a19",
    border: "rgba(255,255,255,0.10)",
    ink: "#f0efec",
    secondary: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    framevelo: "#3987e5",
    official: "#d95926",
    officialGpu: "#199e70",
  },
};
type Theme = (typeof THEMES)["light"];
const FONT = `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x: number, y: number, body: string, attrs = "") => `<text x="${x}" y="${y}" ${attrs}>${esc(body)}</text>`;

/** A horizontal bar growing from x0: square at the baseline, 4px rounded data end. */
function bar(x0: number, y: number, length: number, thickness: number, fill: string): string {
  const r = Math.min(4, length / 2, thickness / 2);
  const x1 = x0 + Math.max(length, 0.5);
  return `<path d="M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + thickness - r} Q${x1},${y + thickness} ${x1 - r},${y + thickness} H${x0} Z" fill="${fill}"/>`;
}

function frame(theme: Theme, width: number, height: number, title: string, subtitle: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${FONT}'>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${theme.surface}" stroke="${theme.border}"/>
${text(24, 34, title, `font-size="16" font-weight="600" fill="${theme.ink}"`)}
${text(24, 54, subtitle, `font-size="12" fill="${theme.secondary}"`)}
${body}
</svg>
`;
}

const RENDERERS = [
  { key: "official", label: "hyperframes render", color: (t: Theme) => t.official },
  { key: "official-gpu", label: "hyperframes render --gpu", color: (t: Theme) => t.officialGpu },
  { key: "framevelo", label: "FrameVelo", color: (t: Theme) => t.framevelo },
] as const;

const METRICS = [
  { key: "wallS", label: "Wall time", unit: (v: number) => `${v.toFixed(1)} s` },
  { key: "cpuS", label: "CPU time", unit: (v: number) => `${v.toFixed(v < 100 ? 1 : 0)} s` },
  { key: "peakMb", label: "Peak memory", unit: (v: number) => `${(v / 1024).toFixed(2)} GB` },
] as const;

type Renderer = { key: string; label: string; color: (t: Theme) => string };

/** Three panels (wall, CPU, memory); per panel, groups of bars (one per renderer) with their values. */
function groupedChart(
  theme: Theme,
  chart: {
    title: string;
    subtitle: string;
    renderers: readonly Renderer[];
    groups: Array<{ label: string; rows: Array<Run & { renderer: string }> }>;
    labelWidth: number;
    repeats: number;
  },
): string {
  const width = 960;
  const { renderers, groups } = chart;
  const rows = groups.flatMap((g) => g.rows);
  const thickness = 14;
  const gap = 2;
  const groupGap = 20;
  const top = 124;
  const groupHeight = renderers.length * (thickness + gap) - gap;
  const height = top + groups.length * groupHeight + (groups.length - 1) * groupGap + 40;
  const panelGap = 28;
  const panelWidth = (width - 48 - chart.labelWidth - 2 * panelGap) / 3;
  let body = "";
  // Legend: swatch + label, in renderer order.
  let lx = 24;
  for (const r of renderers) {
    body += `<rect x="${lx}" y="70" width="10" height="10" rx="2" fill="${r.color(theme)}"/>`;
    body += text(lx + 16, 79, r.label, `font-size="12" fill="${theme.secondary}"`);
    lx += 16 + r.label.length * 6.6 + 22;
  }
  groups.forEach((group, g) => {
    const y = top + g * (groupHeight + groupGap);
    body += text(24, y + groupHeight / 2 + 4, group.label, `font-size="13" font-weight="600" fill="${theme.ink}"`);
  });
  METRICS.forEach((metric, p) => {
    const x0 = 24 + chart.labelWidth + p * (panelWidth + panelGap);
    const max = Math.max(...rows.map((r) => r[metric.key]));
    const valueRoom = 62;
    const scale = (panelWidth - valueRoom) / max;
    body += text(x0, top - 12, metric.label, `font-size="12" font-weight="600" fill="${theme.secondary}"`);
    const bottom = top + groups.length * groupHeight + (groups.length - 1) * groupGap;
    body += `<line x1="${x0}" y1="${top - 4}" x2="${x0}" y2="${bottom + 4}" stroke="${theme.axis}" stroke-width="1"/>`;
    groups.forEach((group, g) => {
      renderers.forEach((renderer, i) => {
        const row = group.rows.find((r) => r.renderer === renderer.key);
        if (!row) return;
        const y = top + g * (groupHeight + groupGap) + i * (thickness + gap);
        const length = row[metric.key] * scale;
        body += bar(x0, y, length, thickness, renderer.color(theme));
        body += text(x0 + length + 6, y + thickness - 3, metric.unit(row[metric.key]), `font-size="11" fill="${theme.secondary}" font-variant-numeric="tabular-nums"`);
      });
    });
  });
  body += text(24, height - 16, `Lower is better. Median of ${chart.repeats} runs; whole process tree sampled every 200 ms.`, `font-size="11" fill="${theme.muted}"`);
  return frame(theme, width, height, chart.title, chart.subtitle, body);
}

const machineLine = () => `${results.machine.cpu}, ${results.machine.memoryGb} GB, ${results.machine.os}`;

/** GSAP showcase: 1080p and 4K groups of three bars. */
function gsapChart(theme: Theme, rows: GsapRow[]): string {
  const resolutions = [...new Set(rows.map((r) => r.resolution))];
  return groupedChart(theme, {
    title: "10-second GSAP composition, 30 fps",
    subtitle: `${machineLine()} · HyperFrames ${results.hyperframes}`,
    renderers: RENDERERS,
    groups: resolutions.map((res) => ({ label: res === "4k" ? "4K" : res, rows: rows.filter((r) => r.resolution === res) })),
    labelWidth: 58,
    repeats: repeatsOf("gsap"),
  });
}

const REMOTION_RENDERERS = [
  { key: "remotion", label: "remotion render", color: (t: Theme) => t.official },
  { key: "framevelo", label: "FrameVelo", color: (t: Theme) => t.framevelo },
] as const;

/** Remotion: per case, `remotion render` against FrameVelo. */
function remotionChart(theme: Theme, remotion: NonNullable<Results["remotion"]>): string {
  const cases = [...new Set(remotion.rows.map((r) => r.case))];
  return groupedChart(theme, {
    title: "Remotion projects",
    subtitle: `${machineLine()} · Remotion ${remotion.version}`,
    renderers: REMOTION_RENDERERS,
    groups: cases.map((c) => {
      const rows = remotion.rows.filter((r) => r.case === c);
      return { label: rows[0]!.label, rows };
    }),
    labelWidth: 170,
    repeats: repeatsOf("remotion"),
  });
}

/** Regression fixtures: official ÷ FrameVelo per fixture for wall time, CPU and memory, with a 1× line. */
function fixturesChart(theme: Theme, rows: FixtureRow[]): string {
  const ok = rows.filter((r) => r.official.ok && r.framevelo.ok);
  const ratio = (r: FixtureRow, key: "wallS" | "cpuS" | "peakMb") => r.official[key] / Math.max(r.framevelo[key], 1e-3);
  ok.sort((a, b) => ratio(b, "wallS") - ratio(a, "wallS"));
  const width = 960;
  const rowHeight = 20;
  const thickness = 12;
  const top = 96;
  const height = top + ok.length * rowHeight + 44;
  const nameWidth = 300;
  const panelGap = 24;
  const panelWidth = (width - 48 - nameWidth - 2 * panelGap) / 3;
  let body = "";
  ok.forEach((r, i) => {
    body += text(24 + nameWidth - 12, top + i * rowHeight + thickness - 1, r.name, `font-size="11" fill="${theme.secondary}" text-anchor="end"`);
  });
  const panels = [
    { key: "wallS" as const, label: "Faster" },
    { key: "cpuS" as const, label: "Less CPU" },
    { key: "peakMb" as const, label: "Less memory" },
  ];
  panels.forEach((panel, p) => {
    const x0 = 24 + nameWidth + p * (panelWidth + panelGap);
    const max = Math.max(...ok.map((r) => ratio(r, panel.key)));
    const scale = (panelWidth - 40) / max;
    const bottom = top + ok.length * rowHeight - (rowHeight - thickness);
    body += text(x0, top - 26, panel.label, `font-size="12" font-weight="600" fill="${theme.secondary}"`);
    body += `<line x1="${x0}" y1="${top - 6}" x2="${x0}" y2="${bottom + 4}" stroke="${theme.axis}" stroke-width="1"/>`;
    ok.forEach((r, i) => {
      const value = ratio(r, panel.key);
      const y = top + i * rowHeight;
      body += bar(x0, y, value * scale, thickness, theme.framevelo);
      body += text(x0 + value * scale + 5, y + thickness - 2, `${value.toFixed(1)}×`, `font-size="10" fill="${theme.secondary}" font-variant-numeric="tabular-nums"`);
    });
    // The 1× reference, the official renderer, over the bars so that it stays visible.
    const one = x0 + scale;
    body += `<line x1="${one}" y1="${top - 6}" x2="${one}" y2="${bottom + 4}" stroke="${theme.ink}" stroke-opacity="0.45" stroke-width="1"/>`;
    body += text(one, top - 10, "1× = official", `font-size="10" fill="${theme.muted}" text-anchor="start"`);
  });
  body += text(24, height - 16, "Official ÷ FrameVelo for each fixture: above 1× FrameVelo is faster or lighter. One run each; sorted by wall time.", `font-size="11" fill="${theme.muted}"`);
  const passed = ok.filter((r) => (r.psnrAvg ?? 0) >= 40).length;
  return frame(
    theme,
    width,
    height,
    `Official HyperFrames regression fixtures (${ok.length}), 1080p`,
    `FrameVelo against hyperframes render ${results.hyperframes}; ${passed} of ${ok.length} match it at 40 dB PSNR or more`,
    body,
  );
}

for (const [mode, theme] of Object.entries(THEMES)) {
  if (results.gsap) writeFileSync(path.join(assets, `bench-gsap-${mode}.svg`), gsapChart(theme, results.gsap));
  if (results.fixtures) writeFileSync(path.join(assets, `bench-fixtures-${mode}.svg`), fixturesChart(theme, results.fixtures));
  if (results.remotion) writeFileSync(path.join(assets, `bench-remotion-${mode}.svg`), remotionChart(theme, results.remotion));
}

// ---------- markdown ----------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const f1 = (v: number) => v.toFixed(1);
const picture = (name: string, alt: string) =>
  `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg">\n  <img alt="${alt}" src="assets/${name}-light.svg" width="960">\n</picture>`;

const m = results.machine;
let md = `# Benchmarks

FrameVelo against the official \`hyperframes render\` ${results.hyperframes}${results.remotion ? ` and \`remotion render\` ${results.remotion.version}` : ""} on one machine. Generated by \`node bench/report.ts\` from the results in [\`bench/results\`](../bench/results); rerun with \`node bench/run.ts\` (see [bench/README.md](../bench/README.md)).

| | |
|---|---|
| Machine | ${m.cpu} (${m.model}), ${m.cores} cores, ${m.memoryGb} GB |
| System | ${m.os}, Node ${m.node} |
| Browser | ${m.chrome} |
| FFmpeg | ${m.ffmpeg.replace(/^ffmpeg version /, "")} |

| Suites | Run | FrameVelo | Load average (1 minute, before → after) |
|---|---|---|---|
${[...new Set(sourceOf.values())]
  .map((run) => {
    const suites = SUITES.filter((suite) => sourceOf.get(suite) === run).join(", ");
    const load = run.data.loadAverage ? `${run.data.loadAverage.start} → ${run.data.loadAverage.end}` : "";
    return `| ${suites} | [${run.data.date.slice(0, 10)}](../${path.relative(repo, run.file)}) | ${run.data.framevelo.version} (${run.data.framevelo.commit}) | ${load} |`;
  })
  .join("\n")}

**Method.** Each render runs alone. Wall time, CPU time (user + system) and peak resident memory cover the whole process tree (Node, Chrome and its helpers, FFmpeg), sampled every 200 ms. Quality is per-frame PSNR of the FrameVelo output against the official output. The machine is a working desktop rather than a lab box (see the load average above), so expect a few percent of noise.
`;

if (results.gsap) {
  const rows = results.gsap;
  const name = (key: string) => RENDERERS.find((r) => r.key === key)!.label;
  md += `
## GSAP composition

[\`bench/fixtures/gsap-showcase\`](../bench/fixtures/gsap-showcase): 10 seconds at 30 fps of 80 cards with rounded corners, gradients and blurred shadows, three large radial gradients and per-letter title animation, all driven by one paused GSAP timeline. Rendered at 1080p and at 4K (\`--resolution 4k\` for the official CLI, \`--scale 2\` for FrameVelo). Median of ${repeatsOf("gsap")} interleaved runs.

${picture("bench-gsap", "Wall time, CPU time and peak memory of the 10-second GSAP composition at 1080p and 4K")}

| Resolution | Renderer | Wall | CPU | Peak memory | File | PSNR vs official |
|---|---|---:|---:|---:|---:|---:|
${rows
  .map(
    (r) =>
      `| ${r.resolution === "4k" ? "4K" : r.resolution} | ${r.renderer === "framevelo" ? "**FrameVelo**" : `\`${name(r.renderer)}\``} | ${f1(r.wallS)} s | ${f1(r.cpuS)} s | ${r.peakMb} MB | ${r.mb} MB | ${r.psnrAvg !== undefined ? `${r.psnrAvg} dB` : "reference"} |`,
  )
  .join("\n")}

FrameVelo's files are larger at the same quality: the hardware encoder needs more bits than x264, and FrameVelo's default bitrate targets about x264 CRF 18. \`--gpu\` makes the official CLI encode on VideoToolbox at a lower bitrate, which costs it quality (the PSNR column).
`;
}

if (results.fixtures) {
  const rows = results.fixtures;
  const ok = rows.filter((r) => r.official.ok && r.framevelo.ok);
  const passed = ok.filter((r) => (r.psnrAvg ?? 0) >= 40);
  const below = ok.filter((r) => (r.psnrAvg ?? 0) < 40);
  const tw = sum(ok.map((r) => r.official.wallS));
  const fw = sum(ok.map((r) => r.framevelo.wallS));
  const tc = sum(ok.map((r) => r.official.cpuS));
  const fc = sum(ok.map((r) => r.framevelo.cpuS));
  const tm = sum(ok.map((r) => r.official.peakMb)) / ok.length;
  const fm = sum(ok.map((r) => r.framevelo.peakMb)) / ok.length;
  const slower = ok.filter((r) => r.framevelo.wallS > r.official.wallS);
  md += `
## Official regression fixtures

The ${rows.length} projects of [\`packages/producer/tests\`](https://github.com/heygen-com/hyperframes/tree/v${results.hyperframes}/packages/producer/tests) in the HyperFrames repository that render on macOS without extra services, at 1080p, one run each. ${ok.length} of ${rows.length} render with both tools, and ${passed.length} of them match the official output at 40 dB PSNR or more${below.length ? ` (${below.map((r) => `\`${r.name}\` ${r.psnrAvg} dB`).join(", ")})` : ""}.

**Totals:** wall time ${f1(tw)} s → ${f1(fw)} s (${(tw / fw).toFixed(2)}× faster), CPU ${f1(tc)} s → ${f1(fc)} s (${(tc / fc).toFixed(2)}× less), mean peak memory ${Math.round(tm)} MB → ${Math.round(fm)} MB (${Math.round((1 - fm / tm) * 100)}% less).${slower.length ? ` FrameVelo is slower on ${slower.map((r) => `\`${r.name}\``).join(", ")}.` : ""}

${picture("bench-fixtures", "Speed, CPU and memory of FrameVelo relative to the official renderer for each regression fixture")}

| Fixture | Frames | PSNR avg / min | Wall official → FrameVelo | CPU official → FrameVelo | Peak memory official → FrameVelo |
|---|---:|---:|---:|---:|---:|
${rows
  .map((r) =>
    r.official.ok && r.framevelo.ok
      ? `| ${r.name} | ${r.frames} | ${r.psnrAvg} / ${r.psnrMin} dB | ${f1(r.official.wallS)} → ${f1(r.framevelo.wallS)} s | ${f1(r.official.cpuS)} → ${f1(r.framevelo.cpuS)} s | ${r.official.peakMb} → ${r.framevelo.peakMb} MB |`
      : `| ${r.name} | | ${r.official.ok ? "FrameVelo failed" : "official failed"} | | | |`,
  )
  .join("\n")}

Motion graphics gain the most. Video-heavy fixtures gain less: their frames come from the official extraction and injector, which costs about one rendering update per new video frame.
`;
}

if (results.workers) {
  const w = results.workers;
  md += `
## Parallel pages

\`${w.fixture}\` (1516 frames, most of them with an injected video frame) rendered with \`--workers 1\` to \`4\`. Frames driven from Node are latency-bound, so extra pages overlap their round trips.

| \`--workers\` | Pages | Render stage | Wall | CPU | Peak memory | PSNR vs official |
|---:|---:|---:|---:|---:|---:|---:|
${w.rows.map((r) => `| ${r.workers} | ${r.pages} | ${f1(r.renderS)} s | ${f1(r.wallS)} s | ${f1(r.cpuS)} s | ${r.peakMb} MB | ${r.psnrAvg !== undefined ? `${r.psnrAvg} / ${r.psnrMin} dB` : ""} |`).join("\n")}
`;
}

if (results.browser) {
  md += `
## Browser

FrameVelo on the GSAP composition at 1080p with each browser. Median of ${repeatsOf("browser")} runs.

| Browser | Wall | CPU | Peak memory |
|---|---:|---:|---:|
${results.browser.map((r) => `| ${r.browser} | ${f1(r.wallS)} s | ${f1(r.cpuS)} s | ${r.peakMb} MB |`).join("\n")}

\`chrome-headless-shell\` skips the browser UI and its helper processes; \`framevelo browser install\` installs it and FrameVelo prefers it.
`;
}

if (results.remotion) {
  const r = results.remotion;
  const cases = [...new Set(r.rows.map((row) => row.case))];
  const pair = (c: string) => ({ remotion: r.rows.find((row) => row.case === c && row.renderer === "remotion")!, framevelo: r.rows.find((row) => row.case === c && row.renderer === "framevelo")! });
  md += `
## Remotion

\`remotion render\` ${r.version} against FrameVelo on the same projects: Remotion's own hello-world template (\`npx create-video --hello-world\`, the \`HelloWorld\` composition, 5 s) at 1080p and at 4K (\`--scale 2\` for both), and [\`test/fixtures/remotion\`](../test/fixtures/remotion) at 720p, 3 s with an \`<OffthreadVideo>\` and an \`<Audio>\` with a volume curve. Both bundle the project with Remotion's CLI and mix the audio with Remotion's mixer; FrameVelo captures with \`drawElementImage\` and encodes on the hardware encoder where \`remotion render\` takes JPEG screenshots in several tabs and encodes with x264. Median of ${repeatsOf("remotion")} interleaved runs.

${picture("bench-remotion", "Wall time, CPU time and peak memory of remotion render and FrameVelo on Remotion projects")}

| Project | Renderer | Wall | CPU | Peak memory | File | PSNR vs remotion render |
|---|---|---:|---:|---:|---:|---:|
${r.rows
  .map(
    (row) =>
      `| ${row.label} | ${row.renderer === "framevelo" ? "**FrameVelo**" : "\`remotion render\`"} | ${f1(row.wallS)} s | ${f1(row.cpuS)} s | ${row.peakMb} MB | ${row.mb} MB | ${row.psnrAvg !== undefined ? `${row.psnrAvg} / ${row.psnrMin} dB` : "reference"} |`,
  )
  .join("\n")}

${cases
  .map((c) => {
    const { remotion, framevelo } = pair(c);
    return `- ${remotion.label}: ${(remotion.wallS / framevelo.wallS).toFixed(1)}× faster, ${(remotion.cpuS / framevelo.cpuS).toFixed(1)}× less CPU, ${Math.round((1 - framevelo.peakMb / remotion.peakMb) * 100)}% less peak memory.`;
  })
  .join("\n")}
`;
}

writeFileSync(path.join(repo, "docs", "benchmarks.md"), md);
process.stdout.write(`docs/benchmarks.md and charts from ${[...new Set(sourceOf.values())].map((run) => path.relative(repo, run.file)).join(", ")}\n`);
