/** `fritzkit prune <family-or-slug> [--keep <moduleId>] [--yes]`: dry run unless --yes. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FritzingRunningError } from "../../core/export/install.js";
import {
  listInstalledParts,
  prune,
  prunePlan,
  type InstalledPart,
} from "../../core/export/prune.js";
import { SLUG_RE } from "../../core/schema/part.js";
import { PART_FILE, readPartJson } from "../../core/workspace.js";
import {
  CliError,
  EXIT_FRITZING_RUNNING,
  fritzingPathsFor,
  fritzingRunningMessage,
  isRunningOf,
  workspaceOf,
  type CommandContext,
  type CommandResult,
} from "../context.js";

export interface PruneData {
  family: string;
  dryRun: boolean;
  keep: string[];
  remove: string[];
  removedDirs: string[];
}

/** A workspace slug maps to its spec's family (default: the slug); anything else is a family. */
export async function familyFor(arg: string, ctx: CommandContext): Promise<string> {
  const dir = join(workspaceOf(ctx), arg);
  if (SLUG_RE.test(arg) && existsSync(join(dir, PART_FILE))) {
    try {
      const raw = await readPartJson(dir);
      if (typeof raw.family === "string" && raw.family) return raw.family;
    } catch {
      // fall through: treat the slug as the family
    }
  }
  return arg;
}

const describe = (p: InstalledPart) => `${p.moduleId}${p.variant ? ` (${p.variant})` : ""}`;

export async function pruneCommand(
  arg: string,
  opts: { keep?: string; yes?: boolean },
  ctx: CommandContext,
): Promise<CommandResult<PruneData>> {
  const family = await familyFor(arg, ctx);
  const paths = fritzingPathsFor(ctx.env);
  const installed = await listInstalledParts(paths);
  const plan = prunePlan(installed, { family, ...(opts.keep ? { keep: opts.keep } : {}) });
  const data: PruneData = {
    family,
    dryRun: !opts.yes,
    keep: plan.keep.map((p) => p.moduleId),
    remove: plan.remove.map((p) => p.moduleId),
    removedDirs: [],
  };
  if (plan.keep.length === 0 && plan.remove.length === 0) {
    return {
      exitCode: 0,
      text: `no installed parts of family "${family}" in ${paths.userPartsDir}`,
      data,
    };
  }
  const lines = [
    ...plan.keep.map((p) => `keep    ${describe(p)}`),
    ...plan.remove.map((p) => `remove  ${describe(p)}  ${p.dir}`),
  ];
  if (plan.remove.length === 0) {
    lines.push("nothing to prune");
    return { exitCode: 0, text: lines.join("\n"), data };
  }
  try {
    const r = await prune(plan, { yes: opts.yes === true, paths, isRunning: isRunningOf(ctx) });
    data.removedDirs = r.removedDirs;
    lines.push(
      r.dryRun
        ? `dry run: ${plan.remove.length} folder(s) would be removed; pass --yes to delete`
        : `removed ${r.removedDirs.length} folder(s)`,
    );
  } catch (e) {
    if (e instanceof FritzingRunningError) {
      throw new CliError(fritzingRunningMessage("prune"), EXIT_FRITZING_RUNNING);
    }
    throw e;
  }
  return { exitCode: 0, text: lines.join("\n"), data };
}
