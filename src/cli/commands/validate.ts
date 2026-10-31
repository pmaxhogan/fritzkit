/** `fritzkit validate <part> [--checker]`: schema -> compile -> structural -> fzp checker. */
import { join } from "node:path";
import { writeFzpz } from "../../core/export/fzpz.js";
import {
  formatIssues,
  runFzpChecker,
  validateCompiled,
  validateFzpzFile,
  validateSpecJson,
  type CheckerResult,
  type Issue,
} from "../../core/validate/index.js";
import { compileFromDir, readPartJson, type CompileFromDirResult } from "../../core/workspace.js";
import {
  dateOf,
  resolveTarget,
  SCHEMA_HINT,
  type CommandContext,
  type CommandResult,
} from "../context.js";

export interface ValidateData {
  target: string;
  ok: boolean;
  moduleId?: string;
  issues: Issue[];
  checker?: Pick<CheckerResult, "available" | "exitCode" | "errors" | "warnings"> & {
    /** true when the Fritzing checker actually ran; false when it was skipped. */
    ran: boolean;
    /** The one-line status printed by the CLI. */
    summary: string;
  };
}

/** One-line status of the Fritzing checker run. */
export function checkerSummary(r: CheckerResult): string {
  if (!r.available) {
    return `fzp checker: skipped - ${r.errors[0] ?? "not available"}`;
  }
  return `fzp checker: ran (${r.errors.length} errors, ${r.warnings.length} warnings)`;
}

/** Compile warnings ("photo asset missing ...") as warning issues. */
export function warningIssues(warnings: readonly string[]): Issue[] {
  return warnings.map((message) => ({ level: "warning", code: "compile", message }));
}

/** Compile a part folder with the context's date. */
export function compileDir(dir: string, ctx: CommandContext): Promise<CompileFromDirResult> {
  return compileFromDir(dir, { date: dateOf(ctx) });
}

function checkerIssues(r: CheckerResult): Issue[] {
  if (!r.available) {
    return [
      {
        level: "warning",
        code: "fzp-checker-unavailable",
        message: r.errors[0] ?? "the fzp checker is not available",
      },
    ];
  }
  return [
    ...r.errors.map((message): Issue => ({ level: "error", code: "fzp-checker", message })),
    ...r.warnings.map((message): Issue => ({ level: "warning", code: "fzp-checker", message })),
  ];
}

export async function validateCommand(
  part: string,
  opts: { checker?: boolean },
  ctx: CommandContext,
): Promise<CommandResult<ValidateData>> {
  const target = await resolveTarget(part, ctx);
  const issues: Issue[] = [];
  let moduleId: string | undefined;
  let fzpzPath: string;
  let label: string;

  if (target.kind === "fzpz") {
    label = target.path;
    fzpzPath = target.path;
    issues.push(...validateFzpzFile(target.path));
  } else {
    label = target.dir;
    const raw = await readPartJson(target.dir);
    const specIssues = validateSpecJson(raw);
    if (specIssues.length > 0) {
      return {
        exitCode: 1,
        text: `${formatIssues(specIssues)}\n${SCHEMA_HINT}`,
        data: { target: label, ok: false, issues: specIssues },
      };
    }
    const compiled = await compileDir(target.dir, ctx);
    moduleId = compiled.identity.moduleId;
    issues.push(...validateCompiled(compiled), ...warningIssues(compiled.warnings));
    fzpzPath = join(target.dir, "build", `${moduleId}.fzpz`);
    if (opts.checker) await writeFzpz(compiled, fzpzPath);
  }

  let checker: ValidateData["checker"];
  if (opts.checker) {
    const r = await (ctx.runChecker ?? runFzpChecker)(fzpzPath);
    checker = {
      available: r.available,
      exitCode: r.exitCode,
      errors: r.errors,
      warnings: r.warnings,
      ran: r.available,
      summary: checkerSummary(r),
    };
    issues.push(...checkerIssues(r));
  }

  const ok = !issues.some((i) => i.level === "error");
  const head = moduleId ? `${label} (${moduleId})` : label;
  const data: ValidateData = { target: label, ok, issues };
  if (moduleId) data.moduleId = moduleId;
  if (checker) data.checker = checker;
  const lines = [head, formatIssues(issues)];
  if (checker) lines.push(checker.summary);
  return { exitCode: ok ? 0 : 1, text: lines.join("\n"), data };
}
