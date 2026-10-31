# Upstream provenance

- Source: fritzing-parts (https://github.com/fritzing/fritzing-parts)
- Taken from: `C:\Program Files\Fritzing\fritzing-parts\` as installed with
  Fritzing 1.0.7b; believed to be branch 1.0.7 (not verified, no .git there).
- Date vendored: 2026-10-31
- Files: `fzp_checker.py`, `scripts/checks/` (whole directory, including
  `test_data/`, `explain_errors.md`, `inspector_fc51.png`), and `LICENSE.txt`.
- Modifications: none to content, except CRLF converted to LF in text files.
  The checker needs no other repo files (it imports only from
  `scripts.checks`, plus lxml and the standard library).

## License

`LICENSE.txt` (copied from the fritzing-parts root) states: all graphics and
documentation are licensed under Creative Commons Attribution-ShareAlike 3.0
Unported (CC-BY-SA 3.0). It says nothing about the scripts. The scripts carry
no license header of their own; the upstream repository is believed to cover
code under GPL, but that is not recorded in the installed files. Verify
upstream before redistributing this directory.

## ASCII exception

Vendored files may contain non-ASCII bytes (kept as upstream). Run the repo
ASCII check with `tools/fzp-checker/vendor/` excluded.
