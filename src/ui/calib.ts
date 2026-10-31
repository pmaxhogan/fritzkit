/**
 * Browser-side photo calibration. Same math as src/core/image/bbox.ts (re-implemented so
 * the app never imports sharp): the board bbox in photo pixels maps onto the outline
 * (part frame mm, origin top-left, x right, y down).
 *
 * The compiler crops the SOURCE photo with artwork.photo.crop, then rotates it, then
 * stretches it over the outline. photoPlacement() reproduces that as one SVG transform
 * from source pixels to mm, so the canvas draws the untouched source image and the
 * markers in mm on top of it.
 */

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutlineSize {
  widthMm: number;
  heightMm: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/** Pixels per millimetre along each axis. */
export function pxPerMm(bbox: PixelBox, outline: OutlineSize): { x: number; y: number } {
  return { x: bbox.w / outline.widthMm, y: bbox.h / outline.heightMm };
}

/** Photo pixel -> part frame mm (unrotated photo). */
export function pxToMm(px: number, py: number, bbox: PixelBox, outline: OutlineSize) {
  const s = pxPerMm(bbox, outline);
  return { xMm: (px - bbox.x) / s.x, yMm: (py - bbox.y) / s.y };
}

/** Part frame mm -> photo pixel (unrotated photo). */
export function mmToPx(xMm: number, yMm: number, bbox: PixelBox, outline: OutlineSize) {
  const s = pxPerMm(bbox, outline);
  return { px: bbox.x + xMm * s.x, py: bbox.y + yMm * s.y };
}

/** Size of the crop after rotation. */
export function rotatedSize(w: number, h: number, rot: Rotation): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/** Crop-relative source pixel -> rotated-crop pixel (sharp rotates clockwise). */
export function rotatePx(x: number, y: number, cw: number, ch: number, rot: Rotation) {
  switch (rot) {
    case 0:
      return { x, y };
    case 90:
      return { x: ch - y, y: x };
    case 180:
      return { x: cw - x, y: ch - y };
    case 270:
      return { x: y, y: cw - x };
  }
}

/** Inverse of rotatePx. */
export function unrotatePx(x: number, y: number, cw: number, ch: number, rot: Rotation) {
  switch (rot) {
    case 0:
      return { x, y };
    case 90:
      return { x: y, y: ch - x };
    case 180:
      return { x: cw - x, y: ch - y };
    case 270:
      return { x: cw - y, y: x };
  }
}

export interface Placement {
  /** SVG transform (applied to an <image> drawn at 0,0 in source pixels). */
  transform: string;
  /** Source pixel -> part frame mm. */
  toMm: (px: number, py: number) => { xMm: number; yMm: number };
  /** Part frame mm -> source pixel. */
  toPx: (xMm: number, yMm: number) => { px: number; py: number };
  /** Rotated-crop pixels per mm. */
  scale: { x: number; y: number };
}

/** Where the source photo lands on the outline, given crop (source px) and rotation. */
export function photoPlacement(crop: PixelBox, rot: Rotation, outline: OutlineSize): Placement {
  const r = rotatedSize(crop.w, crop.h, rot);
  const box = { x: 0, y: 0, w: r.w, h: r.h };
  const scale = pxPerMm(box, outline);
  const t = {
    0: "",
    90: `translate(${crop.h} 0) rotate(90)`,
    180: `translate(${crop.w} ${crop.h}) rotate(180)`,
    270: `translate(0 ${crop.w}) rotate(270)`,
  }[rot];
  const transform =
    `scale(${1 / scale.x} ${1 / scale.y}) ${t} translate(${-crop.x} ${-crop.y})`.replace(
      /\s+/g,
      " ",
    );
  return {
    transform,
    scale,
    toMm: (px, py) => {
      const q = rotatePx(px - crop.x, py - crop.y, crop.w, crop.h, rot);
      return pxToMm(q.x, q.y, box, outline);
    },
    toPx: (xMm, yMm) => {
      const q = mmToPx(xMm, yMm, box, outline);
      const s = unrotatePx(q.px, q.py, crop.w, crop.h, rot);
      return { px: s.x + crop.x, py: s.y + crop.y };
    },
  };
}

/**
 * Two-point calibration: given two clicked source pixels and their real distance, the
 * crop that maps the outline at that scale, centred where the old crop was centred.
 */
export function cropFromScale(
  pxPerMmValue: number,
  centre: { x: number; y: number },
  rot: Rotation,
  outline: OutlineSize,
): PixelBox {
  const quarter = rot === 90 || rot === 270;
  const w = (quarter ? outline.heightMm : outline.widthMm) * pxPerMmValue;
  const h = (quarter ? outline.widthMm : outline.heightMm) * pxPerMmValue;
  return {
    x: Math.round(centre.x - w / 2),
    y: Math.round(centre.y - h / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** Distance between two points. */
export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const GRID_MM = 2.54;

/** Snap to the 0.1 in grid of the part frame. */
export function snapMm(v: number, grid = GRID_MM): number {
  return Math.round(v / grid) * grid;
}

/** Round to 0.01 mm so the JSON stays readable. */
export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
