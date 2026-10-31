/**
 * Breadboard view renderer (Fritzing house style).
 *
 * Coordinates: part frame mm -> canvas mm (toCanvas) -> mil (1 viewBox unit = 1 mil).
 * Draw order: board, photo, silkscreen + components, header bodies, leads, pads/pins,
 * labels, terminals. Attributes only (no CSS), font Noto Sans only, no tspans.
 *
 * Conventions:
 * - Silkscreen rect xMm/yMm is the TOP-LEFT corner; circle xMm/yMm is the centre; text
 *   xMm/yMm is the anchor point, yMm being the vertical CENTRE of the text.
 * - Free-standing pins: the pad element is connectorNpin; a 1 mil connectorNterminal
 *   sits at its centre.
 * - Headers: one cell per pin in the core header style; connectorNpin is the inner pin
 *   square (male), the hole (female) or the pad (castellated).
 * - Leads follow the bendable-leg SVGs of the core library (LED-5mm-red-leg.svg and
 *   friends): the connectorNpin element sits where the lead leaves the board (it
 *   doubles as the solder blob) and the connectorNleg line runs from there to the free
 *   end. Leads have no terminal.
 */
import { toCanvas, type ResolvedConnector, type ResolvedPart } from "../resolve.js";
import type { SilkItem } from "../schema/part.js";
import { el, svgRoot, text, wrapBase64, FONT_SANS, type Attrs } from "../svg.js";
import { fmt, mmToMil } from "../units.js";
import { darkenHex, scalePath } from "./breadboard-util.js";
import { ROLE_COLORS, STYLE } from "./style.js";
import type { RenderContext } from "./types.js";

export const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Breadboard-only colours and sizes not (yet) in STYLE. */
export const BB = {
  boardStrokeMil: 8,
  boardDarken: 0.3,
  mountHoleFill: "#000000",
  mountRingMil: 10,
  padStroke: STYLE.male.center,
  padStrokeMil: 6,
  padHole: "#1F1F1F",
  labelGapMm: 0.4,
  headerLabelScale: 0.8,
  minLabelPitchMm: 2,
  /** Average glyph advance of Noto Sans caps/digits, in em (for label fitting). */
  charWidthEm: 0.6,
  minHeaderLabelMil: 20,
} as const;

export interface ContentOptions {
  /** false strips every id attribute (icon view). */
  ids: boolean;
}

interface Pt {
  x: number;
  y: number;
}

interface Layers {
  board: string[];
  photo: string[];
  silk: string[];
  bodies: string[];
  leads: string[];
  pins: string[];
  labels: string[];
  terminals: string[];
}

/** Part-frame mm -> canvas mil. */
function cv(part: ResolvedPart, xMm: number, yMm: number): Pt {
  const c = toCanvas(part.frame, xMm, yMm);
  return { x: mmToMil(c.x), y: mmToMil(c.y) };
}

function pts(list: [number, number][]): string {
  return list.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
}

function labelColor(c: ResolvedConnector): string {
  return c.role === "power" || c.role === "gnd" ? ROLE_COLORS[c.role]! : STYLE.labelColor;
}

/** Baseline offset that vertically centres a text of the given size on a point. */
function centreBaseline(sizeMil: number): number {
  return sizeMil * 0.35;
}

function drawBoard(part: ResolvedPart, out: string[]): void {
  const o = part.spec.outline;
  const fill = part.spec.artwork.boardColor;
  const stroke = darkenHex(fill, BB.boardDarken);
  const sw = BB.boardStrokeMil;
  const tl = cv(part, 0, 0);
  const w = mmToMil(o.widthMm);
  const h = mmToMil(o.heightMm);
  if (o.shape === "custom" && o.pathMm) {
    out.push(
      el("g", { transform: `translate(${fmt(tl.x)} ${fmt(tl.y)})` }, [
        el("path", {
          d: scalePath(o.pathMm, mmToMil(1)),
          fill,
          stroke,
          "stroke-width": sw,
        }),
      ]),
    );
  } else {
    // Inset by half the stroke so the stroke stays inside the outline.
    const r = o.shape === "rounded" ? Math.max(0, mmToMil(o.cornerRadiusMm) - sw / 2) : 0;
    out.push(
      el("rect", {
        x: tl.x + sw / 2,
        y: tl.y + sw / 2,
        width: w - sw,
        height: h - sw,
        rx: r > 0 ? r : undefined,
        ry: r > 0 ? r : undefined,
        fill,
        stroke,
        "stroke-width": sw,
      }),
    );
  }
  for (const hole of o.holes) {
    const p = cv(part, hole.xMm, hole.yMm);
    out.push(
      el("circle", {
        cx: p.x,
        cy: p.y,
        r: mmToMil(hole.dMm / 2),
        fill: BB.mountHoleFill,
        stroke: STYLE.contactColor,
        "stroke-width": BB.mountRingMil,
      }),
    );
  }
}

