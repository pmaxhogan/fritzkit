/**
 * compilePart: PartSpec (+ assets) -> fzp + four SVGs + flat zip entry list.
 * Deterministic for a fixed date; never touches the network or the filesystem.
 */
import { identityFor, fzpzEntryNames, type Asset } from "../identity.js";
import { resolvePart } from "../resolve.js";
import type { PartSpec } from "../schema/part.js";
import { renderBreadboard } from "./breadboard.js";
import { buildFzp } from "./fzp.js";
import { renderIcon } from "./icon.js";
import { renderPcb } from "./pcb.js";
import { renderSchematic } from "./schematic.js";
import type { CompileOptions, CompiledPart, RenderContext } from "./types.js";

export const GENERATOR = "fritzkit";

const enc = new TextEncoder();

export async function compilePart(
  spec: PartSpec,
  opts: CompileOptions = {},
): Promise<CompiledPart> {
  const warnings: string[] = [];
  const assets: Asset[] = [];
  if (opts.assets) {
    for (const [name, data] of [...opts.assets.entries()].sort()) assets.push({ name, data });
  }
  const identity = identityFor(spec, assets);
  const resolved = resolvePart(spec);

  const ctx: RenderContext = {
    identity,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    generator: opts.generator ?? GENERATOR,
  };

  if (spec.artwork.style === "photo") {
    const src = spec.artwork.photo?.src;
    const data = src ? opts.assets?.get(src) : undefined;
    if (!src || !data) {
      warnings.push(
        `artwork.style is "photo" but asset "${src ?? "(none)"}" was not provided; rendering vector style`,
      );
    } else if (!opts.preparePhoto) {
      warnings.push(
        'artwork.style is "photo" but no photo preparer is available; rendering vector style',
      );
    } else {
      const photo = await opts.preparePhoto(data, spec);
      if (photo) ctx.photo = photo;
      else warnings.push("photo preparation failed; rendering vector style");
    }
  }

  const svgs = {
    breadboard: renderBreadboard(resolved, ctx),
    schematic: renderSchematic(resolved, ctx),
    pcb: renderPcb(resolved, ctx),
    icon: renderIcon(resolved, ctx),
  };
  const fzp = buildFzp(resolved, ctx);

  const names = fzpzEntryNames(identity);
  const entries = [
    { name: names.fzp, data: enc.encode(fzp) },
    { name: names.breadboard, data: enc.encode(svgs.breadboard) },
    { name: names.schematic, data: enc.encode(svgs.schematic) },
    { name: names.pcb, data: enc.encode(svgs.pcb) },
    { name: names.icon, data: enc.encode(svgs.icon) },
  ];

  return { identity, resolved, fzp, svgs, entries, warnings };
}
