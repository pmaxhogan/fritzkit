/**
 * schematic view renderer (decision D9, Fritzing graphic standard).
 *
 * An auto-generated rectangle symbol on the 0.1 in (100 mil) grid. Pins are grouped by
 * role onto the four sides of the body (DEFAULT_SIDES, overridable per role with
 * spec.schematic.sides); within a side they keep connector id order. Each pin is a
 * 100 mil line from the body edge outward whose OUTER end sits exactly on a grid
 * intersection, with a 1 mil terminal rect centred on that end (Fritzing snaps wires
 * to the terminal centre). Labels sit inside the body next to the pin.
 *
 * Every coordinate is in mils (the viewBox is in mils). Attributes only, no CSS.
 * part.frame is ignored: the schematic has its own layout. Leads are ordinary pins.
 */
import type { ResolvedConnector, ResolvedPart } from "../resolve.js";
import type { PinRole } from "../schema/part.js";
import { el, FONT_SANS, svgRoot, text } from "../svg.js";
import { milToMm } from "../units.js";
import { STYLE } from "./style.js";
import type { RenderContext } from "./types.js";

export type Side = "left" | "right" | "top" | "bottom";
const SIDE_ORDER: readonly Side[] = ["left", "right", "top", "bottom"];

/** Default side for each role. Nothing goes on top unless spec.schematic.sides says so. */
export const DEFAULT_SIDES: Readonly<Record<PinRole, Side>> = {
  power: "left",
  usb: "left",
  enable: "left",
  reset: "left",
  io: "right",
  analog: "right",
  pwm: "right",
  i2c: "right",
  spi: "right",
  uart: "right",
  clock: "right",
  other: "right",
  nc: "right",
  gnd: "bottom",
};

const S = STYLE.schematic;
const GRID = S.gridMil;
const PIN_LEN = S.pinLengthMil;
/** Gap between the body edge and the start of a pin label. */
const LABEL_INSET = 25;
/** Minimum horizontal gap between the longest left label and the longest right label. */
const LABEL_GAP = 60;
const MIN_W_CELLS = 6;
const MIN_H_CELLS = 3;
const TITLE_MAX_CHARS = 16;
/** Baseline shift (x font size) that vertically centres Noto Sans caps on a coordinate. */
const BASELINE_SHIFT = 0.35;

/**
 * Width estimate for a run of Noto Sans text: 0.6 x font size per character. Used to
 * size the body so labels never overflow; generous for a proportional font.
 */
export function estimateTextWidthMil(s: string, fontSizeMil: number): number {
  return s.length * fontSizeMil * 0.6;
}

const ceilGrid = (v: number) => Math.ceil(v / GRID - 1e-9) * GRID;

/**
 * Role -> side map after applying spec.schematic.sides. A role listed on a side goes
 * there (sides are applied in the order left, right, top, bottom, so a role listed on
 * two sides ends up on the later one); unlisted roles keep DEFAULT_SIDES.
 */
export function sideMap(
  overrides: Partial<Record<Side, PinRole[] | undefined>> | undefined,
): Record<PinRole, Side> {
  const map: Record<PinRole, Side> = { ...DEFAULT_SIDES };
  if (overrides) {
    for (const side of SIDE_ORDER) for (const role of overrides[side] ?? []) map[role] = side;
  }
  return map;
}

export interface SchematicPin {
  connector: ResolvedConnector;
  side: Side;
  /** Body-edge end of the pin line (mils, canvas). */
  x1: number;
  y1: number;
  /** Outer end of the pin line: always a grid intersection. */
  x2: number;
  y2: number;
}

export interface SchematicLayout {
  widthMil: number;
  heightMil: number;
  body: { x: number; y: number; w: number; h: number };
  title: { text: string; x: number; y: number };
  pins: SchematicPin[];
}

/**
 * Pick the title: spec.title if it fits maxWidth, else properties.mpn when it is short
 * (<= 16 chars), else the first 16 chars + "..." (only when that is actually shorter
 * than the title; a title of up to 19 chars is kept whole). needsWidth is the width the
 * chosen short form needs (the body grows to fit it); 0 when the full title fits.
 */
