/**
 * `fritzkit doctor`: checks the machine has what fritzkit needs (Node, Fritzing, its
 * folders, uv + the vendored checker, sharp) and says what is missing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fritzingPaths, fritzingVersion, isFritzingRunning } from "../fritzing.js";
import { findCheckerDir, UV_INSTALL_HINT } from "./checker.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Missing optional checks are warnings, not failures. */
  optional?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when every non-optional check passed. */
  ok: boolean;
}

export const AUTOHOTKEY_V2 = "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe";

interface RunOut {
  ok: boolean;
  stdout: string;
  stderr: string;
  enoent: boolean;
}

function run(cmd: string, args: string[], timeout = 120_000): Promise<RunOut> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const e = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
          resolve({ ok: !error, stdout, stderr, enoent: e?.code === "ENOENT" });
        },
      );
    } catch (e) {
      // Invalid arguments (e.g. an empty uvPath) throw synchronously; doctor never throws.
      resolve({ ok: false, stdout: "", stderr: String(e), enoent: true });
    }
  });
}

export function nodeVersionCheck(version: string = process.versions.node): DoctorCheck {
  const major = Number(version.split(".")[0]);
  return {
    name: "node >= 22",
    ok: major >= 22,
    detail: major >= 22 ? `v${version}` : `v${version}: upgrade Node to 22 or newer`,
  };
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** uv executable (default "uv"). */
  uvPath?: string;
  /** Skip the slow lxml probe (it may trigger a first-time `uv sync`). */
  skipLxml?: boolean;
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const uv = opts.uvPath ?? "uv";
  const checks: DoctorCheck[] = [nodeVersionCheck()];
  const paths = fritzingPaths(env);

  // FRITZKIT_FRITZING_EXE is taken as is by fritzingPaths, so check it exists here.
  if (paths.exe && existsSync(paths.exe)) {
    const ver = await fritzingVersion(paths.exe);
    checks.push({
      name: "Fritzing executable",
      ok: true,
      detail: `${paths.exe}${ver ? ` (version ${ver})` : ""}`,
    });
  } else {
    checks.push({
      name: "Fritzing executable",
      ok: false,
      detail: paths.exe
        ? `${paths.exe} does not exist; fix FRITZKIT_FRITZING_EXE or unset it`
        : "Fritzing.exe not found; install Fritzing 1.0.x or set FRITZKIT_FRITZING_EXE to its path",
    });
  }

  const running = await isFritzingRunning();
  checks.push({
    name: "Fritzing not running",
    ok: !running,
    detail: running
      ? "Fritzing is running: install/prune will refuse until you close it"
      : "not running",
  });

  checks.push(
    paths.partsLibrary
      ? {
          name: "parts library + fzp_checker.py",
          ok: true,
          detail: paths.partsLibrary,
        }
      : {
          name: "parts library + fzp_checker.py",
          ok: false,
          detail: "fritzing-parts/fzp_checker.py not found next to Fritzing.exe",
        },
  );

  checks.push({
    name: "user parts dir",
    ok: existsSync(paths.userPartsDir),
    detail: existsSync(paths.userPartsDir)
      ? paths.userPartsDir
      : `${paths.userPartsDir} missing: start Fritzing once to create it`,
  });

  checks.push({
    name: "My Parts bin",
    ok: existsSync(paths.myPartsBin),
    detail: existsSync(paths.myPartsBin)
      ? paths.myPartsBin
      : `${paths.myPartsBin} missing: start Fritzing once (or create a part) to create it`,
  });

  const uvOut = await run(uv, ["--version"], 30_000);
  const uvOk = uvOut.ok;
  checks.push({
    name: "uv on PATH",
    ok: uvOk,
    detail: uvOk ? uvOut.stdout.trim() : UV_INSTALL_HINT,
  });

  const checkerDir = findCheckerDir(undefined, env);
  checks.push({
    name: "vendored fzp checker",
    ok: checkerDir !== undefined,
    detail: checkerDir ?? "tools/fzp-checker not found (set FRITZKIT_CHECKER_DIR)",
  });

  if (opts.skipLxml) {
    checks.push({ name: "lxml importable", ok: true, detail: "skipped", optional: true });
  } else if (!uvOk || !checkerDir) {
    checks.push({
      name: "lxml importable",
      ok: false,
      detail: "needs uv and the vendored checker",
    });
  } else {
    // A cold machine runs `uv sync` here; cap it so doctor stays bounded.
    const lx = await run(
      uv,
      ["run", "--project", checkerDir, "python", "-c", "import lxml; print(lxml.__version__)"],
      60_000,
    );
    checks.push({
      name: "lxml importable",
      ok: lx.ok,
      detail: lx.ok
        ? `lxml ${lx.stdout.trim()}`
        : `failed: ${lx.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "unknown error"} (try: uv sync --project ${checkerDir})`,
    });
  }

  const ahk = existsSync(AUTOHOTKEY_V2);
  checks.push({
    name: "AutoHotkey v2 (e2e harness)",
    ok: ahk,
    optional: true,
    detail: ahk ? AUTOHOTKEY_V2 : `not found at ${AUTOHOTKEY_V2}; only needed for npm run e2e`,
  });

  try {
    const mod = (await import("sharp")) as { default?: { versions?: Record<string, string> } };
    const v = mod.default?.versions?.sharp;
    checks.push({ name: "sharp loads", ok: true, detail: v ? `sharp ${v}` : "loaded" });
  } catch (e) {
    checks.push({
      name: "sharp loads",
      ok: false,
      detail: `${e instanceof Error ? e.message : String(e)} (photo artwork needs it; try npm rebuild sharp)`,
    });
  }

  return { checks, ok: checks.every((c) => c.ok || c.optional === true) };
}

/** Status word for one check: "ok", "warn" (optional and missing) or "MISSING". */
export function doctorStatus(c: DoctorCheck): "ok" | "warn" | "MISSING" {
  if (c.ok) return "ok";
  return c.optional ? "warn" : "MISSING";
}

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map(
    (c) => `${doctorStatus(c).padEnd(7)} ${c.name.padEnd(width)}  ${c.detail}`,
  );
  lines.push("");
  lines.push(report.ok ? "All required checks passed." : "Some required checks failed.");
  return lines.join("\n");
}
