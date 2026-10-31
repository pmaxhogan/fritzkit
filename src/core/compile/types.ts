/**
 * Contracts between the compile orchestrator and the four view renderers plus the fzp
 * builder. Renderers are pure: (ResolvedPart, RenderContext) -> SVG string.
 */
import type { PartIdentity } from "../identity.js";
import type { ResolvedPart } from "../resolve.js";

export type View = "breadboard" | "schematic" | "pcb" | "icon";
export const VIEWS: readonly View[] = ["breadboard", "schematic", "pcb", "icon"] as const;

/** A raster prepared by the image module for the photo artwork style. */
export interface PreparedPhoto {
  /** PNG bytes, already cropped/rotated/keyed, sized to cover the outline. */
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** Opacity to draw it with (from spec.artwork.photo.opacity). */
  opacity: number;
}

export interface RenderContext {
  identity: PartIdentity;
  /** Present only when artwork.style is "photo" and the asset could be prepared. */
  photo?: PreparedPhoto;
  /** ISO date YYYY-MM-DD written into the fzp (fixed in tests for determinism). */
  date: string;
  /** fritzkit version string for the fzp <author>/<description> footer. */
  generator: string;
}

export type ViewRenderer = (part: ResolvedPart, ctx: RenderContext) => string;

export interface CompiledPart {
  identity: PartIdentity;
  resolved: ResolvedPart;
  fzp: string;
  svgs: Record<View, string>;
  /** Flat zip entries in the order they are written. */
  entries: { name: string; data: Uint8Array }[];
  /** Notes for the user: e.g. "photo asset missing, fell back to vector". */
  warnings: string[];
}

export interface CompileOptions {
  date?: string;
  generator?: string;
  /** Assets referenced by the spec (photo). Keyed by the spec-relative path. */
  assets?: Map<string, Uint8Array>;
  /** Hook that turns the photo asset into a PreparedPhoto (async, uses sharp). */
  preparePhoto?: (
    data: Uint8Array,
    spec: ResolvedPart["spec"],
  ) => Promise<PreparedPhoto | undefined>;
}

/** Layer ids each view lists in the fzp. */
export function layerIdsFor(view: View, hasTht: boolean): string[] {
  switch (view) {
    case "breadboard":
      return ["breadboard"];
    case "schematic":
      return ["schematic"];
    case "pcb":
      return hasTht ? ["copper0", "copper1", "silkscreen"] : ["copper1", "silkscreen"];
    case "icon":
      return ["icon"];
  }
}
