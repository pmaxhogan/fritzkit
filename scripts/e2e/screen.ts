/**
 * Screen helpers for the GUI demo: drive AutoHotkey v2 (scripts/e2e/do.ahk), take
 * DPI-aware screenshots (scripts/e2e/shot.ps1) and find things in them with sharp.
 * Windows only, local only.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const AHK_EXE =
  process.env.FRITZKIT_AHK ?? "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe";

export function ahkAvailable(): boolean {
  return existsSync(AHK_EXE);
}

/** Run one or more do.ahk commands (separate commands with ";"). Returns stdout lines. */
export async function ahk(args: string[], timeoutMs = 60_000): Promise<string[]> {
  const { stdout } = await execFileP(AHK_EXE, [join(here, "do.ahk"), ...args], {
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

/** Full-screen (or region) screenshot to a PNG; coordinates are physical pixels. */
export async function screenshot(
  out: string,
  region?: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(here, "shot.ps1"),
    "-Out",
    out,
  ];
  if (region)
    args.push(
      "-X",
      String(region.x),
      "-Y",
      String(region.y),
      "-W",
      String(region.w),
      "-H",
      String(region.h),
    );
  await execFileP("powershell", args, { timeout: 30_000, windowsHide: true });
  return out;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function raw(png: string) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

/**
 * Bounding box of pixels within tol of a colour, optionally limited to a region. Only
 * rows holding at least minRowCount matching pixels count, so thin UI chrome in the
 * same colour (tab bars, scrollbars) does not stretch the box.
 */
export async function findColorBbox(
  png: string,
  color: Rgb,
  tol = 14,
  region?: Bbox,
  minRowCount = 1,
): Promise<(Bbox & { count: number }) | undefined> {
  const { data, w, h, ch } = await raw(png);
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const x1 = region ? Math.min(w, region.x + region.w) : w;
  const y1 = region ? Math.min(h, region.y + region.h) : h;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    let rowMin = Infinity;
    let rowMax = -1;
    let rowCount = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      if (
        Math.abs(data[i]! - color.r) <= tol &&
        Math.abs(data[i + 1]! - color.g) <= tol &&
        Math.abs(data[i + 2]! - color.b) <= tol
      ) {
        rowCount++;
        if (x < rowMin) rowMin = x;
        if (x > rowMax) rowMax = x;
      }
    }
    if (rowCount < minRowCount) continue;
    count += rowCount;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count === 0) return undefined;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count };
}

/**
 * Locate the breadboard by its hole rows: rows of the region that hold at least
 * minDark dark pixels (holes are ~#383838) spanning a wide band. Returns the bbox of
 * all such rows. Grid lines and part artwork never reach minDark across a row.
 */
export async function findBreadboardByHoles(
  png: string,
  region: Bbox,
  minDark = 250,
): Promise<Bbox | undefined> {
  const { data, w, ch } = await raw(png);
  const x0 = region.x;
  const x1 = region.x + region.w;
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = region.y; y < region.y + region.h; y++) {
    let c = 0;
    let rMin = Infinity;
    let rMax = -1;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      if (data[i]! < 90 && data[i + 1]! < 90 && data[i + 2]! < 90) {
        c++;
        if (x < rMin) rMin = x;
        if (x > rMax) rMax = x;
      }
    }
    if (c < minDark) continue;
    if (rMin < minX) minX = rMin;
    if (rMax > maxX) maxX = rMax;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxY < 0) return undefined;
  return { x: minX - 10, y: minY - 10, w: maxX - minX + 20, h: maxY - minY + 20 };
}

export interface HoleGrid {
  /** y of each hole row (sorted), and x of each hole column (sorted) in the main area. */
  rows: number[];
  cols: number[];
}

/**
 * Find breadboard hole centres inside a region: dark pixels clustered into blobs.
 * Returns the row/column coordinates of the FIRST main-area row (the row with the most
 * holes), which is where the demo lands its wires.
 */
export async function findBreadboardHoles(png: string, region: Bbox): Promise<HoleGrid> {
  const { data, w, ch } = await raw(png);
  const dark = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    return data[i]! < 90 && data[i + 1]! < 90 && data[i + 2]! < 90;
  };
  // Row profile: for each y, count dark pixels; rows of holes form bands.
  const x0 = region.x;
  const x1 = region.x + region.w;
  const y0 = region.y;
  const y1 = region.y + region.h;
  const rowCount: number[] = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (dark(x, y)) c++;
    rowCount.push(c);
  }
  const bands: { y0: number; y1: number; max: number }[] = [];
  let inBand = false;
  let start = 0;
  let max = 0;
  rowCount.forEach((c, i) => {
    if (c > 20 && !inBand) {
      inBand = true;
      start = i;
      max = c;
    } else if (c > 20) {
      max = Math.max(max, c);
    } else if (inBand) {
      inBand = false;
      bands.push({ y0: y0 + start, y1: y0 + i - 1, max });
    }
  });
  if (bands.length === 0) throw new Error("no hole rows found in the breadboard region");
  // Hole rows: bands whose dark count is close to the maximum band (rails have fewer holes).
  const best = Math.max(...bands.map((b) => b.max));
  const mainRows = bands.filter((b) => b.max >= best * 0.9);
  const rows = mainRows.map((b) => Math.round((b.y0 + b.y1) / 2));
  const rowY = rows[0]!;
  // Column centres along that row.
  const cols: number[] = [];
  let runStart = -1;
  for (let x = x0; x <= x1; x++) {
    const d = x < x1 && dark(x, rowY);
    if (d && runStart < 0) runStart = x;
    if (!d && runStart >= 0) {
      cols.push(Math.round((runStart + x - 1) / 2));
      runStart = -1;
    }
  }
  return { rows, cols };
}