export function chooseTitle(
  title: string,
  mpn: string | undefined,
  maxWidth: number,
): { text: string; needsWidth: number } {
  const fs = S.titleFontSizeMil;
  if (estimateTextWidthMil(title, fs) <= maxWidth) return { text: title, needsWidth: 0 };
  let short: string;
  if (mpn && mpn.length <= TITLE_MAX_CHARS) short = mpn;
  else short = title.length > TITLE_MAX_CHARS + 3 ? `${title.slice(0, TITLE_MAX_CHARS)}...` : title;
  return { text: short, needsWidth: estimateTextWidthMil(short, fs) };
}

/** Compute the whole symbol geometry (mils). Pure; exported for tests. */
export function layoutSchematic(part: ResolvedPart): SchematicLayout {
  const map = sideMap(part.spec.schematic.sides);
  const bySide: Record<Side, ResolvedConnector[]> = { left: [], right: [], top: [], bottom: [] };
  for (const c of part.connectors) bySide[map[c.role]].push(c);
  const L = bySide.left.length;
  const R = bySide.right.length;
  const T = bySide.top.length;
  const B = bySide.bottom.length;

  const fs = S.fontSizeMil;
  const maxW = (cs: ResolvedConnector[]) =>
    cs.reduce((m, c) => Math.max(m, estimateTextWidthMil(c.label, fs)), 0);
  const maxL = maxW(bySide.left);
  const maxR = maxW(bySide.right);

  // Width: labels of both sides + gap, top/bottom pin counts, the minimum, then the title.
  let w = Math.max(
    MIN_W_CELLS * GRID,
    (T + 1) * GRID,
    (B + 1) * GRID,
    ceilGrid(
      (L ? LABEL_INSET + maxL : 0) + (R ? LABEL_INSET + maxR : 0) + (L && R ? LABEL_GAP : 0),
    ),
  );
  const title = chooseTitle(part.spec.title, part.spec.properties["mpn"], w - 2 * LABEL_INSET);
  w = Math.max(w, ceilGrid(title.needsWidth + 2 * LABEL_INSET));

  // Height: vertical bands so the rotated top/bottom labels (inside the body) and the
  // title never collide with the left/right label rows. With no top or bottom pins this
  // is the plain (rows + 1) cells.
  const topExt = T ? LABEL_INSET + maxW(bySide.top) : 0;
  const botExt = B ? LABEL_INSET + maxW(bySide.bottom) : 0;
  const tfs = S.titleFontSizeMil;
  const titleBaseline = topExt + 15 + Math.round(tfs * 0.75);
  const titleBottom = titleBaseline + Math.round(tfs * 0.25);
  const n = Math.max(L, R);
  let h: number;
  let firstRow: number = GRID;
  if (n > 0) {
    firstRow = Math.max(GRID, ceilGrid(titleBottom + 0.4 * fs + 4));
    const lastRow = firstRow + (n - 1) * GRID;
    const bottomGap = Math.max(GRID, ceilGrid(botExt + 0.6 * fs + 4));
    h = Math.max(MIN_H_CELLS * GRID, lastRow + bottomGap);
  } else {
    h = Math.max(MIN_H_CELLS * GRID, ceilGrid(titleBottom + 10 + botExt));
  }

  const bx = L ? PIN_LEN : 0;
  const by = T ? PIN_LEN : 0;
  const widthMil = bx + w + (R ? PIN_LEN : 0);
  const heightMil = by + h + (B ? PIN_LEN : 0);

  const pins: SchematicPin[] = [];
  bySide.left.forEach((c, i) => {
    const y = by + firstRow + i * GRID;
    pins.push({ connector: c, side: "left", x1: bx, y1: y, x2: bx - PIN_LEN, y2: y });
  });
  bySide.right.forEach((c, i) => {
    const y = by + firstRow + i * GRID;
    pins.push({ connector: c, side: "right", x1: bx + w, y1: y, x2: bx + w + PIN_LEN, y2: y });
  });
  bySide.top.forEach((c, i) => {
    const x = bx + (i + 1) * GRID;
    pins.push({ connector: c, side: "top", x1: x, y1: by, x2: x, y2: by - PIN_LEN });
  });
  bySide.bottom.forEach((c, i) => {
    const x = bx + (i + 1) * GRID;
    pins.push({ connector: c, side: "bottom", x1: x, y1: by + h, x2: x, y2: by + h + PIN_LEN });
  });

  return {
    widthMil,
    heightMil,
    body: { x: bx, y: by, w, h },
    title: { text: title.text, x: bx + w / 2, y: by + titleBaseline },
    pins,
  };
}

