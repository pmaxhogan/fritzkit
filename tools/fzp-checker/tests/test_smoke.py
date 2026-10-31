"""Smoke tests for the check-fzp wrapper.

The NeoKey fixture is an old Adafruit part that the checker does NOT pass
cleanly (exit 65, EX_DATAERR). The test pins the exact, stable findings so a
checker change is noticed. The fixture is untrusted data: it is only read.
"""

import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WRAPPER = ROOT / "check_fzp.py"
FIXTURE = ROOT / "tests" / "fixtures" / "adafruit-neokey-1x4.fzpz"
EX_DATAERR = 65


def run_checker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(WRAPPER), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
    )


def test_neokey_fixture_reports_known_findings():
    result = run_checker(str(FIXTURE))
    out = result.stdout + result.stderr
    assert result.returncode == EX_DATAERR, out
    assert "Missing required tag: label" in out
    assert "Date format 'Thu Jun 24 2021'" in out
    assert "fritzingVersion '0.5.2b.02.18.4756' is below 0.8" in out
    assert "Files checked: 1" in out
    assert "Traceback" not in out


def test_broken_fzpz_without_module_id_fails(tmp_path):
    broken = tmp_path / "broken.fzpz"
    with zipfile.ZipFile(broken, "w") as zf:
        zf.writestr(
            "part.broken.fzp",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<module fritzingVersion="1.0.0"><title>Broken</title></module>\n',
        )
    result = run_checker(str(broken))
    out = result.stdout + result.stderr
    # Upstream crashes with a traceback on this input (exit 1); any non-zero
    # exit is the contract the TS validator relies on.
    assert result.returncode != 0, out


def test_help_exits_zero_and_lists_checks():
    result = run_checker("--help")
    assert result.returncode == 0
    assert "--fix" in result.stdout
    assert "module_id" in result.stdout
