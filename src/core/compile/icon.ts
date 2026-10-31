/**
 * Icon view renderer: the parts bin thumbnail. A fixed 320 mil square holding the
 * breadboard artwork (same drawing, every id stripped so the icon carries no
 * connector ids) scaled to fit inside a 16 mil margin and centred. A long thin board
 * becomes a thin strip, as with Fritzing's own parts.
 */
import type { ResolvedPart } from "../resolve.js";
import { svgRoot } from "../svg.js";
import { fmt, milToMm, mmToMil } from "../units.js";
import { extraNamespaces, group, renderBreadboardContent } from "./breadboard.js";
import type { RenderContext } from "./types.js";

export const ICON_SIZE_MIL = 320;
export const ICON_MARGIN_MIL = 16;

/** Scale + translate that fits a w x h mil drawing into the icon square, centred. */
export function iconTransform(
  wMil: number,
  hMil: number,
): { scale: number; tx: number; ty: number } {
  const avail = ICON_SIZE_MIL - 2 * ICON_MARGIN_MIL;
  // Floor the scale to the 3 decimals fmt emits (never overflow the margin) and centre
  // with exactly the emitted value.
  const scale = Math.max(0.001, Math.floor(Math.min(avail / wMil, avail / hMil) * 1000) / 1000);
  return {
    scale,
    tx: (ICON_SIZE_MIL - wMil * scale) / 2,
    ty: (ICON_SIZE_MIL - hMil * scale) / 2,
  };
}

export function renderIcon(part: ResolvedPart, ctx: RenderContext): string {
  const body = renderBreadboardContent(part, ctx, { ids: false });
  const t = iconTransform(mmToMil(part.frame.widthMm), mmToMil(part.frame.heightMm));
  const inner = group(undefined, body, {
    transform: `translate(${fmt(t.tx)} ${fmt(t.ty)}) scale(${fmt(t.scale)})`,
  });
  const side = milToMm(ICON_SIZE_MIL);
  return svgRoot(side, side, [group("icon", [inner])], extraNamespaces(ctx));
}
