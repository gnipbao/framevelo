# Notes for coding agents

## Rendering videos with FrameVelo

To render something rather than change this repository, follow [plugin/skills/framevelo/SKILL.md](plugin/skills/framevelo/SKILL.md): it covers the MCP tools (`framevelo mcp`), the CLI with `--json`, the page contract and what to do with each error.

## Working on this repository

- Node 22.18+ runs the TypeScript sources directly through type stripping: `node src/cli.ts render ...`. Use only erasable syntax (no enums, namespaces or parameter properties) and import with `.ts` extensions.
- `npm run typecheck`, `npm test` (unit and MCP protocol tests, no Chrome), `npm run test:integration` (renders through Chrome and FFmpeg, about a minute), `npm run build` (emits `dist/`, which the published bin runs).
- Map of the code and the measured design decisions: [docs/architecture.md](docs/architecture.md). Start there before changing capture or encoding.
- `src/page-runtime.ts` runs inside the page: its functions are serialized by `page.evaluate`, so they cannot use module-level variables or Node APIs.
- Runtime dependencies are `puppeteer-core` and `@puppeteer/browsers` only; HyperFrames packages are optional peers loaded on demand. Keep it that way.
- Performance claims are measured, not assumed. `node scripts/parity.ts <projects>` renders with `hyperframes render` and FrameVelo and reports PSNR, wall time, CPU and peak memory. Measure on an idle machine, one render at a time; screen recorders and other renders skew the numbers. The bar: exact frame counts, and at least 40 dB average PSNR against the official render.
- Work on a branch and open one pull request when the work is done. Commit messages say why.
