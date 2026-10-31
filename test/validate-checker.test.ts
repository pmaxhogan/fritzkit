import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import {
  findCheckerDir,
  parseCheckerOutput,
  runFzpChecker,
  UV_INSTALL_HINT,
} from "../src/core/validate/checker.js";

const REPO = resolve(import.meta.dirname, "..");

function hasUv(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const UV = hasUv();

// Captured from `uv run --project tools/fzp-checker check-fzp <file>` (Fritzing 1.0.7b
// checker). Non-ASCII marks are written as escapes to keep this file ASCII.
const X = "\u2717";
const WARN = "\u26A0";
const OK = "\u2713";
const TREE = "\u2514\u2500\u2500";

const CLEAN_STDOUT = [
  "",
  "Summary:",
  "  Files checked: 1",
  "  Checks run: 62",
  "  Errors found: 0",
  "  Errors fixed: 0",
  "",
  "File Details:",
  `  C:/tmp/spike-vector.fzpz: ${OK} CLEAN`,
  `    ${TREE} C:\\Temp\\tmp36\\svg.breadboard.x_breadboard.svg: ${OK} CLEAN`,
  `    ${TREE} C:\\Temp\\tmp36\\svg.pcb.x_pcb.svg: ${OK} CLEAN`,
  "",
].join("\r\n");

const DIRTY_STDOUT = [
  "",
  "Summary:",
  "  Files checked: 1",
  "  Checks run: 62",
  "  Errors found: 4",
  "  Warnings found: 1",
  "  Errors fixed: 0",
  "",
  "File Details:",
  `  neokey.fzpz: ${X} 2 errors, 1 warning`,
  `    ${X} Missing required tag: label`,
  `    ${WARN} Date format 'Thu Jun 24 2021' should be in YYYY-MM-DD format.`,
  `    ${X} Layer ID 'icon' from iconView not found in SVG`,
  `    ${TREE} C:\\Temp\\tmpiy\\svg.schematic.neo_schematic.svg: ${X} 2 errors`,
  `        ${X} Invalid font family 'DroidSans' in element: [NeoKey]`,
  `        ${X} Found gorn attribute with value '0' on element 'svg'`,
  `    ${TREE} C:\\Temp\\tmpiy\\svg.icon.neo_icon.svg: ${OK} CLEAN`,
  "Total errors: 4",
  "",
].join("\r\n");

const STDERR = [
  "Checking 1 FZP files",
  "Scanning file: C:\\Temp\\tmpiy\\part.neo.fzp",
  "Checking SVG file: C:\\Temp\\tmpiy\\svg.icon.neo_icon.svg",
  "Total errors in C:\\Temp\\tmpiy\\part.neo.fzp: 4",
].join("\n");

describe("parseCheckerOutput", () => {
  it("parses a clean report as no issues", () => {
    expect(parseCheckerOutput(CLEAN_STDOUT, STDERR)).toEqual({ errors: [], warnings: [] });
  });

  it("parses fzp and svg issues, prefixing svg issues with the file name", () => {
    expect(parseCheckerOutput(DIRTY_STDOUT, STDERR)).toEqual({
      errors: [
        "Missing required tag: label",
        "Layer ID 'icon' from iconView not found in SVG",
        "svg.schematic.neo_schematic.svg: Invalid font family 'DroidSans' in element: [NeoKey]",
        "svg.schematic.neo_schematic.svg: Found gorn attribute with value '0' on element 'svg'",
      ],
      warnings: ["Date format 'Thu Jun 24 2021' should be in YYYY-MM-DD format."],
    });
  });

  it("picks up Error: lines and Invalid XML on stderr", () => {
    const r = parseCheckerOutput(
      "Error: Path 'x.fzpz' does not exist or is not accessible\n",
      "Invalid XML: Start tag expected\n",
    );
    expect(r.errors).toEqual([
      "Path 'x.fzpz' does not exist or is not accessible",
      "Invalid XML: Start tag expected",
    ]);
    expect(parseCheckerOutput("")).toEqual({ errors: [], warnings: [] });
  });
});

describe("findCheckerDir", () => {
  const dir = join(REPO, "tools", "fzp-checker");

  it("walks up to the repo's tools/fzp-checker", () => {
    expect(findCheckerDir(undefined, {})).toBe(dir);
    expect(findCheckerDir(join(REPO, "test", "fixtures"), {})).toBe(dir);
  });

  it("honours FRITZKIT_CHECKER_DIR and returns undefined when nothing is found", () => {
    expect(findCheckerDir(tmpdir(), { FRITZKIT_CHECKER_DIR: dir })).toBe(dir);
    const root = resolve("/");
    expect(findCheckerDir(root, { FRITZKIT_CHECKER_DIR: join(root, "nope") })).toBeUndefined();
  });
});

describe("runFzpChecker", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fritzkit-checker-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function zipFixture(name: string): string {
    const src = join(REPO, "test", "fixtures", "validate", name);
    const files: Record<string, Uint8Array> = {};
    for (const f of readdirSync(src).sort()) {
      files[f] = new Uint8Array(readFileSync(join(src, f)));
    }
    const p = join(tmp, `${name}.fzpz`);
    writeFileSync(p, zipSync(files));
    return p;
  }

  it("reports uv missing without throwing", async () => {
    const r = await runFzpChecker("x.fzpz", { uvPath: join(tmp, "no-such-uv") });
    expect(r.available).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.errors).toEqual([UV_INSTALL_HINT]);
    expect(UV_INSTALL_HINT).toContain("https://docs.astral.sh/uv/");
    // An argument execFile rejects synchronously must not escape as a rejection.
    const empty = await runFzpChecker("x.fzpz", { uvPath: "" });
    expect(empty.available).toBe(false);
  });

  it("reports a missing checker dir", async () => {
    const saved = process.env.FRITZKIT_CHECKER_DIR;
    delete process.env.FRITZKIT_CHECKER_DIR;
    try {
      const r = await runFzpChecker("x.fzpz", { repoRoot: resolve("/") });
      expect(r.available).toBe(false);
      expect(r.errors[0]).toContain("tools/fzp-checker not found");
    } finally {
      if (saved !== undefined) process.env.FRITZKIT_CHECKER_DIR = saved;
    }
  });

  it.skipIf(!UV)(
    "spike-vector fixture is checker-clean (exit 0)",
    async () => {
      const r = await runFzpChecker(zipFixture("spike-vector"));
      expect(r.available).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.exitCode).toBe(0);
    },
    180_000,
  );

  it.skipIf(!UV)(
    "a broken part exits 65 with parsed errors",
    async () => {
      const p = join(REPO, "tools", "fzp-checker", "tests", "fixtures", "adafruit-neokey-1x4.fzpz");
      const r = await runFzpChecker(p);
      expect(r.exitCode).toBe(65);
      expect(r.errors).toContain("Missing required tag: label");
      expect(r.errors.length).toBeGreaterThan(10);
    },
    180_000,
  );

  it.skipIf(!UV)(
    "a missing input file is not clean",
    async () => {
      const r = await runFzpChecker(join(tmp, "missing.fzpz"));
      expect(r.available).toBe(true);
      expect(r.exitCode).not.toBe(0);
      expect(r.errors.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