function drawPhoto(part: ResolvedPart, ctx: RenderContext, out: string[]): void {
  if (!ctx.photo) return;
  const o = part.spec.outline;
  const tl = cv(part, 0, 0);
  const b64 = Buffer.from(ctx.photo.png).toString("base64");
  out.push(
    el("image", {
      x: tl.x,
      y: tl.y,
      width: mmToMil(o.widthMm),
      height: mmToMil(o.heightMm),
      preserveAspectRatio: "none",
      opacity: ctx.photo.opacity < 1 ? ctx.photo.opacity : undefined,
      "xlink:href": `data:image/png;base64,${wrapBase64(b64)}`,
    }),
  );
}

function drawSilk(part: ResolvedPart, item: SilkItem, out: string[]): void {
  switch (item.kind) {
    case "text": {
      const p = cv(part, item.xMm, item.yMm);
      const size = mmToMil(item.sizeMm);
      out.push(
        text(item.text, {
          x: p.x,
          y: p.y + centreBaseline(size),
          "font-family": FONT_SANS,
          "font-size": size,
          fill: item.color,
          "text-anchor": item.anchor,
          transform:
            item.rotate !== 0 ? `rotate(${fmt(item.rotate)} ${fmt(p.x)} ${fmt(p.y)})` : undefined,
        }),
      );
      return;
    }
    case "rect": {
      const p = cv(part, item.xMm, item.yMm);
      const rx = item.rxMm > 0 ? mmToMil(item.rxMm) : undefined;
      out.push(
        el("rect", {
          x: p.x,
          y: p.y,
          width: mmToMil(item.wMm),
          height: mmToMil(item.hMm),
          rx,
          ry: rx,
          fill: item.color,
        }),
      );
      return;
    }
    case "circle": {
      const p = cv(part, item.xMm, item.yMm);
      out.push(el("circle", { cx: p.x, cy: p.y, r: mmToMil(item.dMm / 2), fill: item.color }));
      return;
    }
    case "line": {
      const a = cv(part, item.x1Mm, item.y1Mm);
      const b = cv(part, item.x2Mm, item.y2Mm);
      out.push(
        el("line", {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: item.color,
          "stroke-width": mmToMil(item.widthMm),
          "stroke-linecap": "round",
        }),
      );
      return;
    }
  }
}

function terminal(c: ResolvedConnector, p: Pt, fill: string, ids: boolean): string {
  const s = STYLE.terminalSizeMil;
  return el("rect", {
    id: ids ? c.terminalId : undefined,
    x: p.x - s / 2,
    y: p.y - s / 2,
    width: s,
    height: s,
    fill,
    stroke: "none",
  });
}

