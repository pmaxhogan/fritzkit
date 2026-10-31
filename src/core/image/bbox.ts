/**
 * Photo calibration: map between photo pixels and the part frame (mm, origin at the
 * outline's top-left, x right, y down) given the detected board bbox and the known
 * outline size. Pixel coordinates are continuous: (bbox.x, bbox.y) is the left/top edge
 * of the board and (bbox.x + bbox.w, bbox.y + bbox.h) its right/bottom edge, so the
 * centre of pixel column i is at i + 0.5.
 */
import type { PixelBox } from "./key.js";

export interface OutlineSize {
  widthMm: number;
  heightMm: number;
}

function check(bbox: PixelBox, outline: OutlineSize): void {
  if (!(bbox.w > 0 && bbox.h > 0)) {
    throw new RangeError(`board bbox must have a positive size, got ${bbox.w}x${bbox.h} px`);
  }
  if (!(outline.widthMm > 0 && outline.heightMm > 0)) {
    throw new RangeError(
      `outline must have a positive size, got ${outline.widthMm}x${outline.heightMm} mm`,
    );
  }
}

/** Pixels per millimetre along each axis (they differ when the photo is not square-on). */
export function pxPerMm(bbox: PixelBox, outline: OutlineSize): { x: number; y: number } {
  check(bbox, outline);
  return { x: bbox.w / outline.widthMm, y: bbox.h / outline.heightMm };
}

/** Photo pixel -> part frame mm. */
export function pxToMm(
  px: number,
  py: number,
  bbox: PixelBox,
  outline: OutlineSize,
): { xMm: number; yMm: number } {
  const s = pxPerMm(bbox, outline);
  return { xMm: (px - bbox.x) / s.x, yMm: (py - bbox.y) / s.y };
}

/** Part frame mm -> photo pixel. */
export function mmToPx(
  xMm: number,
  yMm: number,
  bbox: PixelBox,
  outline: OutlineSize,
): { px: number; py: number } {
  const s = pxPerMm(bbox, outline);
  return { px: bbox.x + xMm * s.x, py: bbox.y + yMm * s.y };
}
