/**
 * Build a self-contained Fritzing sketch (.fzz) that contains ONLY one fritzkit part.
 * Verified on Fritzing 1.0.7b: `Fritzing.exe -svg <folder>` renders such a sketch without
 * importing the part first, because the .fzz embeds the part files with the same entry
 * names a .fzpz uses (part.<id>.fzp, svg.<view>.<base>.svg).
 */
import { zipSync } from "fflate";
import type { CompiledPart } from "../../src/core/compile/types.js";

export interface SketchOptions {
  /** Instance title shown in Fritzing (reference designator). */
  title?: string;
  /** Breadboard position in Fritzing scene pixels (90 dpi). */
  x?: number;
  y?: number;
  modelIndex?: number;
}

export function buildPartOnlySketchXml(compiled: CompiledPart, opts: SketchOptions = {}): string {
  const id = compiled.identity.moduleId;
  const title = opts.title ?? `${compiled.resolved.spec.label}1`;
  const x = opts.x ?? 100;
  const y = opts.y ?? 100;
  const modelIndex = opts.modelIndex ?? 5811;
  const pcbLayer = compiled.resolved.hasTht ? "copper0" : "copper1";
  return `<?xml version="1.0" encoding="UTF-8"?>
<module fritzingVersion="1.0.7">
    <views>
        <view name="breadboardView" backgroundColor="#ffffff" gridSize="0.05in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>
        <view name="schematicView" backgroundColor="#ffffff" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>
        <view name="pcbView" backgroundColor="#333333" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>
    </views>
    <instances>
        <instance moduleIdRef="${id}" modelIndex="${modelIndex}" path="${id}.fzp">
            <title>${title}</title>
            <views>
                <breadboardView layer="breadboard">
                    <geometry z="2.5" x="${x}" y="${y}"/>
                </breadboardView>
                <schematicView layer="schematic">
                    <geometry z="2.5" x="${x}" y="${y}"/>
                </schematicView>
                <pcbView layer="${pcbLayer}">
                    <geometry z="5.5" x="${x}" y="${y}"/>
                </pcbView>
            </views>
        </instance>
    </instances>
</module>
`;
}

/** Zip bytes of a .fzz named <sketchName>.fzz containing <sketchName>.fz + the part entries. */
export function buildPartOnlySketchFzz(
  compiled: CompiledPart,
  sketchName: string,
  opts: SketchOptions = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files[`${sketchName}.fz`] = new TextEncoder().encode(buildPartOnlySketchXml(compiled, opts));
  for (const e of compiled.entries) files[e.name] = e.data;
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
