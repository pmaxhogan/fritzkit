import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  alphaBbox,
  backgroundMask,
  clampCrop,
  decodeRgba,
  detectBoardBbox,
  encodePng,
  keyBackground,
  keyRgba,
  maskBbox,
  ML_INSTALL_HINT,
  mmToPx,
  preparePhoto,
  pxPerMm,
  pxToMm,
  removeBackgroundMl,
  sniffMime,
  type PhotoSpec,
  type RgbaImage,
} from "../src/core/image/index.js";
import { parsePartSpec } from "../src/core/schema/part.js";

/** Known board rect inside the synthetic listing photo. */
const BOARD = { x: 120, y: 60, w: 360, h: 180 };
const GREEN = [0x1b, 0x7f, 0x3b] as const;

/** Deterministic LCG so the noise is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function setPx(img: RgbaImage, x: number, y: number, rgb: readonly number[]): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0]!;
  img.data[i + 1] = rgb[1]!;
  img.data[i + 2] = rgb[2]!;
  img.data[i + 3] = 255;
}

function fillRect(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: readonly number[],
) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(img, xx, yy, rgb);
}

/**
 * A listing-style photo: #F8F8F8 background with +-3 noise, a green rounded board at
 * `board`, white silkscreen strokes and a dark chip inside it.
 */
function syntheticPhoto(width = 600, height = 300, board = BOARD): RgbaImage {
  const img: RgbaImage = { data: new Uint8Array(width * height * 4), width, height };
  const rnd = lcg(42);
  for (let p = 0; p < width * height; p++) {
    const v = 0xf8 + Math.round(rnd() * 6 - 3);
    img.data.set([v, v, v, 255], p * 4);
  }
  const r = Math.round(Math.min(board.w, board.h) * 0.07);
  for (let y = board.y; y < board.y + board.h; y++) {
    for (let x = board.x; x < board.x + board.w; x++) {
      const cx = clampTo(x, board.x + r, board.x + board.w - 1 - r);
      const cy = clampTo(y, board.y + r, board.y + board.h - 1 - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(img, x, y, GREEN);
    }
  }
  const sx = (f: number) => board.x + Math.round(board.w * f);
  const sy = (f: number) => board.y + Math.round(board.h * f);
  // White "text" strokes and a white silkscreen box, all enclosed by green.
  fillRect(img, sx(0.1), sy(0.15), Math.round(board.w * 0.3), 3, [255, 255, 255]);
  fillRect(img, sx(0.1), sy(0.25), 3, Math.round(board.h * 0.2), [255, 255, 255]);
  fillRect(img, sx(0.6), sy(0.7), Math.round(board.w * 0.25), 4, [250, 250, 250]);
  // Dark chip.
  fillRect(
    img,
    sx(0.45),
    sy(0.35),
    Math.round(board.w * 0.15),
    Math.round(board.h * 0.3),
    [0x22, 0x22, 0x22],
  );
  return img;
}

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function alphaAt(img: RgbaImage, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3]!;
}

function photoSpec(photo: Record<string, unknown> = {}): PhotoSpec {
  return parsePartSpec({
    slug: "generic-breakout",
    title: "Generic breakout",
    outline: { widthMm: 40, heightMm: 20 },
    artwork: { style: "photo", photo: { src: "assets/top.png", ...photo } },
  });
}

const pngOf = (img: RgbaImage) => encodePng(img);

