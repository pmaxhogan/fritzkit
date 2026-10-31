/** `fritzkit import-kicad <file.kicad_mod> --slug <slug> [--title <t>]`. */
import { resolve } from "node:path";
import { importKicadFile } from "../../core/kicad/index.js";
import type { PartSpecInput } from "../../core/schema/part.js";
import { partDir, SCHEMA_URL } from "../../core/workspace.js";
import { cwdOf, workspaceOf, type CommandContext, type CommandResult } from "../context.js";
import { createPartFolder } from "./parts.js";

export async function importKicadCommand(
  file: string,
  opts: { slug: string; title?: string },
  ctx: CommandContext,
): Promise<CommandResult<{ slug: string; dir: string; partJson: string; pins: number }>> {
  const dir = partDir(workspaceOf(ctx), opts.slug);
  const fragment = await importKicadFile(resolve(cwdOf(ctx), file), {
    slug: opts.slug,
    ...(opts.title ? { title: opts.title } : {}),
  });
  const raw: PartSpecInput = { $schema: SCHEMA_URL, ...fragment };
  const { partJson } = await createPartFolder(dir, raw);
  const pins = raw.pins?.length ?? 0;
  return {
    exitCode: 0,
    text: `created ${partJson} (${pins} pad${pins === 1 ? "" : "s"})\nnext: name the pins, then run: fritzkit validate ${opts.slug}`,
    data: { slug: opts.slug, dir, partJson, pins },
  };
}
