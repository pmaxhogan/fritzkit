/** Unit helpers. Fritzing SVG viewBoxes use 1 unit = 1 mil (0.001 in). */
export const MIL_PER_MM = 1000 / 25.4;
export const MM_PER_IN = 25.4;
/** Breadboard pitch in mils and mm. */
export const PITCH_MIL = 100;
export const PITCH_MM = 2.54;

export function mmToMil(mm: number): number {
  return mm * MIL_PER_MM;
}

export function milToMm(mil: number): number {
  return mil / MIL_PER_MM;
}

export function mmToIn(mm: number): number {
  return mm / MM_PER_IN;
}

export function inToMm(inches: number): number {
  return inches * MM_PER_IN;
}

/** Round to 3 decimals and format for SVG: no trailing zeros, no "-0". */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  const s = r.toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** mm -> mil, formatted for SVG attributes. */
export function mil(mm: number): string {
  return fmt(mmToMil(mm));
}

/** Minimum PCB drill and annular ring Fritzing's checker and fabs expect (mils). */
export const MIN_HOLE_MIL = 40;
export const MIN_RING_MIL = 20;

/**
 * Through-hole pad ring geometry in mils: Fritzing draws a THT pad as a circle whose
 * stroke is the annular ring. The hole never shrinks below MIN_HOLE_MIL and the ring
 * never below MIN_RING_MIL; the pad grows instead.
 */
export function ringGeometry(
  wMm: number,
  hMm: number,
  holeMm: number | undefined,
): { holeR: number; padR: number; r: number; strokeWidth: number } {
  const holeR = Math.max(mmToMil(holeMm ?? 0) / 2, MIN_HOLE_MIL / 2);
  const padR = Math.max(mmToMil(Math.min(wMm, hMm)) / 2, holeR + MIN_RING_MIL);
  return { holeR, padR, r: (holeR + padR) / 2, strokeWidth: padR - holeR };
}
