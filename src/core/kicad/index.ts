/**
 * KiCad footprint import (decision D18): turn a .kicad_mod into a part.json fragment
 * with the footprint's exact pad geometry.
 *
 * Mapping (footprint frame -> part frame): the chosen outline bbox's top-left corner
 * becomes the part origin, so every coordinate is shifted by (-minX, -minY). Both
 * frames are y-down (see footprint.ts), so nothing is flipped. Every emitted length
 * is rounded to 1e-4 mm, which keeps the output deterministic and free of float noise.
 *
 * - thru_hole pad -> Pin type "female" with holeMm = drill (smaller axis for an oval
 *   drill); smd and connect pads (and a thru_hole pad without a drill) -> Pin type "pad",
 *   smd: true, no hole.
 * - np_thru_hole pad -> outline.holes entry, not a pin.
 * - A pad with no copper layer (only F.Mask / F.Paste ...) is skipped: not a pin.
 * - Pad shape circle -> round, rect/roundrect -> rect, oval -> oval, custom/trapezoid
 *   -> rect using the anchor (size) box. 90/270 degree rotations swap w and h.
 * - Pads sharing a number (KiCad: electrically the same pad) get keys p1, p1_2, ...
 *   and are tied together with a bus (bus ids pad_<n>, deduped the same way).
 * - Pads on a regular 2.54 mm grid are NOT turned into headers; every pad stays an
 *   individual pin so the geometry is exact.
 *
 * importKicadFile is the one function here that touches the filesystem (it only reads
 * the file); everything else is pure.
 */
import { readFile } from "node:fs/promises";
import type { PartSpecInput } from "../schema/part.js";
import { padExtent, parseKicadMod, type BBox, type KicadFootprint } from "./footprint.js";

export * from "./sexpr.js";
export * from "./footprint.js";

export type KicadOutlineSource = "courtyard" | "fab" | "edge" | "pads";

export interface KicadImportOptions {
  slug: string;
  title?: string;
  /** Which bbox becomes the outline. Default: first available of edge, courtyard, fab, pads. */
  outline?: KicadOutlineSource;
}

export class KicadImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KicadImportError";
  }
}

/** Margin added around the pads when the outline comes from the pad bbox. */
export const PAD_OUTLINE_MARGIN_MM = 1;

const r4 = (v: number): number => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

function usable(b: BBox | undefined): b is BBox {
  return b !== undefined && b.maxX - b.minX > 1e-6 && b.maxY - b.minY > 1e-6;
}

/** The bbox the outline is taken from, and which source it came from. */
export function chooseOutline(
  fp: KicadFootprint,
  want?: KicadOutlineSource,
): { source: KicadOutlineSource; box: BBox } {
  const padBox = (): BBox | undefined => {
    const b = fp.bbox.pads;
    if (!b) return undefined;
    const m = PAD_OUTLINE_MARGIN_MM;
    return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
  };
  const get = (s: KicadOutlineSource): BBox | undefined => (s === "pads" ? padBox() : fp.bbox[s]);
  if (want) {
    const box = get(want);
    if (!usable(box)) {
      throw new KicadImportError(
        `footprint "${fp.name}" has no usable ${want} outline` +
          (want === "pads" ? " (no pads)" : ` (no non-degenerate graphics on that layer)`),
      );
    }
    return { source: want, box };
  }
  for (const s of ["edge", "courtyard", "fab", "pads"] as const) {
    const box = get(s);
    if (usable(box)) return { source: s, box };
  }
  throw new KicadImportError(
    `footprint "${fp.name}" has no pads and no Edge.Cuts, courtyard or fab graphics`,
  );
}

function sanitize(s: string, re: RegExp): string {
  return s.replace(re, "_");
}

const OUTLINE_LABEL: Record<KicadOutlineSource, string> = {
  edge: "Edge.Cuts",
  courtyard: "courtyard",
  fab: "fab layer",
  pads: `pad bounding box + ${PAD_OUTLINE_MARGIN_MM} mm`,
};