function pinLabel(p: SchematicPin): string {
  const fs = S.fontSizeMil;
  const shift = Math.round(fs * BASELINE_SHIFT * 10) / 10;
  const common = { "font-family": FONT_SANS, "font-size": fs, fill: S.body };
  const label = p.connector.label;
  switch (p.side) {
    case "left":
      return text(label, {
        x: p.x1 + LABEL_INSET,
        y: p.y1 + shift,
        ...common,
        "text-anchor": "start",
      });
    case "right":
      return text(label, {
        x: p.x1 - LABEL_INSET,
        y: p.y1 + shift,
        ...common,
        "text-anchor": "end",
      });
    case "bottom": {
      // rotate(-90): the text runs upward from just inside the bottom edge.
      const x = p.x1 + shift;
      const y = p.y1 - LABEL_INSET;
      return text(label, {
        x,
        y,
        ...common,
        "text-anchor": "start",
        transform: `rotate(-90 ${x} ${y})`,
      });
    }
    case "top": {
      // rotate(-90) with anchor end: the text ends just inside the top edge.
      const x = p.x1 + shift;
      const y = p.y1 + LABEL_INSET;
      return text(label, {
        x,
        y,
        ...common,
        "text-anchor": "end",
        transform: `rotate(-90 ${x} ${y})`,
      });
    }
  }
}

export function renderSchematic(part: ResolvedPart, _ctx: RenderContext): string {
  const lay = layoutSchematic(part);
  const t = STYLE.terminalSizeMil;
  // A body edge with no pins lies on the canvas edge; inset it by half the stroke so the
  // stroke is not clipped to half width (Fritzing core symbols do the same). Edges with
  // pins stay on the grid so the pins meet them.
  const hs = S.bodyStrokeMil / 2;
  const has = (side: Side) => lay.pins.some((p) => p.side === side);
  const x0 = lay.body.x + (has("left") ? 0 : hs);
  const y0 = lay.body.y + (has("top") ? 0 : hs);
  const x1 = lay.body.x + lay.body.w - (has("right") ? 0 : hs);
  const y1 = lay.body.y + lay.body.h - (has("bottom") ? 0 : hs);
  const items: string[] = [
    el("rect", {
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      fill: S.bodyFill,
      stroke: S.body,
      "stroke-width": S.bodyStrokeMil,
    }),
    text(lay.title.text, {
      x: lay.title.x,
      y: lay.title.y,
      "font-family": FONT_SANS,
      "font-size": S.titleFontSizeMil,
      fill: S.body,
      "text-anchor": "middle",
    }),
  ];
  for (const p of lay.pins) {
    const c = p.connector;
    items.push(
      el("line", {
        id: c.svgId,
        x1: p.x1,
        y1: p.y1,
        x2: p.x2,
        y2: p.y2,
        stroke: S.pin,
        "stroke-width": S.pinStrokeMil,
      }),
      el("rect", {
        id: c.terminalId,
        x: p.x2 - t / 2,
        y: p.y2 - t / 2,
        width: t,
        height: t,
        fill: S.pin,
        stroke: "none",
      }),
      pinLabel(p),
    );
  }
  const group = `  <g id="schematic">\n${items.map((l) => `    ${l}`).join("\n")}\n  </g>`;
  return svgRoot(milToMm(lay.widthMil), milToMm(lay.heightMil), [group]);
}
