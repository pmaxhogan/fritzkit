/**
 * Minimal XML/SVG builder. Emits XML attributes (never CSS), escapes text and keeps
 * the output byte-deterministic so golden-file tests are stable.
 */
import { fmt, mmToIn } from "./units.js";

export type Attrs = Record<string, string | number | undefined>;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(typeof v === "number" ? fmt(v) : (v as string))}"`)
    .join("");
}

/** <name attrs>children</name>, or a self-closing tag when there are no children. */
export function el(name: string, a: Attrs = {}, children: string[] | string = []): string {
  const inner = Array.isArray(children) ? children.join("") : children;
  return inner ? `<${name}${attrs(a)}>${inner}</${name}>` : `<${name}${attrs(a)}/>`;
}

/** <text> with escaped content. Never emit <tspan> (Fritzing's renderer mishandles it). */
export function text(content: string, a: Attrs): string {
  return `<text${attrs(a)}>${esc(content)}</text>`;
}

export function formatIn(n: number): string {
  return (Math.round(n * 100000) / 100000).toString();
}

/**
 * SVG document root. width/height carry real units (inches) and the viewBox is in
 * mils (1 unit = 1 mil). Fritzing reads unitless sizes at 90 dpi, so never omit them.
 * canvasWMm/canvasHMm is the drawing size in mm; the viewBox is derived from it.
 */
export function svgRoot(
  canvasWMm: number,
  canvasHMm: number,
  children: string[],
  extraNs: Attrs = {},
): string {
  const wIn = mmToIn(canvasWMm);
  const hIn = mmToIn(canvasHMm);
  const vb = `0 0 ${fmt(wIn * 1000)} ${fmt(hIn * 1000)}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs(extraNs)} version="1.1" ` +
    `width="${formatIn(wIn)}in" height="${formatIn(hIn)}in" viewBox="${vb}">\n` +
    children.join("\n") +
    `\n</svg>\n`
  );
}

/** Wrap base64 at 60 characters per line (the form Fritzing itself emits for images). */
export function wrapBase64(b64: string): string {
  return b64.replace(/(.{60})/g, "$1\n");
}

/** Fonts registered in Fritzing 1.0.7; nothing else may appear in font-family. */
export const FONT_SANS = "Noto Sans";
export const FONT_MONO = "OCR-Fritzing-mono";
