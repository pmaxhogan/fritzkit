/**
 * Validator entry points: structural checks on a compiled part or a .fzpz on disk, schema
 * checks on a part.json, the vendored Fritzing checker and the doctor.
 */
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import type { View } from "../compile/types.js";
import { VIEWS } from "../compile/types.js";
import { safeParsePartSpec } from "../schema/part.js";
import { validateStructure, type Issue, type ValidateInput } from "./structural.js";

export type { Issue, IssueLevel, ValidateInput, SvgNode } from "./structural.js";
export { validateStructure, parseFzp, parseSvg, entryNameForImage } from "./structural.js";
export {
  runFzpChecker,
  parseCheckerOutput,
  findCheckerDir,
  UV_INSTALL_HINT,
  type CheckerOptions,
  type CheckerResult,
} from "./checker.js";
export { explain, explainCheckerLine } from "./explain.js";
export {
  doctor,
  formatDoctor,
  doctorStatus,
  nodeVersionCheck,
  AUTOHOTKEY_V2,
  type DoctorCheck,
  type DoctorReport,
  type DoctorOptions,
} from "./doctor.js";

/** Structural validation of a compiled part (CompiledPart is accepted as is). */
export function validateCompiled(input: ValidateInput): Issue[] {
  return validateStructure(input);
}

/** Map flat .fzpz entries to the validator input (svgs keyed by the svg.<view>. prefix). */
export function entriesToInput(entries: { name: string; data: Uint8Array }[]): ValidateInput {
  const fzpEntry = entries.find((e) => e.name.startsWith("part.") && e.name.endsWith(".fzp"));
  const svgs: Partial<Record<View, string>> = {};
  for (const v of VIEWS) {
    const e = entries.find((x) => x.name.startsWith(`svg.${v}.`) && x.name.endsWith(".svg"));
    if (e) svgs[v] = strFromU8(e.data);
  }
  return { fzp: fzpEntry ? strFromU8(fzpEntry.data) : "", svgs, entries };
}

/** Unzip a .fzpz (bytes) and validate it. */
export function validateFzpzBytes(bytes: Uint8Array): Issue[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return [
      {
        level: "error",
        code: "zip-entries",
        message: `not a readable zip: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
  const input = entriesToInput(entries);
  if (input.fzp === "") {
    return [
      {
        level: "error",
        code: "zip-entries",
        message: "the .fzpz has no part.*.fzp entry",
        fix: "a .fzpz holds one fzp named part.<moduleId>.fzp",
      },
    ];
  }
  return validateStructure(input);
}

/** Read a .fzpz from disk and validate it. */
export function validateFzpzFile(path: string): Issue[] {
  return validateFzpzBytes(new Uint8Array(readFileSync(path)));
}

/** Validate a parsed part.json against the schema: one issue per zod error, with its path. */
export function validateSpecJson(json: unknown): Issue[] {
  const r = safeParsePartSpec(json);
  if (r.success) return [];
  return r.error.issues.map((zi) => {
    const path = zi.path.map(String).join(".");
    return {
      level: "error" as const,
      code: "spec-schema",
      message: path ? `${path}: ${zi.message}` : zi.message,
      ...(path ? { where: path } : {}),
    };
  });
}

/** ASCII report: one line per issue, errors first, e.g. "ERROR [layer-ids] ... (fix: ...)". */
export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return "No issues found.";
  const sorted = [
    ...issues.filter((i) => i.level === "error"),
    ...issues.filter((i) => i.level !== "error"),
  ];
  const lines = sorted.map((i) => {
    const level = i.level === "error" ? "ERROR" : "WARN ";
    const where = i.where ? ` <${i.where}>` : "";
    const fix = i.fix ? ` (fix: ${i.fix})` : "";
    return `${level} [${i.code}]${where} ${i.message}${fix}`;
  });
  const nErr = issues.filter((i) => i.level === "error").length;
  const nWarn = issues.length - nErr;
  lines.push(`${nErr} error${nErr === 1 ? "" : "s"}, ${nWarn} warning${nWarn === 1 ? "" : "s"}`);
  return lines.join("\n");
}
