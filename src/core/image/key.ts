/**
 * Background keying for listing photos (spec decision D19, default "key" method).
 *
 * Amazon-style listing photos put the board on a near-white (#F7F7F7..#FFFFFF) or light
 * grey background. We flood fill from the four corners and the four edge midpoints
 * through pixels close to the seed colour and make them transparent. Pixels enclosed by
 * the board are never reached, so white silkscreen and white connectors stay opaque.
 *
 * Known limits:
 * 1. White features that TOUCH the board edge (labels, white headers, connectors) are
 *    connected to the background and get keyed, leaving notches. Set
 *    `fillNotches: true` to close them (morphological closing inside the board bbox).
 * 2. Soft drop shadows darker than `tolerance` are not reached by the fill and leave a
 *    grey fringe around the board. Use method "ml" or a tighter crop.
 * 3. A light, near-neutral board (white or silver PCB) that touches a corner or an edge
 *    midpoint seeds the fill itself and gets keyed. Crop so a margin of background
 *    surrounds the board, or use method "ml".
 */
import sharp from "sharp";

/** A pixel rectangle: x/y is the top-left pixel, w/h the size in pixels. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KeyOptions {
  /** Max per-channel distance (0-255) from the seed colour that still counts as background. Default 28. */
  tolerance?: number;
  /** Soften the cut edge over this many pixels (gaussian sigma). Default 0 (hard edge). */
  feather?: number;
  /**
   * Opaque islands smaller than this many pixels (dust, JPEG speckle in the background)
   * are keyed too. Default max(16, width*height/10000). 0 or 1 disables it.
   */
  minIslandPx?: number;
  /**
   * Close notches in the board outline (white features touching the board edge) with a
   * morphological closing of the opaque mask, square element of radius
   * round(0.025 * min(bbox w, h)) clamped to 2..24 px, applied only inside the board
   * bbox. Default false.
   */
  fillNotches?: boolean;
}

export interface KeyResult {
  /** RGBA PNG with the background made transparent. */
  png: Uint8Array;
  /** Bounding box of the remaining opaque pixels (the board); w = h = 0 if none. */
  bbox: PixelBox;
}

export interface BoardBbox extends PixelBox {
  /** Size of the analysed image. */
  widthPx: number;
  heightPx: number;
}

/** A decoded RGBA image (4 bytes per pixel, row-major). */
export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export const DEFAULT_TOLERANCE = 28;

/** Decode any sharp-supported image to straight RGBA, applying the EXIF orientation. */
export async function decodeRgba(data: Uint8Array): Promise<RgbaImage> {
  const { data: buf, info } = await sharp(data)
    .autoOrient()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
    width: info.width,
    height: info.height,
  };
}

/** Encode an RGBA image as PNG (deterministic settings). */
export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  const out = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * A seed may start a fill only if it looks like a listing background: light and nearly
 * neutral, or already transparent. A board that touches an edge (tight crop) therefore
 * does not get keyed from that edge.
 */
function isBackgroundSeed(d: Uint8Array, i: number, tolerance: number): boolean {
  const r = d[i]!;
  const g = d[i + 1]!;
  const b = d[i + 2]!;
  if (d[i + 3]! < 16) return true;
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  return lo >= 160 && hi - lo <= Math.max(2 * tolerance, 8);
}

/**
 * Background mask: 1 = background (reached by a fill from a corner/edge seed), 0 = kept.
 * Iterative stack fill with 4-connectivity; each pixel is pushed at most once.
 */
