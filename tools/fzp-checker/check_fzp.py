"""Wrapper around the vendored Fritzing fzp_checker.

Usage: uv run --project tools/fzp-checker check-fzp <file.fzpz> [extra args]

The vendored checker uses os.EX_* exit codes, which do not exist on Windows,
so they are shimmed here before the checker is imported. Output and extra
arguments (including --fix) pass through unchanged. Exit code is non-zero on
errors.
"""

import os
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parent / "vendor"

_EX_CODES = {
    "EX_OK": 0,
    "EX_USAGE": 64,
    "EX_DATAERR": 65,
    "EX_NOINPUT": 66,
}


def _shim_exit_codes() -> None:
    for name, value in _EX_CODES.items():
        if not hasattr(os, name):
            setattr(os, name, value)


def _force_utf8_output() -> None:
    # The checker prints non-ASCII marks; the default Windows codepage crashes.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    _shim_exit_codes()
    _force_utf8_output()
    sys.path.insert(0, str(VENDOR))
    from scripts.checks.fzp_checker_runner import main as checker_main

    sys.argv[0] = "check-fzp"
    checker_main()


if __name__ == "__main__":
    main()
