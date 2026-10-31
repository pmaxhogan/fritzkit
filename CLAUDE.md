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

- (describe the top-level directories and where the entry points live)

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: deps.dependabot-mechanism=native
- mode: release.target=npm+github-release
- mode: repo.protection=deferred-until-hw391-acceptance
- mode: stack.type=node-ts
- mode: test.coverage-ratchet=ruleset
- mode: tooling.python=dev-only

<!-- stack:end -->
