/**
 * Part identity (decisions D12 / D12a).
 *
 * moduleId = fritzkit-<slug>-<hash8>   unique per exported content; Fritzing refuses a
 *                                       duplicate moduleId, so every change gets a new one
 * family   = spec.family ?? slug        stable across versions (Inspector swap group)
 * variant  = v<version> <hash8>         unique per export, differs between family members
 *
 * hash8 = first 8 hex chars of sha256 over the canonical spec JSON (sorted keys,
 * $schema dropped) followed by every asset file (name + bytes, sorted by name).
 */
import { createHash } from "node:crypto";
import type { PartSpec } from "./schema/part.js";

export const MODULE_ID_RE = /^[A-Za-z0-9_.-]{8,}$/;

export interface Asset {
  /** Path relative to the part folder, forward slashes, e.g. "assets/top.png". */
  name: string;
  data: Uint8Array;
}

export interface PartIdentity {
  moduleId: string;
  family: string;
  variant: string;
  hash8: string;
  /** Base file name used for every SVG and the fzp inside the .fzpz. */
  baseName: string;
}

/** JSON with recursively sorted object keys; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export function contentHash(spec: PartSpec, assets: Asset[] = []): string {
  const h = createHash("sha256");
  const { $schema: _schema, ...rest } = spec;
  h.update(canonicalJson(rest));
  for (const a of [...assets].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    h.update("\0" + a.name + "\0");
    h.update(a.data);
  }
  return h.digest("hex");
}

export function identityFor(spec: PartSpec, assets: Asset[] = []): PartIdentity {
  const hash8 = contentHash(spec, assets).slice(0, 8);
  const moduleId = `fritzkit-${spec.slug}-${hash8}`;
  if (!MODULE_ID_RE.test(moduleId)) {
    throw new Error(`moduleId "${moduleId}" is not filename-safe`);
  }
  return {
    moduleId,
    family: spec.family ?? spec.slug,
    variant: `v${spec.version} ${hash8}`,
    hash8,
    baseName: moduleId,
  };
}

/** Zip entry names inside a .fzpz for a given identity (flat, no folders). */
export function fzpzEntryNames(id: PartIdentity) {
  return {
    fzp: `part.${id.moduleId}.fzp`,
    breadboard: `svg.breadboard.${id.baseName}_breadboard.svg`,
    schematic: `svg.schematic.${id.baseName}_schematic.svg`,
    pcb: `svg.pcb.${id.baseName}_pcb.svg`,
    icon: `svg.icon.${id.baseName}_icon.svg`,
  } as const;
}

/** The <layers image="..."> value for a view; must match the zip entry after Fritzing's rewrite. */
export function layerImage(
  id: PartIdentity,
  view: "breadboard" | "schematic" | "pcb" | "icon",
): string {
  return `${view}/${id.baseName}_${view}.svg`;
}