function drawPin(part: ResolvedPart, c: ResolvedConnector, L: Layers, ids: boolean): void {
  const p = cv(part, c.xMm, c.yMm);
  const w = mmToMil(c.pad.wMm);
  const h = mmToMil(c.pad.hMm);
  const common: Attrs = {
    fill: STYLE.contactColor,
    stroke: BB.padStroke,
    "stroke-width": BB.padStrokeMil,
  };
  const id = ids ? c.svgId : undefined;
  if (c.pad.shape === "round") {
    L.pins.push(el("circle", { id, cx: p.x, cy: p.y, r: Math.min(w, h) / 2, ...common }));
  } else {
    const rx = c.pad.shape === "oval" ? Math.min(w, h) / 2 : undefined;
    L.pins.push(
      el("rect", {
        id,
        x: p.x - w / 2,
        y: p.y - h / 2,
        width: w,
        height: h,
        rx,
        ry: rx,
        ...common,
      }),
    );
  }
  const hole = c.pad.holeMm ?? 0;
  if (hole > 0) {
    L.pins.push(el("circle", { cx: p.x, cy: p.y, r: mmToMil(hole / 2), fill: BB.padHole }));
  }
  // Label beside the pad, pointing into the board (label "" hides it).
  if (c.label !== "") {
    const size = STYLE.labelFontSizeMil;
    const gap = mmToMil(BB.labelGapMm) + w / 2;
    const left = c.xMm < part.spec.outline.widthMm / 2;
    L.labels.push(
      text(c.label, {
        x: left ? p.x + gap : p.x - gap,
        y: p.y + centreBaseline(size),
        "font-family": FONT_SANS,
        "font-size": size,
        fill: labelColor(c),
        "text-anchor": left ? "start" : "end",
      }),
    );
  }
  L.terminals.push(terminal(c, p, hole > 0 ? BB.padHole : STYLE.contactColor, ids));
}

/** Fractions of a 0.1 in cell taken from the core header SVGs (7.199 / 7.178 units). */
const MALE = { chamfer: 1.563 / 7.199, a: 2.451 / 7.199, b: 3.009 / 7.199 };
const FEMALE = { o: 1.18 / 7.178, h: 2.202 / 7.178 };

/** Inner square corners [lo, hi] on both axes for a cell of side s at x0/y0 and inset f. */
function inset(x0: number, y0: number, s: number, f: number) {
  return { x: x0 + f * s, X: x0 + (1 - f) * s, y: y0 + f * s, Y: y0 + (1 - f) * s };
}

/** Four trapezoids framing the inner square `i` inside the outer square `o`. */
function bevels(
  o: ReturnType<typeof inset>,
  i: ReturnType<typeof inset>,
  colors: { top: string; right: string; bottom: string; left: string },
): string[] {
  return [
    el("polygon", {
      fill: colors.top,
      points: pts([
        [o.x, o.y],
        [i.x, i.y],
        [i.X, i.y],
        [o.X, o.y],
      ]),
    }),
    el("polygon", {
      fill: colors.right,
      points: pts([
        [o.X, o.y],
        [i.X, i.y],
        [i.X, i.Y],
        [o.X, o.Y],
      ]),
    }),
    el("polygon", {
      fill: colors.bottom,
      points: pts([
        [o.X, o.Y],
        [i.X, i.Y],
        [i.x, i.Y],
        [o.x, o.Y],
      ]),
    }),
    el("polygon", {
      fill: colors.left,
      points: pts([
        [o.x, o.Y],
        [i.x, i.Y],
        [i.x, i.y],
        [o.x, o.y],
      ]),
    }),
  ];
}

function drawMaleCell(c: ResolvedConnector, p: Pt, s: number, L: Layers, ids: boolean): void {
  const x0 = p.x - s / 2;
  const y0 = p.y - s / 2;
  const k = MALE.chamfer * s;
  L.bodies.push(
    el("polygon", {
      fill: STYLE.male.body,
      points: pts([
        [x0 + k, y0],
        [x0, y0 + k],
        [x0, y0 + s - k],
        [x0 + k, y0 + s],
        [x0 + s - k, y0 + s],
        [x0 + s, y0 + s - k],
        [x0 + s, y0 + k],
        [x0 + s - k, y0],
      ]),
    }),
  );
  const outer = inset(x0, y0, s, MALE.a);
  const inner = inset(x0, y0, s, MALE.b);
  L.pins.push(
    el("rect", {
      id: ids ? c.svgId : undefined,
      x: outer.x,
      y: outer.y,
      width: outer.X - outer.x,
      height: outer.Y - outer.y,
      fill: STYLE.male.pinSquare,
    }),
    el("rect", {
      x: inner.x,
      y: inner.y,
      width: inner.X - inner.x,
      height: inner.Y - inner.y,
      fill: STYLE.male.center,
    }),
    ...bevels(outer, inner, {
      top: STYLE.male.bevelTop,
      right: STYLE.male.bevelRight,
      bottom: STYLE.male.bevelBottom,
      left: STYLE.male.bevelLeft,
    }),
  );
  L.terminals.push(terminal(c, p, STYLE.male.center, ids));
}

