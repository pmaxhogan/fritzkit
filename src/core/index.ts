/**
 * fritzkit core: pure functions that turn a part spec into Fritzing part files.
 * Everything here is offline and deterministic (spec decision D2).
 */
export const FRITZING_VERSION = "1.0.7";

/** 1 mm in mils (thousandths of an inch). Fritzing SVG viewBoxes use 1 unit = 1 mil. */
export const MIL_PER_MM = 1000 / 25.4;

export function mmToMil(mm: number): number {
  return mm * MIL_PER_MM;
}

export function mmToIn(mm: number): number {
  return mm / 25.4;
}