export function backgroundMask(img: RgbaImage, tolerance = DEFAULT_TOLERANCE): Uint8Array {
  const { data: d, width: w, height: h } = img;
  const n = w * h;
  const mask = new Uint8Array(n);
  if (n === 0) return mask;
  const stack = new Int32Array(n);
  const mx = Math.floor((w - 1) / 2);
  const my = Math.floor((h - 1) / 2);
  const seeds: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
    [mx, 0],
    [mx, h - 1],
    [0, my],
    [w - 1, my],
  ];
  for (const [sx, sy] of seeds) {
    const s = sy * w + sx;
    if (mask[s] === 1 || !isBackgroundSeed(d, s * 4, tolerance)) continue;
    const r0 = d[s * 4]!;
    const g0 = d[s * 4 + 1]!;
    const b0 = d[s * 4 + 2]!;
    const matches = (p: number): boolean => {
      const i = p * 4;
      if (d[i + 3]! < 16) return true;
      return (
        Math.abs(d[i]! - r0) <= tolerance &&
        Math.abs(d[i + 1]! - g0) <= tolerance &&
        Math.abs(d[i + 2]! - b0) <= tolerance
      );
    };
    let top = 0;
    mask[s] = 1;
    stack[top++] = s;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % w;
      if (x > 0 && mask[p - 1] === 0 && matches(p - 1)) {
        mask[p - 1] = 1;
        stack[top++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] === 0 && matches(p + 1)) {
        mask[p + 1] = 1;
        stack[top++] = p + 1;
      }
      if (p >= w && mask[p - w] === 0 && matches(p - w)) {
        mask[p - w] = 1;
        stack[top++] = p - w;
      }
      if (p + w < n && mask[p + w] === 0 && matches(p + w)) {
        mask[p + w] = 1;
        stack[top++] = p + w;
      }
    }
  }
  return mask;
}

/** Mark small isolated foreground islands (8-connected) as background, in place. */
function dropIslands(mask: Uint8Array, w: number, h: number, minIslandPx: number): void {
  if (minIslandPx <= 1) return;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (mask[start] !== 0 || seen[start] === 1) continue;
    let top = 0;
    let count = 0;
    members.length = 0;
    seen[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const p = stack[--top]!;
      count++;
      if (count < minIslandPx) members.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] === 0 && seen[q] === 0) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    if (count < minIslandPx) for (const p of members) mask[p] = 1;
  }
}

/** Bounding box of the pixels where `keep(p)` is true; w = h = 0 when there are none. */
export function maskBbox(w: number, h: number, keep: (p: number) => boolean): PixelBox {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!keep(row + x)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Bounding box of pixels with alpha >= 128. */
export function alphaBbox(img: RgbaImage): PixelBox {
  return maskBbox(img.width, img.height, (p) => img.data[p * 4 + 3]! >= 128);
}

/** Fill + island removal; returns the final background mask. */
function computeMask(img: RgbaImage, opts: KeyOptions): Uint8Array {
  const tolerance = clamp(opts.tolerance ?? DEFAULT_TOLERANCE, 0, 255);
  const mask = backgroundMask(img, tolerance);
  const minIsland = opts.minIslandPx ?? Math.max(16, Math.floor((img.width * img.height) / 10000));
  dropIslands(mask, img.width, img.height, minIsland);
  if (opts.fillNotches) fillNotches(mask, img);
  return mask;
}

/**
 * One 1-D pass of a binary square-element dilation ("max") or erosion ("min") over the
 * region [rx0, rx0 + rw) x [ry0, ry0 + rh) of a w x h image. Positions outside the image
 * count as `edge` (1 for erosion so the image border does not erode); positions inside
 * the image but outside the region count as 0 (nothing there is foreground).
 */
function morphPass(
  src: Uint8Array,
  region: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
  r: number,
  horizontal: boolean,
  mode: "max" | "min",
): Uint8Array {
  const { x: rx0, y: ry0, w: rw, h: rh } = region;
  const out = new Uint8Array(rw * rh);
  const lines = horizontal ? rh : rw;
  const len = horizontal ? rw : rh;
  const origin = horizontal ? rx0 : ry0;
  const extent = horizontal ? imgW : imgH;
  const win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const at = (i: number): number => {
      if (i >= 0 && i < len) return src[horizontal ? l * rw + i : i * rw + l]!;
      const g = origin + i;
      return mode === "min" && (g < 0 || g >= extent) ? 1 : 0;
    };
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < len; i++) {
      const v = mode === "max" ? (sum > 0 ? 1 : 0) : sum === win ? 1 : 0;
      out[horizontal ? l * rw + i : i * rw + l] = v;
      sum += at(i + r + 1) - at(i - r);
    }
  }
  return out;
}