function drawFemaleCell(c: ResolvedConnector, p: Pt, s: number, L: Layers, ids: boolean): void {
  const x0 = p.x - s / 2;
  const y0 = p.y - s / 2;
  const outer = inset(x0, y0, s, FEMALE.o);
  const hole = inset(x0, y0, s, FEMALE.h);
  L.bodies.push(
    el("rect", { x: x0, y: y0, width: s, height: s, fill: STYLE.female.body }),
    ...bevels(outer, hole, {
      top: STYLE.female.bevelTop,
      right: STYLE.female.bevelRight,
      bottom: STYLE.female.bevelBottom,
      left: STYLE.female.bevelLeft,
    }),
  );
  L.pins.push(
    el("rect", {
      id: ids ? c.svgId : undefined,
      x: hole.x,
      y: hole.y,
      width: hole.X - hole.x,
      height: hole.Y - hole.y,
      fill: STYLE.female.hole,
    }),
  );
  L.terminals.push(terminal(c, p, STYLE.female.hole, ids));
}

function drawCastellatedCell(c: ResolvedConnector, p: Pt, L: Layers, ids: boolean): void {
  const w = mmToMil(c.pad.wMm);
  const h = mmToMil(c.pad.hMm);
  L.pins.push(
    el("rect", {
      id: ids ? c.svgId : undefined,
      x: p.x - w / 2,
      y: p.y - h / 2,
      width: w,
      height: h,
      fill: STYLE.contactColor,
      stroke: BB.padStroke,
      "stroke-width": BB.padStrokeMil,
    }),
    el("rect", {
      x: p.x - w * 0.2,
      y: p.y - h * 0.2,
      width: w * 0.4,
      height: h * 0.4,
      fill: BB.padHole,
    }),
  );
  L.terminals.push(terminal(c, p, BB.padHole, ids));
}

/**
 * Font size for one header's labels. Horizontal rows put labels side by side one pitch
 * apart, so the size shrinks (for the whole header, never below BB.minHeaderLabelMil)
 * until the longest label fits in 90% of the pitch; vertical columns keep the default.
 */
export function headerLabelSize(
  group: ResolvedConnector[],
  orientation: "horizontal" | "vertical",
  pitchMil: number,
): number {
  const size = STYLE.labelFontSizeMil * BB.headerLabelScale;
  if (orientation !== "horizontal") return size;
  const longest = Math.max(...group.map((c) => c.label.length));
  const fit = (0.9 * pitchMil) / (longest * BB.charWidthEm);
  return Math.max(BB.minHeaderLabelMil, Math.min(size, Math.floor(fit)));
}

/**
 * Header pin labels sit on the inward side of the header (towards the board centre):
 * a horizontal row in the top half is labelled below, in the bottom half above; a
 * vertical column in the left half is labelled to its right, in the right half to its
 * left. Multi-row headers label only the innermost row. No labels below 2 mm pitch.
 */
function drawHeaderLabels(part: ResolvedPart, group: ResolvedConnector[], L: Layers): void {
  const ref = group[0]!.header!;
  if (ref.pitchMm < BB.minLabelPitchMm) return;
  const o = part.spec.outline;
  const xs = group.map((c) => c.xMm);
  const ys = group.map((c) => c.yMm);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const lastRow = Math.max(...group.map((c) => c.header!.row));
  const size = headerLabelSize(group, ref.orientation, mmToMil(ref.pitchMm));
  for (const c of group) {
    if (c.label === "") continue;
    const hr = c.header!;
    const halfMm =
      hr.kind === "castellated"
        ? ref.orientation === "horizontal"
          ? c.pad.hMm / 2
          : c.pad.wMm / 2
        : hr.pitchMm / 2;
    const p = cv(part, c.xMm, c.yMm);
    const off = mmToMil(halfMm + BB.labelGapMm);
    let a: Attrs;
    if (ref.orientation === "horizontal") {
      const top = cy < o.heightMm / 2;
      if (hr.row !== (top ? lastRow : 0)) continue;
      a = { x: p.x, y: top ? p.y + off + size * 0.75 : p.y - off, "text-anchor": "middle" };
    } else {
      const leftSide = cx < o.widthMm / 2;
      if (hr.row !== (leftSide ? lastRow : 0)) continue;
      a = {
        x: leftSide ? p.x + off : p.x - off,
        y: p.y + centreBaseline(size),
        "text-anchor": leftSide ? "start" : "end",
      };
    }
    L.labels.push(
      text(c.label, { ...a, "font-family": FONT_SANS, "font-size": size, fill: labelColor(c) }),
    );
  }
}

