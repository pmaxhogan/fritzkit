<!-- stack-template: claude-md/project-stub@2 8e4f4a3bdd59 -->

# fritzkit

## Commands

- `npm test` - vitest with coverage
- `npm run build` - tsc to dist/
- `npm run lint` / `npm run format:check` - eslint and prettier
- `npm run check-ascii` - ASCII-only guard
- `npm run e2e` - local Fritzing GUI + render acceptance harness (not CI)
- `uv run --project tools/fzp-checker check-fzp <file.fzpz>` - Fritzing's fzp checker

## Layout

- `src/core/` - pure compiler: `schema/` (zod spec + generated JSON Schema), `resolve.ts` (connectors, frame), `compile/` (fzp + 4 SVG renderers), `validate/`, `export/` (fzpz, install, prune), `image/` (sharp keying), `kicad/`
- `src/cli/` (commander), `src/mcp/` (stdio server), `src/server/` + `src/ui/` (`fritzkit ui`)
- `skills/fritzkit/` + `.claude-plugin/` - the Claude Code skill and plugin; `examples/` - golden parts
- `scripts/e2e/` - local acceptance harness (Fritzing `-svg` render check + AutoHotkey GUI demo); `tools/fzp-checker/` - vendored Fritzing checker (uv)
- `docs/architecture.md` explains the pipeline, coordinate frames and the verified Fritzing facts

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: deps.dependabot-mechanism=native
- mode: release.target=npm+github-release
- mode: repo.protection=rulesets-applied-2026-10-31
- mode: stack.type=node-ts
- mode: test.coverage-ratchet=compare-job
- mode: tooling.python=dev-only

<!-- stack:end -->
