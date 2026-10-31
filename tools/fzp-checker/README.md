# fzp-checker

Dev-only tool that vendors Fritzing's official part checker
(`fzp_checker.py` and `scripts/checks/` from fritzing-parts) so fritzkit can
validate generated `.fzpz` files. See `vendor/UPSTREAM.md` for provenance and
license. It is not part of the published package.

## Run (from the repo root)

    uv run --project tools/fzp-checker check-fzp <path-to.fzpz> [extra args]

Output (stdout/stderr) is the checker's, unchanged. Exit codes follow
sysexits: 0 = clean, 65 = errors found, 64 = usage error, 66 = no input;
an unexpected checker crash exits 1. Any non-zero exit means "not clean".
Warnings alone do not change the exit code.

`check-fzp --help` lists all checks; `-c <name> ...` selects checks and `-v`
is verbose. Note `-c` consumes following words, so put the path first.

## How the TS validator calls it

    uv run --project tools/fzp-checker check-fzp <file>

Spawn it, capture stdout/stderr, and treat a non-zero exit as failure.

## Windows notes

The wrapper (`check_fzp.py`) shims `os.EX_*` (missing on Windows) and forces
UTF-8 output; the vendored files are left untouched.

## WARNING: --fix rewrites files

`--fix` passes through to the checker and modifies the checked files in
place. Always run it on a copy.

## Development

    cd tools/fzp-checker
    uv sync
    uv run black --check .   # vendor/ is excluded
    uv run pytest

`tests/fixtures/adafruit-neokey-1x4.fzpz` is a copy of an untrusted
third-party part; it is only read, never executed. It is an old part that
the checker reports errors on (exit 65), and the smoke test pins that.