describe("detectBoardBbox", () => {
  it("finds the board rect within 2 px (PNG)", async () => {
    const box = await detectBoardBbox(await pngOf(syntheticPhoto()));
    expect(box.widthPx).toBe(600);
    expect(box.heightPx).toBe(300);
    expect(Math.abs(box.x - BOARD.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - BOARD.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.w - BOARD.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.h - BOARD.h)).toBeLessThanOrEqual(2);
  });

  it("finds the board rect within 2 px (lossy JPEG)", async () => {
    const img = syntheticPhoto();
    const jpg = await sharp(img.data, { raw: { width: 600, height: 300, channels: 4 } })
      .jpeg({ quality: 85 })
      .toBuffer();
    const box = await detectBoardBbox(new Uint8Array(jpg));
    expect(Math.abs(box.x - BOARD.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - BOARD.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.w - BOARD.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.h - BOARD.h)).toBeLessThanOrEqual(2);
  });

  it("ignores small dust specks in the background", async () => {
    const img = syntheticPhoto();
    fillRect(img, 20, 20, 3, 3, [40, 40, 40]);
    fillRect(img, 560, 270, 2, 2, [90, 60, 30]);
    const box = await detectBoardBbox(await pngOf(img));
    expect(box).toMatchObject({ x: BOARD.x, y: BOARD.y, w: BOARD.w, h: BOARD.h });
    // ...unless island removal is switched off.
    const raw = await detectBoardBbox(await pngOf(img), { minIslandPx: 0 });
    expect(raw.x).toBe(20);
    expect(raw.y).toBe(20);
  });

  it("keys a light grey background too", async () => {
    const img = syntheticPhoto();
    for (let p = 0; p < 600 * 300; p++) {
      if (img.data[p * 4] === GREEN[0] || img.data[p * 4]! < 0xc0) continue;
      const x = p % 600;
      const y = Math.floor(p / 600);
      const inBoard =
        x >= BOARD.x && x < BOARD.x + BOARD.w && y >= BOARD.y && y < BOARD.y + BOARD.h;
      if (!inBoard) img.data.set([0xd8, 0xd8, 0xd8], p * 4);
    }
    const box = await detectBoardBbox(await pngOf(img));
    expect(box).toMatchObject({ x: BOARD.x, y: BOARD.y, w: BOARD.w, h: BOARD.h });
  });

  it("does not key a board that fills the frame (no light seeds)", async () => {
    const img: RgbaImage = { data: new Uint8Array(50 * 40 * 4), width: 50, height: 40 };
    fillRect(img, 0, 0, 50, 40, GREEN);
    const box = await detectBoardBbox(await pngOf(img));
    expect(box).toEqual({ x: 0, y: 0, w: 50, h: 40, widthPx: 50, heightPx: 40 });
  });

  it("returns an empty box for a blank image", async () => {
    const img: RgbaImage = { data: new Uint8Array(20 * 10 * 4).fill(255), width: 20, height: 10 };
    const box = await detectBoardBbox(await pngOf(img));
    expect(box).toEqual({ x: 0, y: 0, w: 0, h: 0, widthPx: 20, heightPx: 10 });
  });

  it("rejects undecodable bytes", async () => {
    await expect(detectBoardBbox(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

describe("keyBackground", () => {
  it("makes the background transparent and keeps the board and its white strokes", async () => {
    const { png, bbox } = await keyBackground(await pngOf(syntheticPhoto()));
    expect(bbox).toEqual(BOARD);
    const out = await decodeRgba(png);
    expect(out.width).toBe(600);
    for (const [x, y] of [
      [0, 0],
      [599, 0],
      [0, 299],
      [599, 299],
      [300, 0],
      [BOARD.x - 1, BOARD.y + 50],
      // Just outside the rounded corner, inside the bbox: background too.
      [BOARD.x, BOARD.y],
    ] as const) {
      expect(alphaAt(out, x, y), `alpha at ${x},${y}`).toBe(0);
    }
    // Board body, the white strokes and the near-white stroke all stay opaque.
    const stroke = { x: BOARD.x + 36 + 5, y: BOARD.y + 27 + 1 };
    expect(
      out.data.slice((stroke.y * 600 + stroke.x) * 4, (stroke.y * 600 + stroke.x) * 4 + 4),
    ).toEqual(new Uint8Array([255, 255, 255, 255]));
    expect(alphaAt(out, BOARD.x + 216 + 10, BOARD.y + 126 + 1)).toBe(255);
    expect(alphaAt(out, BOARD.x + 180, BOARD.y + 90)).toBe(255);
    expect(alphaAt(out, BOARD.x + 5, BOARD.y + 90)).toBe(255);
  });

  it("is deterministic", async () => {
    const input = await pngOf(syntheticPhoto());
    const a = await keyBackground(input);
    const b = await keyBackground(input);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });

  it("tolerance 0 still keys the exact corner colour only", async () => {
    const img: RgbaImage = { data: new Uint8Array(30 * 30 * 4), width: 30, height: 30 };
    fillRect(img, 0, 0, 30, 30, [255, 255, 255]);
    fillRect(img, 10, 10, 10, 10, [254, 254, 254]);
    const { bbox } = await keyBackground(await pngOf(img), { tolerance: 0, minIslandPx: 0 });
    expect(bbox).toEqual({ x: 10, y: 10, w: 10, h: 10 });
  });

  it("feathers the edge without touching the background", async () => {
    const { png } = await keyBackground(await pngOf(syntheticPhoto()), { feather: 2 });
    const out = await decodeRgba(png);
    expect(alphaAt(out, 0, 0)).toBe(0);
    const edge = alphaAt(out, BOARD.x, BOARD.y + 90);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(alphaAt(out, BOARD.x + 180, BOARD.y + 90)).toBe(255);
  });

  it("treats already-transparent pixels as background", async () => {
    const img: RgbaImage = { data: new Uint8Array(40 * 20 * 4), width: 40, height: 20 };
    fillRect(img, 10, 5, 20, 10, GREEN);
    const { image, bbox } = await keyRgba(img);
    expect(bbox).toEqual({ x: 10, y: 5, w: 20, h: 10 });
    expect(alphaBbox(image)).toEqual(bbox);
  });
});

describe("fillNotches", () => {
  /** Synthetic photo with a white label (8 x 6 px) cut into the board's top edge. */
  function notched(): RgbaImage {
    const img = syntheticPhoto();
    fillRect(img, BOARD.x + 200, BOARD.y, 8, 6, [255, 255, 255]);
    return img;
  }
  const label = { x: BOARD.x + 203, y: BOARD.y + 1 };

  it("keys a white label touching the board edge by default", async () => {
    const { png } = await keyBackground(await pngOf(notched()));
    expect(alphaAt(await decodeRgba(png), label.x, label.y)).toBe(0);
  });

  it("keeps the label with fillNotches", async () => {
    const { png, bbox } = await keyBackground(await pngOf(notched()), { fillNotches: true });
    const out = await decodeRgba(png);
    const i = (label.y * 600 + label.x) * 4;
    expect(Array.from(out.data.slice(i, i + 4))).toEqual([255, 255, 255, 255]);
    expect(bbox).toEqual(BOARD);
  });

  it("does not spread outside the board bbox", async () => {
    const { png } = await keyBackground(await pngOf(notched()), { fillNotches: true });
    const out = await decodeRgba(png);
    let opaqueOutside = 0;
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 600; x++) {
        const inside =
          x >= BOARD.x && x < BOARD.x + BOARD.w && y >= BOARD.y && y < BOARD.y + BOARD.h;
        if (!inside && alphaAt(out, x, y) !== 0) opaqueOutside++;
      }
    }
    expect(opaqueOutside).toBe(0);
    // The rounded corner (convex) is not filled in.
    expect(alphaAt(out, BOARD.x, BOARD.y)).toBe(0);
  });

  it("flows through preparePhoto and handles a board at the image border", async () => {
    const out = await preparePhoto(await pngOf(notched()), photoSpec(), {
      key: { fillNotches: true },
    });
    expect(out).toMatchObject({ widthPx: BOARD.w, heightPx: BOARD.h });
    const full: RgbaImage = { data: new Uint8Array(50 * 40 * 4), width: 50, height: 40 };
    fillRect(full, 0, 0, 50, 40, GREEN);
    const box = await detectBoardBbox(await pngOf(full), { fillNotches: true });
    expect(box).toMatchObject({ x: 0, y: 0, w: 50, h: 40 });
    const blank: RgbaImage = { data: new Uint8Array(20 * 10 * 4).fill(255), width: 20, height: 10 };
    expect(await detectBoardBbox(await pngOf(blank), { fillNotches: true })).toMatchObject({
      w: 0,
      h: 0,
    });
  });
});

describe("mask helpers", () => {
  it("backgroundMask handles an empty image", () => {
    expect(backgroundMask({ data: new Uint8Array(0), width: 0, height: 0 }).length).toBe(0);
  });
  it("maskBbox returns an empty box when nothing is kept", () => {
    expect(maskBbox(4, 4, () => false)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(maskBbox(4, 4, (p) => p === 5)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
});

describe("preparePhoto", () => {
  it("keys and trims to the board, keeping the board's aspect", async () => {
    const out = await preparePhoto(await pngOf(syntheticPhoto()), photoSpec({ opacity: 0.8 }));
    expect(out).toBeDefined();
    expect(out!.widthPx).toBe(BOARD.w);
    expect(out!.heightPx).toBe(BOARD.h);
    expect(out!.opacity).toBe(0.8);
    const meta = await sharp(out!.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(BOARD.w);
  });

  it("crops then rotates 90 (dimensions swap)", async () => {
    const spec = photoSpec({ crop: [100, 40, 400, 220], rotate: 90, removeBackground: false });
    const out = await preparePhoto(await pngOf(syntheticPhoto()), spec);
    expect(out).toMatchObject({ widthPx: 220, heightPx: 400 });
  });

  it("rotates clockwise (sharp convention)", async () => {
    const img: RgbaImage = { data: new Uint8Array(60 * 30 * 4), width: 60, height: 30 };
    fillRect(img, 0, 0, 60, 30, GREEN);
    fillRect(img, 0, 0, 10, 10, [255, 0, 0]); // marker in the top-left corner
    const spec = (rotate: number) => photoSpec({ rotate, removeBackground: false });
    const red = (o: RgbaImage, x: number, y: number) => o.data[(y * o.width + x) * 4] === 255;
    const cw = await decodeRgba((await preparePhoto(await pngOf(img), spec(90)))!.png);
    expect([cw.width, cw.height]).toEqual([30, 60]);
    expect(red(cw, 25, 5)).toBe(true); // now top-right
    const ccw = await decodeRgba((await preparePhoto(await pngOf(img), spec(270)))!.png);
    expect(red(ccw, 5, 55)).toBe(true); // now bottom-left
  });

  it("rotates 90 then keys and trims to the rotated board", async () => {
    const out = await preparePhoto(await pngOf(syntheticPhoto()), photoSpec({ rotate: 90 }));
    expect(out).toMatchObject({ widthPx: BOARD.h, heightPx: BOARD.w });
  });

  it("clamps a crop that runs off the image", async () => {
    const spec = photoSpec({ crop: [500, 200, 400, 400], removeBackground: false });
    const out = await preparePhoto(await pngOf(syntheticPhoto()), spec);
    expect(out).toMatchObject({ widthPx: 100, heightPx: 100 });
  });

  it("ignores a crop that misses the image entirely", async () => {
    const spec = photoSpec({ crop: [900, 900, 10, 10], removeBackground: false });
    const out = await preparePhoto(await pngOf(syntheticPhoto()), spec);
    expect(out).toMatchObject({ widthPx: 600, heightPx: 300 });
  });

  it("removeBackground false keeps the alpha and the full frame", async () => {
    const img = syntheticPhoto();
    img.data[3] = 7; // a source alpha value that must survive untouched
    const out = await preparePhoto(await pngOf(img), photoSpec({ removeBackground: false }));
    expect(out).toMatchObject({ widthPx: 600, heightPx: 300 });
    const back = await decodeRgba(out!.png);
    expect(alphaAt(back, 0, 0)).toBe(7);
    expect(alphaAt(back, 599, 299)).toBe(255);
  });

  it("method none skips removal", async () => {
    const out = await preparePhoto(await pngOf(syntheticPhoto()), photoSpec(), { method: "none" });
    expect(out).toMatchObject({ widthPx: 600, heightPx: 300 });
  });

  it("caps the width at maxWidthPx keeping the aspect", async () => {
    const out = await preparePhoto(await pngOf(syntheticPhoto()), photoSpec(), {
      maxWidthPx: 180,
    });
    expect(out).toMatchObject({ widthPx: 180, heightPx: 90 });
  });

  it("defaults when the spec has no photo block", async () => {
    const out = await preparePhoto(await pngOf(syntheticPhoto()), { artwork: {} });
    expect(out).toMatchObject({ widthPx: BOARD.w, heightPx: BOARD.h, opacity: 1 });
  });

  it("is deterministic", async () => {
    const input = await pngOf(syntheticPhoto());
    const a = await preparePhoto(input, photoSpec({ rotate: 180 }));
    const b = await preparePhoto(input, photoSpec({ rotate: 180 }));
    expect(Buffer.from(a!.png).equals(Buffer.from(b!.png))).toBe(true);
  });

  it("returns undefined for undecodable bytes", async () => {
    expect(await preparePhoto(new Uint8Array([0, 1, 2, 3, 4, 5]), photoSpec())).toBeUndefined();
    expect(await preparePhoto(new Uint8Array(0), photoSpec())).toBeUndefined();
  });

  it("method ml uses the remover and trims to its alpha", async () => {
    const load = async () => ({
      removeBackground: async (input: Blob) => {
        const keyed = await keyBackground(new Uint8Array(await input.arrayBuffer()));
        return new Blob([new Uint8Array(keyed.png)], { type: "image/png" });
      },
    });
    const out = await preparePhoto(await pngOf(syntheticPhoto()), photoSpec(), {
      method: "ml",
      remover: { load },
    });
    expect(out).toMatchObject({ widthPx: BOARD.w, heightPx: BOARD.h });
  });

  it("method ml rejects with the install hint when the package is absent", async () => {
    await expect(
      preparePhoto(await pngOf(syntheticPhoto()), photoSpec(), { method: "ml" }),
    ).rejects.toThrow(/npm install @imgly\/background-removal-node/);
  });
});

describe("clampCrop", () => {
  it("clamps and rounds", () => {
    expect(clampCrop([-10, -5, 50.4, 30], 40, 20)).toEqual({ x: 0, y: 0, w: 40, h: 20 });
    expect(clampCrop([5, 5, 0, 10], 40, 20)).toBeUndefined();
  });
});

describe("calibration (bbox.ts)", () => {
  const bbox = { x: 120, y: 60, w: 360, h: 180 };
  const outline = { widthMm: 40, heightMm: 20 };

  it("pxPerMm per axis", () => {
    expect(pxPerMm(bbox, outline)).toEqual({ x: 9, y: 9 });
    expect(pxPerMm(bbox, { widthMm: 36, heightMm: 20 })).toEqual({ x: 10, y: 9 });
  });

  it("maps the bbox corners to the outline corners", () => {
    expect(pxToMm(120, 60, bbox, outline)).toEqual({ xMm: 0, yMm: 0 });
    expect(pxToMm(480, 240, bbox, outline)).toEqual({ xMm: 40, yMm: 20 });
    expect(mmToPx(0, 0, bbox, outline)).toEqual({ px: 120, py: 60 });
    expect(mmToPx(40, 20, bbox, outline)).toEqual({ px: 480, py: 240 });
  });

  it("round trips", () => {
    for (const [px, py] of [
      [133.7, 71.2],
      [479.5, 239.5],
      [50, 10],
    ] as const) {
      const mm = pxToMm(px, py, bbox, outline);
      const back = mmToPx(mm.xMm, mm.yMm, bbox, outline);
      expect(back.px).toBeCloseTo(px, 9);
      expect(back.py).toBeCloseTo(py, 9);
    }
  });

  it("rejects an empty bbox or outline", () => {
    expect(() => pxPerMm({ x: 0, y: 0, w: 0, h: 10 }, outline)).toThrow(RangeError);
    expect(() => pxToMm(1, 1, bbox, { widthMm: 0, heightMm: 1 })).toThrow(RangeError);
  });
});

describe("removeBackgroundMl", () => {
  it("throws the install hint when the module is absent", async () => {
    await expect(removeBackgroundMl(new Uint8Array([1]))).rejects.toThrow(ML_INSTALL_HINT);
    await expect(removeBackgroundMl(new Uint8Array([1]))).rejects.toThrow(/AGPL/);
  });

  it("wraps other load failures", async () => {
    const load = () => Promise.reject(new Error("boom"));
    await expect(removeBackgroundMl(new Uint8Array([1]), { load })).rejects.toThrow(
      /failed to load @imgly\/background-removal-node: Error: boom/,
    );
  });

  it("rejects a module without removeBackground", async () => {
    await expect(
      removeBackgroundMl(new Uint8Array([1]), { load: async () => ({}) }),
    ).rejects.toThrow(/unsupported version/);
  });

  it("calls the module (default export) and returns PNG bytes", async () => {
    let seenType = "";
    const load = async () => ({
      default: {
        removeBackground: async (input: Blob, config: unknown) => {
          seenType = input.type;
          expect(config).toEqual({ output: { format: "image/png" } });
          return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
        },
      },
    });
    const out = await removeBackgroundMl(new Uint8Array([0xff, 0xd8, 0xff]), { load });
    expect(Array.from(out)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(seenType).toBe("image/jpeg");
  });

  it("sniffMime", () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8]))).toBe("image/jpeg");
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    expect(sniffMime(webp)).toBe("image/webp");
    expect(sniffMime(new Uint8Array([0x89, 0x50]))).toBe("image/png");
  });
});