/** Convert a parsed footprint into a part.json fragment (PartSpecInput). */
export function kicadToSpecFragment(fp: KicadFootprint, opts: KicadImportOptions): PartSpecInput {
  const { source, box } = chooseOutline(fp, opts.outline);
  const ox = box.minX;
  const oy = box.minY;

  const pins: NonNullable<PartSpecInput["pins"]> = [];
  const holes: { xMm: number; yMm: number; dMm: number }[] = [];
  const usedKeys = new Set<string>();
  const byNumber = new Map<string, string[]>();
  const order: string[] = [];

  for (const pad of fp.pads) {
    const xMm = r4(pad.x - ox);
    const yMm = r4(pad.y - oy);
    if (pad.type === "np_thru_hole") {
      const dMm = r4(pad.drill ?? Math.min(pad.w, pad.h));
      if (!(dMm > 0)) {
        throw new KicadImportError(
          `line ${pad.line}: np_thru_hole pad has no positive drill or size, cannot make a hole`,
        );
      }
      holes.push({ xMm, yMm, dMm });
      continue;
    }
    // Aperture-only pads (F.Mask / F.Paste with no copper layer) are not electrical: skip
    // them. A pad without a (layers) list is treated as copper.
    if (pad.layers.length > 0 && !pad.layers.some((l) => l.endsWith(".Cu"))) continue;
    const base = "p" + sanitize(pad.number, /[^A-Za-z0-9_.+-]/g);
    let key = base;
    let name = pad.number || "pad";
    for (let i = 2; usedKeys.has(key); i++) key = `${base}_${i}`;
    usedKeys.add(key);
    if (pad.number) {
      if (!byNumber.has(pad.number)) {
        byNumber.set(pad.number, []);
        order.push(pad.number);
      }
      byNumber.get(pad.number)!.push(key);
      const n = byNumber.get(pad.number)!.length;
      // A repeated number is named "9 (2)", not "9" or "9_2" (Python int() accepts "9_2"):
      // the Fritzing checker's connector_numbering rule warns when an integer name is not
      // its connector index + 1, which a second copy can never satisfy. The bus ties the
      // copies together. (That rule still warns if integer pads are listed out of order.)
      if (n > 1) name = `${pad.number} (${n})`;
    }

    const ext = padExtent(pad);
    if (!(r4(ext.w) > 0 && r4(ext.h) > 0)) {
      throw new KicadImportError(`line ${pad.line}: pad "${pad.number}" has a zero size`);
    }
    const shape = pad.shape === "circle" ? "round" : pad.shape === "oval" ? "oval" : "rect";
    const tht = pad.type === "thru_hole" && pad.drill !== undefined;
    const geom: NonNullable<NonNullable<PartSpecInput["pins"]>[number]["pad"]> = {
      shape,
      wMm: r4(ext.w),
      hMm: r4(ext.h),
    };
    if (tht) geom.holeMm = r4(pad.drill!);
    else geom.smd = true;
    pins.push({
      key,
      name: name.slice(0, 40),
      type: tht ? "female" : "pad",
      role: "io",
      xMm,
      yMm,
      pad: geom,
    });
  }

  const usedBusIds = new Set<string>();
  const buses = order
    .filter((n) => byNumber.get(n)!.length > 1)
    .map((n) => {
      const base = "pad_" + sanitize(n, /[^A-Za-z0-9_.-]/g);
      let id = base;
      for (let i = 2; usedBusIds.has(id); i++) id = `${base}_${i}`;
      usedBusIds.add(id);
      return { id, pins: byNumber.get(n)! };
    });

  const tags = new Set<string>(["kicad"]);
  for (const t of (fp.tags ?? "").split(/[\s,]+/)) if (t && t.length <= 30) tags.add(t);

  const description = [
    `Imported from KiCad footprint "${fp.name}" (exact pad geometry).`,
    fp.descr ?? "",
    `Outline from the ${OUTLINE_LABEL[source]}. Pads are kept as individual pins (pads on a 2.54 mm grid are not converted to headers).`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  const title = (opts.title ?? (fp.name || opts.slug)).slice(0, 120);
  const spec: PartSpecInput = {
    slug: opts.slug,
    title,
    tags: [...tags],
    description,
    outline: {
      widthMm: r4(box.maxX - box.minX),
      heightMm: r4(box.maxY - box.minY),
      shape: "rect",
      cornerRadiusMm: 0,
      holes,
    },
    pins,
  };
  if (fp.name) spec.properties = { "kicad footprint": fp.name };
  if (buses.length) spec.buses = buses;
  return spec;
}

/** Read a .kicad_mod (utf8), parse it and convert it to a part.json fragment. */
export async function importKicadFile(
  path: string,
  opts: KicadImportOptions,
): Promise<PartSpecInput> {
  const text = await readFile(path, "utf8");
  return kicadToSpecFragment(parseKicadMod(text), opts);
}
