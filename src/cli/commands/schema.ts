/** `fritzkit schema [--out <file>]`: the published JSON Schema for part.json. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../core/export/bin.js";
import { CliError, cwdOf, type CommandContext, type CommandResult } from "../context.js";

/**
 * Locate part.schema.json relative to this module: src/cli/commands -> src/core/schema in
 * a checkout, dist/cli/commands -> dist/core/schema after `npm run build`.
 */
export function schemaPath(base: string | URL = import.meta.url): string {
  const candidates = [
    new URL("../../core/schema/part.schema.json", base),
    new URL("../../../src/core/schema/part.schema.json", base),
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new CliError(`part.schema.json not found (looked in ${candidates.join(", ")})`);
  return found;
}

export async function readSchemaText(): Promise<string> {
  return readFile(schemaPath(), "utf8");
}

export async function schemaCommand(
  opts: { out?: string },
  ctx: CommandContext,
): Promise<CommandResult<unknown>> {
  const text = await readSchemaText();
  const data = JSON.parse(text) as unknown;
  if (opts.out) {
    const out = resolve(cwdOf(ctx), opts.out);
    await writeFileAtomic(out, text);
    return { exitCode: 0, text: `wrote ${out}`, data: { path: out } };
  }
  return { exitCode: 0, text: text.replace(/\n$/, ""), data };
}
