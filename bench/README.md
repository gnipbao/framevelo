# Benchmarks

Measure FrameVelo against the official `hyperframes render` on your machine. Results and charts are in [docs/benchmarks.md](../docs/benchmarks.md).

```bash
npm install
npm run bench
npm run bench:report
```

`run.ts` writes `bench/results/<date>.json`; `report.ts` turns the newest results file into `docs/benchmarks.md` and the charts in `docs/assets/`.

| Suite | What it measures |
|---|---|
| `gsap` | [`fixtures/gsap-showcase`](fixtures/gsap-showcase), 10 s, at 1080p and 4K: `hyperframes render`, `hyperframes render --gpu` and FrameVelo; median of `--repeats` interleaved runs (default 3) |
| `fixtures` | The official HyperFrames regression fixtures, once each, with per-frame PSNR against the official output |
| `workers` | A 1516-frame video fixture with `--workers 1` to `4` |
| `browser` | FrameVelo on `chrome-headless-shell` against full Google Chrome |
| `remotion` | `remotion render`, as it runs by default and with `--color-space=bt709` (the PSNR reference: the same colour conversion as FrameVelo), against FrameVelo: Remotion's hello-world template (scaffolded once into `~/.cache/framevelo/bench`) at 1080p and 4K, and [`test/fixtures/remotion`](../test/fixtures/remotion), a 3 s video-and-audio scene and a 20 s motion-graphics showcase |

```bash
node bench/run.ts --suite gsap --repeats 5 --out bench/results/gsap-only.json
```

- Every render runs alone, and wall time, CPU time and peak memory cover the whole process tree, sampled every 200 ms. Close screen recorders, video calls and other renders first: they share the GPU and the single hardware encoder. `run.ts` warns when the load average is high.
- The regression fixtures come from the HyperFrames repository at the tag of the pinned producer version, cloned once into `~/.cache/framevelo/bench`. Pass `--fixtures <checkout>/packages/producer/tests` to use your own checkout.
- The official CLI runs through `npx hyperframes@<version>` and is fetched before the first measurement.
- The scripts run on macOS and Linux: they sample the process tree with `ps`.
- [`parity.ts`](parity.ts) compares the two renderers on any HyperFrames projects of your own: `node bench/parity.ts <project>... [--resolution 4k]`.
