/** `fritzkit export <part> [--out] [--install] [--force]` and `fritzkit install <part>`. */
import { join, resolve } from "node:path";
import { writeFzpz } from "../../core/export/fzpz.js";
import {
  FritzingRunningError,
  installPart,
  type InstallResult,
} from "../../core/export/install.js";
import {
  formatIssues,
  validateCompiled,
  validateFzpzFile,
  type Issue,
} from "../../core/validate/index.js";
import {
  CliError,
  cwdOf,
  EXIT_FRITZING_RUNNING,
  fritzingPathsFor,
  fritzingRunningMessage,
  isRunningOf,
  resolveTarget,
  type CommandContext,
  type CommandResult,
} from "../context.js";
import { compileDir, warningIssues } from "./validate.js";

export interface ExportOptions {
  out?: string;
  install?: boolean;
  /** Export (and install) even when the structural validator reports errors. */
  force?: boolean;
}

export interface ExportData {
  moduleId: string;
  fzpz: string;
  issues: Issue[];
  installed?: Pick<InstallResult, "installedDir" | "alreadyInstalled" | "files" | "warnings">;
}

async function install(
  source: Parameters<typeof installPart>[0],
  fzpz: string,
  ctx: CommandContext,
): Promise<InstallResult> {
  try {
    return await installPart(source, {
      paths: fritzingPathsFor(ctx.env),
      isRunning: isRunningOf(ctx),
    });
  } catch (e) {
    if (e instanceof FritzingRunningError) {
      throw new CliError(
        `${fritzingRunningMessage("install")}\nThe .fzpz is ready at ${fzpz}.`,
        EXIT_FRITZING_RUNNING,
      );
    }
    throw e;
  }
}

export async function exportCommand(
  part: string,
  opts: ExportOptions,
  ctx: CommandContext,
): Promise<CommandResult<ExportData>> {
  if (opts.out !== undefined && !/\.fzpz$/i.test(opts.out)) {
    throw new CliError(`--out must name a .fzpz file (got "${opts.out}")`);
  }
  const target = await resolveTarget(part, ctx);
  let moduleId: string;
  let fzpz: string;
  let issues: Issue[];
  let source: Parameters<typeof installPart>[0];

  if (target.kind === "fzpz") {
    if (!opts.install) {
      throw new CliError(
        `${target.path} is already a .fzpz; use \`fritzkit install\` to install it`,
      );
    }
    issues = validateFzpzFile(target.path);
    fzpz = target.path;
    source = target.path;
    moduleId = "";
  } else {
    const compiled = await compileDir(target.dir, ctx);
    moduleId = compiled.identity.moduleId;
    issues = [...validateCompiled(compiled), ...warningIssues(compiled.warnings)];
    fzpz = opts.out ? resolve(cwdOf(ctx), opts.out) : join(target.dir, `${moduleId}.fzpz`);
    source = compiled;
  }

  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0 && !opts.force) {
    return {
      exitCode: 1,
      text: `${formatIssues(issues)}\nnot exported: fix the errors above or pass --force`,
      data: { moduleId, fzpz: "", issues },
    };
  }

  const lines: string[] = [];
  if (issues.length > 0) lines.push(formatIssues(issues));
  if (target.kind === "dir") {
    await writeFzpz(source as Exclude<typeof source, string>, fzpz);
    lines.push(`wrote ${fzpz}`, `moduleId ${moduleId}`);
  }
  const data: ExportData = { moduleId, fzpz, issues };
  if (opts.install) {
    const r = await install(source, fzpz, ctx);
    data.moduleId = r.moduleId;
    data.installed = {
      installedDir: r.installedDir,
      alreadyInstalled: r.alreadyInstalled,
      files: r.files,
      warnings: r.warnings,
    };
    if (target.kind === "fzpz") lines.push(`moduleId ${r.moduleId}`);
    lines.push(
      ...r.warnings.map((w) => `warning: ${w}`),
      `${r.alreadyInstalled ? "re-installed" : "installed"} to ${r.installedDir}`,
      "start Fritzing: the part is in the My Parts bin (search for its title)",
    );
  }
  return { exitCode: 0, text: lines.join("\n"), data };
}

export function installCommand(
  part: string,
  opts: Omit<ExportOptions, "install">,
  ctx: CommandContext,
): Promise<CommandResult<ExportData>> {
  return exportCommand(part, { ...opts, install: true }, ctx);
}
