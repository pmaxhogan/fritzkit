/**
 * Runs Fritzing's official part checker (vendored under tools/fzp-checker) through uv and
 * parses its report. Dev/CI tool: when uv is not installed the result says so instead of
 * throwing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CheckerOptions {
  /** Directory to start the tools/fzp-checker search from (default: this module). */
  repoRoot?: string;
  /** uv executable (default "uv" on PATH). */
  uvPath?: string;
  /** Extra arguments passed after the file, e.g. ["-v"]. */
  extraArgs?: string[];
  /** Milliseconds before the run is killed (default 120000). */
  timeoutMs?: number;
}

export interface CheckerResult {
  /** False when uv (or the checker project) could not be found. */
  available: boolean;
  /** Process exit code: 0 clean, 65 errors found, 64 usage, 66 no input; null if killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** One entry per error line the checker printed (SVG issues are prefixed "<svg file>: "). */
  errors: string[];
  warnings: string[];
}

export const UV_INSTALL_HINT =
  "uv is not installed or not on PATH. Install it from https://docs.astral.sh/uv/ " +
  '(Windows: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"), then re-run.';

const CHECKER_REL = join("tools", "fzp-checker");

/**
 * Locate tools/fzp-checker: FRITZKIT_CHECKER_DIR wins, else walk up from `start` (default:
 * this module's directory) until a directory holding tools/fzp-checker/pyproject.toml.
 */
export function findCheckerDir(
  start?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.FRITZKIT_CHECKER_DIR;
  if (fromEnv && existsSync(join(fromEnv, "pyproject.toml"))) return resolve(fromEnv);
  let dir = resolve(start ?? dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    const candidate = join(dir, CHECKER_REL);
    if (existsSync(join(candidate, "pyproject.toml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The checker prints these marks (UTF-8, forced by tools/fzp-checker/check_fzp.py).
// Written as escapes to keep this file ASCII.
const MARK_ERROR = "\u2717 "; // ballot x
const MARK_WARNING = "\u26A0 "; // warning sign
const SVG_HEADER_RE = /^\s*\u2514\u2500\u2500 (.+?): /; // box corner + 2 horizontals

/**
 * Parse the checker's report into error and warning messages.
 *
 * stdout layout (lines may end in CRLF on Windows; X = U+2717, ! = U+26A0,
 * L-- = U+2514 U+2500 U+2500, OK = U+2713):
 *   "  <fzp path>: <status>"        status "OK CLEAN" or "X N errors, M warnings"
 *   "    X <msg>" / "    ! <msg>"    fzp issue (4-space indent)
 *   "    L-- <svg path>: <status>"  start of one svg's block
 *   "        X <msg>"               svg issue (8-space indent)
 *   "Error: <msg>"                      usage / input errors
 * stderr carries INFO logging ("Checking 1 FZP files", "Scanning file: ...") and, for
 * unreadable files, "Invalid XML: ..." lines.
 */
export function parseCheckerOutput(
  stdout: string,
  stderr = "",
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let svgFile: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const header = SVG_HEADER_RE.exec(raw);
    if (header) {
      svgFile = basename(header[1] ?? "");
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    // Anything indented less than an svg issue ends the current svg block.
    if (line !== "" && indent < 8) svgFile = undefined;
    const prefix = svgFile ? `${svgFile}: ` : "";
    if (line.startsWith(MARK_ERROR)) errors.push(prefix + line.slice(MARK_ERROR.length).trim());
    else if (line.startsWith(MARK_WARNING)) {
      warnings.push(prefix + line.slice(MARK_WARNING.length).trim());
    } else if (/^Error: /.test(line)) errors.push(line.slice("Error: ".length));
  }
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(Invalid XML|Error)\b/.test(line)) errors.push(line);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

interface ExecOutcome {
  code: number | string | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function run(cmd: string, args: string[], timeout: number): Promise<ExecOutcome> {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        cmd,
        args,
        { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({ code: 0, stdout, stderr, killed: false });
            return;
          }
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          const code = typeof e.code === "number" || typeof e.code === "string" ? e.code : null;
          resolvePromise({ code, stdout, stderr, killed: e.killed === true });
        },
      );
    } catch {
      // execFile throws synchronously on invalid arguments (e.g. an empty uvPath): treat
      // the executable as missing so callers keep the "never throws" contract.
      resolvePromise({ code: "ENOENT", stdout: "", stderr: "", killed: false });
    }
  });
}

/** Run `uv run --project <checker> check-fzp <fzpzPath> [...extraArgs]`. Never throws. */
export async function runFzpChecker(
  fzpzPath: string,
  opts: CheckerOptions = {},
): Promise<CheckerResult> {
  const dir = findCheckerDir(opts.repoRoot);
  if (!dir) {
    const msg =
      "tools/fzp-checker not found; run from a fritzkit checkout or set FRITZKIT_CHECKER_DIR";
    return {
      available: false,
      exitCode: null,
      stdout: "",
      stderr: msg,
      errors: [msg],
      warnings: [],
    };
  }
  const uv = opts.uvPath ?? "uv";
  const args = ["run", "--project", dir, "check-fzp", resolve(fzpzPath), ...(opts.extraArgs ?? [])];
  const out = await run(uv, args, opts.timeoutMs ?? 120_000);
  if (out.code === "ENOENT") {
    return {
      available: false,
      exitCode: null,
      stdout: "",
      stderr: UV_INSTALL_HINT,
      errors: [UV_INSTALL_HINT],
      warnings: [],
    };
  }
  const exitCode = typeof out.code === "number" ? out.code : null;
  const { errors, warnings } = parseCheckerOutput(out.stdout, out.stderr);
  if (out.killed) errors.push("fzp checker timed out");
  else if (exitCode !== 0 && errors.length === 0) {
    const tail = out.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
    errors.push(`fzp checker exited ${exitCode ?? String(out.code)}${tail ? `: ${tail}` : ""}`);
  }
  return { available: true, exitCode, stdout: out.stdout, stderr: out.stderr, errors, warnings };
}