function drawLead(part: ResolvedPart, c: ResolvedConnector, L: Layers, ids: boolean): void {
  const lead = c.lead!;
  const from = cv(part, lead.fromXMm, lead.fromYMm);
  const to = cv(part, c.xMm, c.yMm);
  const gauge = mmToMil(lead.gaugeMm);
  L.leads.push(
    el("line", {
      id: ids ? c.legId : undefined,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      stroke: lead.color,
      "stroke-width": gauge,
      "stroke-linecap": "round",
    }),
  );
  L.pins.push(
    el("circle", {
      id: ids ? c.svgId : undefined,
      cx: from.x,
      cy: from.y,
      r: gauge / 2,
      fill: STYLE.contactColor,
    }),
  );
}

/**
 * The breadboard artwork as a list of elements, without the root svg or layer group.
 * Shared by the breadboard view (ids on) and the icon view (ids off) so the icon is
 * literally the same drawing, scaled.
 */
export function renderBreadboardContent(
  part: ResolvedPart,
  ctx: RenderContext,
  opts: ContentOptions,
): string[] {
  const L: Layers = {
    board: [],
    photo: [],
    silk: [],
    bodies: [],
    leads: [],
    pins: [],
    labels: [],
    terminals: [],
  };
  drawBoard(part, L.board);
  drawPhoto(part, ctx, L.photo);
  for (const item of part.spec.artwork.silkscreen) drawSilk(part, item, L.silk);
  for (const item of part.spec.artwork.components) drawSilk(part, item, L.silk);

  const headerGroups = new Map<string, ResolvedConnector[]>();
  for (const c of part.connectors) {
    if (c.source === "pin") {
      drawPin(part, c, L, opts.ids);
    } else if (c.source === "lead" && c.lead) {
      drawLead(part, c, L, opts.ids);
    } else if (c.header) {
      const p = cv(part, c.xMm, c.yMm);
      const s = mmToMil(c.header.pitchMm);
      if (c.header.kind === "male") drawMaleCell(c, p, s, L, opts.ids);
      else if (c.header.kind === "female") drawFemaleCell(c, p, s, L, opts.ids);
      else drawCastellatedCell(c, p, L, opts.ids);
      const g = headerGroups.get(c.header.key);
      if (g) g.push(c);
      else headerGroups.set(c.header.key, [c]);
    }
  }
  for (const group of headerGroups.values()) drawHeaderLabels(part, group, L);

  return [
    ...L.board,
    ...L.photo,
    ...L.silk,
    ...L.bodies,
    ...L.leads,
    ...L.pins,
    ...L.labels,
    ...L.terminals,
  ];
}

/** Root namespace attributes: xlink only when a photo is embedded. */
export function extraNamespaces(ctx: RenderContext): Attrs {
  return ctx.photo ? { "xmlns:xlink": XLINK_NS } : {};
}

/** Join elements one per line inside a group, indented two spaces. */
export function group(id: string | undefined, children: string[], extra: Attrs = {}): string {
  const inner = children.map((c) => `  ${c}\n`).join("");
  return el("g", { id, ...extra }, inner ? `\n${inner}` : "");
}

export function renderBreadboard(part: ResolvedPart, ctx: RenderContext): string {
  const body = renderBreadboardContent(part, ctx, { ids: true });
  return svgRoot(
    part.frame.widthMm,
    part.frame.heightMm,
    [group("breadboard", body)],
    extraNamespaces(ctx),
  );
}
