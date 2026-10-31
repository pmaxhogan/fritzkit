/** `fritzkit render <part> [--view ...] [--out <dir>] [--png]`. */
import { join, resolve } from "node:path";
import { VIEWS, type View } from "../../core/compile/types.js";
import { writeFileAtomic } from "../../core/export/bin.js";
import { readFzpz } from "../../core/export/fzpz.js";
import { entriesToInput } from "../../core/validate/index.js";
import {
  CliError,
  cwdOf,
  resolveTarget,
  type CommandContext,
  type CommandResult,
} from "../context.js";
import { svgToPng, DEFAULT_DPI } from "../raster.js";
import { compileDir } from "./validate.js";

export type ViewArg = View | "all";

export interface LoadedSvgs {
  moduleId: string;
  svgs: Partial<Record<View, string>>;
  /** Default output folder: <partdir>/build (or build/ next to the .fzpz). */
  buildDir: string;
  warnings: string[];
}

/** Compile a part folder, or read the SVGs out of a .fzpz. */
export async function loadSvgs(part: string, ctx: CommandContext): Promise<LoadedSvgs> {
  const target = await resolveTarget(part, ctx);
  if (target.kind === "fzpz") {
    const contents = await readFzpz(target.path);
    return {
      moduleId: contents.moduleId,
      svgs: entriesToInput(contents.entries).svgs,
      buildDir: join(target.dir, "build"),
      warnings: [],
    };
  }
  const compiled = await compileDir(target.dir, ctx);
  return {
    moduleId: compiled.identity.moduleId,
    svgs: compiled.svgs,
    buildDir: join(target.dir, "build"),
    warnings: compiled.warnings,
  };
}

export function parseView(view: string | undefined): ViewArg {
  const v = view ?? "all";
  if (v === "all" || (VIEWS as readonly string[]).includes(v)) return v as ViewArg;
  throw new CliError(`unknown view "${v}"; use one of ${[...VIEWS, "all"].join(", ")}`);
}

export interface RenderData {
  moduleId: string;
  files: string[];
  warnings: string[];
}

export async function renderCommand(
  part: string,
  opts: { view?: string; out?: string; png?: boolean; dpi?: number },
  ctx: CommandContext,
): Promise<CommandResult<RenderData>> {
  const view = parseView(opts.view);
  const loaded = await loadSvgs(part, ctx);
  const outDir = opts.out ? resolve(cwdOf(ctx), opts.out) : loaded.buildDir;
  const views = view === "all" ? VIEWS : [view];
  const files: string[] = [];
  for (const v of views) {
    const svg = loaded.svgs[v];
    if (svg === undefined) throw new CliError(`the part has no ${v} view`);
    const svgPath = join(outDir, `${v}.svg`);
    await writeFileAtomic(svgPath, svg);
    files.push(svgPath);
    if (opts.png) {
      const pngPath = join(outDir, `${v}.png`);
      await writeFileAtomic(pngPath, await svgToPng(svg, opts.dpi ?? DEFAULT_DPI));
      files.push(pngPath);
    }
  }
  const text = [...loaded.warnings.map((w) => `warning: ${w}`), ...files].join("\n");
  return {
    exitCode: 0,
    text,
    data: { moduleId: loaded.moduleId, files, warnings: loaded.warnings },
  };
}
