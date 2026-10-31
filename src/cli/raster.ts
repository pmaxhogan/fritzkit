/** SVG -> PNG with sharp (loaded lazily so verbs that never rasterise start fast). */

export const DEFAULT_DPI = 300;

/** Rasterise an SVG whose root width/height are in inches at `dpi` pixels per inch. */
export async function svgToPng(svg: string, dpi: number = DEFAULT_DPI): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  const buf = await sharp(Buffer.from(svg, "utf8"), { density: dpi }).png().toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
