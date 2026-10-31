/**
 * Turn a photo asset into the PreparedPhoto the breadboard renderer embeds
 * (spec decision D19). Pipeline: decode (EXIF orientation applied) -> crop -> rotate ->
 * background removal + trim to the board -> downscale -> PNG.
 *
 * The crop is in the pixels of the EXIF-oriented image (as a viewer shows it), applied
 * before rotation. `rotate` turns the cropped image CLOCKWISE by 90/180/270 degrees
 * (sharp's convention), so rotate: 90 moves the top-left corner to the top-right.
 *
 * The renderer stretches the PNG over the outline rect (preserveAspectRatio="none"), so
 * the trimmed board must map 1:1 onto the outline; we only cap the width.
 */
import sharp, { type Sharp } from "sharp";
import type { PreparedPhoto } from "../compile/types.js";
import type { Photo } from "../schema/part.js";
import {
  alphaBbox,
  clamp,
  decodeRgba,
  encodePng,
  keyRgba,
  type KeyOptions,
  type PixelBox,
  type RgbaImage,
} from "./key.js";
import { removeBackgroundMl, type RemoverOptions } from "./remover.js";

export type RemovalMethod = "key" | "ml" | "none";

export interface PrepareOptions {
  /** Cap on the output width in pixels (keeps the .fzpz small). Default 1600. */
  maxWidthPx?: number;
  /** Background removal method. Default "key" (sharp flood fill); "ml" needs an optional AGPL package. */
  method?: RemovalMethod;
  /** Options for the "key" method (tolerance, feather, minIslandPx, fillNotches). */
  key?: KeyOptions;
  /** Options for the "ml" method (tests inject a fake loader). */
  remover?: RemoverOptions;
}

/** The part of the spec preparePhoto reads (a full PartSpec satisfies it). */
export interface PhotoSpec {
  artwork: { photo?: Partial<Photo> | undefined };
}

export const DEFAULT_MAX_WIDTH_PX = 1600;

/** Clamp a [x, y, w, h] crop to the image; undefined when nothing is left. */
export function clampCrop(
  crop: readonly [number, number, number, number],
  width: number,
  height: number,
): PixelBox | undefined {
  const x0 = clamp(Math.round(crop[0]), 0, width);
  const y0 = clamp(Math.round(crop[1]), 0, height);
  const x1 = clamp(Math.round(crop[0] + crop[2]), 0, width);
  const y1 = clamp(Math.round(crop[1] + crop[3]), 0, height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function raw(img: RgbaImage): Sharp {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}

async function toRgba(s: Sharp): Promise<RgbaImage> {
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

async function extract(img: RgbaImage, box: PixelBox): Promise<RgbaImage> {
  if (box.x === 0 && box.y === 0 && box.w === img.width && box.h === img.height) return img;
  return toRgba(raw(img).extract({ left: box.x, top: box.y, width: box.w, height: box.h }));
}

/**
 * Prepare the photo for embedding. Returns undefined (never throws) when the image
 * cannot be decoded. Method "ml" may reject: with the install hint when the optional
 * package is missing, or with the package's own error when loading or running it fails,
 * so the caller can surface it.
 */
export async function preparePhoto(
  data: Uint8Array,
  spec: PhotoSpec,
  opts: PrepareOptions = {},
): Promise<PreparedPhoto | undefined> {
  const photo = spec.artwork.photo ?? {};
  const method = opts.method ?? "key";
  const maxWidth = Math.max(1, Math.floor(opts.maxWidthPx ?? DEFAULT_MAX_WIDTH_PX));

  let img: RgbaImage;
  try {
    img = await decodeRgba(data);
  } catch {
    return undefined;
  }
  if (img.width === 0 || img.height === 0) return undefined;

  if (photo.crop) {
    const box = clampCrop(photo.crop, img.width, img.height);
    if (box) img = await extract(img, box);
  }
  const rotate = photo.rotate ?? 0;
  if (rotate !== 0) img = await toRgba(raw(img).rotate(rotate));

  if (photo.removeBackground ?? true) {
    let trim: PixelBox | undefined;
    if (method === "key") {
      const keyed = await keyRgba(img, opts.key);
      img = keyed.image;
      trim = keyed.bbox;
    } else if (method === "ml") {
      const out = await removeBackgroundMl(await encodePng(img), opts.remover);
      img = await decodeRgba(out);
      trim = alphaBbox(img);
    }
    if (trim && trim.w > 0 && trim.h > 0) img = await extract(img, trim);
  }

  let s = raw(img);
  if (img.width > maxWidth) s = s.resize({ width: maxWidth, kernel: "lanczos3" });
  const { data: png, info } = await s
    .png({ compressionLevel: 9, palette: false })
    .toBuffer({ resolveWithObject: true });
  return {
    png: new Uint8Array(png.buffer, png.byteOffset, png.length),
    widthPx: info.width,
    heightPx: info.height,
    opacity: photo.opacity ?? 1,
  };
}
