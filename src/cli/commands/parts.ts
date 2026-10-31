/** `fritzkit init`, `fritzkit new <slug>` and `fritzkit list`. */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePartSpec } from "../../core/schema/part.js";
import {
  ASSETS_DIR,
  initWorkspace,
  listParts,
  newPartTemplate,
  partDir,
  writePart,
  type PartListing,
} from "../../core/workspace.js";
import type { PartSpecInput } from "../../core/schema/part.js";
import { CliError, workspaceOf, type CommandContext, type CommandResult } from "../context.js";

export async function initCommand(
  ctx: CommandContext,
): Promise<CommandResult<{ workspace: string }>> {
  const workspace = await initWorkspace(workspaceOf(ctx));
  return { exitCode: 0, text: workspace, data: { workspace } };
}

/** Write a new part folder: part.json + assets/.gitkeep. Refuses an existing folder. */
export async function createPartFolder(
  dir: string,
  raw: PartSpecInput,
): Promise<{ dir: string; partJson: string }> {
  if (existsSync(dir)) {
    throw new CliError(`${dir} already exists; pick another slug or edit that part`);
  }
  parsePartSpec(raw);
  const partJson = await writePart(dir, raw);
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });
  await writeFile(join(dir, ASSETS_DIR, ".gitkeep"), "");
  return { dir, partJson };
}

export async function newCommand(
  slug: string,
  opts: { title?: string },
  ctx: CommandContext,
): Promise<CommandResult<{ slug: string; dir: string; partJson: string }>> {
  const dir = partDir(workspaceOf(ctx), slug);
  const { partJson } = await createPartFolder(dir, newPartTemplate(slug, opts.title ?? slug));
  return {
    exitCode: 0,
    text: `created ${partJson}\nedit it, then run: fritzkit validate ${slug}`,
    data: { slug, dir, partJson },
  };
}

export async function listCommand(
  ctx: CommandContext,
): Promise<CommandResult<{ workspace: string; parts: PartListing[] }>> {
  const workspace = workspaceOf(ctx);
  const parts = await listParts(workspace);
  if (parts.length === 0) {
    return {
      exitCode: 0,
      text: `no parts in ${workspace} (create one with: fritzkit new <slug>)`,
      data: { workspace, parts },
    };
  }
  const width = Math.max(...parts.map((p) => p.slug.length));
  const text = parts.map((p) => `${p.slug.padEnd(width)}  ${p.title}`).join("\n");
  return { exitCode: 0, text, data: { workspace, parts } };
}