/** Morphological closing of the opaque mask, applied inside the board bbox only (in place). */
function fillNotches(mask: Uint8Array, img: RgbaImage): void {
  const { width: w, height: h } = img;
  const box = boardBox(img, mask);
  if (box.w === 0 || box.h === 0) return;
  const r = clamp(Math.round(0.025 * Math.min(box.w, box.h)), 2, 24);
  const x0 = Math.max(0, box.x - r);
  const y0 = Math.max(0, box.y - r);
  const region = { x: x0, y: y0, w: Math.min(w, box.x + box.w + r) - x0, h: 0 };
  region.h = Math.min(h, box.y + box.h + r) - y0;
  const fg = new Uint8Array(region.w * region.h);
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      fg[y * region.w + x] = mask[(y0 + y) * w + x0 + x] === 0 ? 1 : 0;
    }
  }
  let m = morphPass(fg, region, w, h, r, true, "max");
  m = morphPass(m, region, w, h, r, false, "max");
  m = morphPass(m, region, w, h, r, true, "min");
  m = morphPass(m, region, w, h, r, false, "min");
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (m[(y - y0) * region.w + x - x0] === 1) mask[y * w + x] = 0;
    }
  }
}

function boardBox(img: RgbaImage, mask: Uint8Array): PixelBox {
  return maskBbox(img.width, img.height, (p) => mask[p] === 0 && img.data[p * 4 + 3]! >= 16);
}

/** Key the background of a decoded image. Returns a new RGBA image and the board bbox. */
export async function keyRgba(
  img: RgbaImage,
  opts: KeyOptions = {},
): Promise<{ image: RgbaImage; bbox: PixelBox }> {
  const { width: w, height: h } = img;
  const n = w * h;
  const mask = computeMask(img, opts);
  const out = new Uint8Array(img.data);
  for (let p = 0; p < n; p++) if (mask[p] === 1) out[p * 4 + 3] = 0;
  const feather = opts.feather ?? 0;
  if (feather > 0 && n > 0) {
    const alpha = new Uint8Array(n);
    for (let p = 0; p < n; p++) alpha[p] = mask[p] === 1 ? 0 : 255;
    const blurred = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
      .blur(Math.max(0.3, feather))
      .extractChannel(0) // sharp promotes 1-channel raw input to sRGB
      .raw()
      .toBuffer();
    // Only erode: the background stays transparent and the board edge fades out.
    for (let p = 0; p < n; p++) {
      const b = blurred[p]!;
      if (b < out[p * 4 + 3]!) out[p * 4 + 3] = b;
    }
  }
  return { image: { data: out, width: w, height: h }, bbox: boardBox(img, mask) };
}

/**
 * Make the near-white listing background transparent. `data` is any image sharp can
 * decode (PNG, JPEG, WebP, ...). Throws if it cannot be decoded.
 */
export async function keyBackground(data: Uint8Array, opts: KeyOptions = {}): Promise<KeyResult> {
  const img = await decodeRgba(data);
  const { image, bbox } = await keyRgba(img, opts);
  return { png: await encodePng(image), bbox };
}

/**
 * Detect the board's bounding box (same fill as keyBackground, no output image). The UI
 * uses this for calibration together with bbox.ts. Throws if `data` cannot be decoded.
 */
export async function detectBoardBbox(data: Uint8Array, opts: KeyOptions = {}): Promise<BoardBbox> {
  const img = await decodeRgba(data);
  const box = boardBox(img, computeMask(img, opts));
  return { ...box, widthPx: img.width, heightPx: img.height };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
