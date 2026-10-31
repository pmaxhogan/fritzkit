/**
 * Parse a KiCad footprint (.kicad_mod) into plain geometry.
 *
 * Supported headers: KiCad 5 legacy `(module NAME (layer F.Cu) (tedit ..) ...)` and
 * KiCad 6/7/8 `(footprint "NAME" (version ..) (generator ..) (layer "F.Cu") ...)`.
 *
 * Coordinate convention (assumed and applied everywhere): values are millimetres in
 * the footprint frame exactly as stored in the file, origin at the footprint anchor,
 * x to the right and y DOWN. KiCad's internal board coordinate system is y-down and
 * .kicad_mod files store it unflipped (pin 2 of a vertical header at (at 0 2.54) sits
 * BELOW pin 1), which is the same orientation as fritzkit's part frame, so no axis is
 * flipped anywhere. Pad rotation (the third `at` value, degrees) is kept as written,
 * normalised to [0, 360); only its effect on the pad's axis-aligned extent is used.
 *
 * Unknown list heads (attr, model, uuid, tstamp, embedded_fonts, fp_text user, ...)
 * are ignored. Graphics on any layer are collected; bounding boxes are computed from
 * the geometric centre lines (stroke width ignored) for Edge.Cuts, courtyard
 * (F/B.CrtYd), fab (F/B.Fab), silkscreen (F/B.SilkS) and the pads.
 */
import {
  find,
  findAll,
  KicadParseError,
  lineOf,
  num,
  parseSExpr,
  str,
  type SExpr,
} from "./sexpr.js";

export type KicadPadType = "thru_hole" | "smd" | "np_thru_hole" | "connect";
export type KicadPadShape = "circle" | "rect" | "roundrect" | "oval" | "custom" | "trapezoid";

const PAD_TYPES: readonly string[] = ["thru_hole", "smd", "np_thru_hole", "connect"];
const PAD_SHAPES: readonly string[] = [
  "circle",
  "rect",
  "roundrect",
  "oval",
  "custom",
  "trapezoid",
];

export interface KicadPad {
  /** Pad number as written ("" for unnumbered mechanical pads). */
  number: string;
  type: KicadPadType;
  shape: KicadPadShape;
  /** Pad centre, footprint frame, mm, y down. */
  x: number;
  y: number;
  /** Pad size before rotation. */
  w: number;
  h: number;
  /** Round drill diameter, or the SMALLER axis of an oval drill. */
  drill?: number;
  /** Full drill geometry when a drill is present. */
  drillShape?: "circle" | "oval";
  drillW?: number;
  drillH?: number;
  layers: string[];
  /** Degrees as written, normalised to [0, 360). */
  rotation: number;
  /** Source line of the pad list. */
  line: number;
}

export interface KicadPoint {
  x: number;
  y: number;
}

export interface KicadLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
  width: number;
}

export interface KicadRect extends KicadLine {
  filled: boolean;
}

export interface KicadCircle {
  cx: number;
  cy: number;
  r: number;
  layer: string;
  width: number;
}

export interface KicadArc {
  start: KicadPoint;
  end: KicadPoint;
  center: KicadPoint;
  radius: number;
  /** Signed sweep from start to end in degrees, measured with atan2 in the y-down frame. */
  sweepDeg: number;
  layer: string;
  width: number;
}

export interface KicadPoly {
  points: KicadPoint[];
  layer: string;
  width: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface KicadFootprint {
  name: string;
  /** "module" = KiCad 5 legacy header, "footprint" = KiCad 6+. */
  format: "module" | "footprint";
  version?: number;
  generator?: string;
  layer: string;
  descr?: string;
  tags?: string;
  reference?: string;
  value?: string;
  pads: KicadPad[];
  lines: KicadLine[];
  rects: KicadRect[];
  circles: KicadCircle[];
  arcs: KicadArc[];
  polys: KicadPoly[];
  bbox: {
    edge?: BBox;
    courtyard?: BBox;
    fab?: BBox;
    silk?: BBox;
    pads?: BBox;
  };
}

function point(list: SExpr[] | undefined, what: string, parent: SExpr[]): KicadPoint {
  const x = num(list, 1);
  const y = num(list, 2);
  if (x === undefined || y === undefined) {
    throw new KicadParseError(`missing or invalid (${what} x y)`, lineOf(list ?? parent));
  }
  return { x, y };
}

function layerOf(list: SExpr[]): string {
  return str(find(list, "layer"), 1) ?? "";
}

/** KiCad 5/6 `(width w)` or KiCad 7/8 `(stroke (width w) (type ..))`. */
function strokeWidth(list: SExpr[]): number {
  return num(find(list, "width"), 1) ?? num(find(find(list, "stroke") ?? [], "width"), 1) ?? 0;
}

function isFilled(list: SExpr[]): boolean {
  const f = str(find(list, "fill"), 1);
  return f === "solid" || f === "yes";
}

function normDeg(d: number): number {
  const r = ((d % 360) + 360) % 360;
  return Math.abs(r - 360) < 1e-9 ? 0 : r;
}

function angleOf(c: KicadPoint, p: KicadPoint): number {
  return normDeg((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
}

function parseArc(l: SExpr[]): KicadArc | undefined {
  const layer = layerOf(l);
  const width = strokeWidth(l);
  const midList = find(l, "mid");
  if (midList) {
    // KiCad 6+: three points on the arc.
    const a = point(find(l, "start"), "start", l);
    const m = point(midList, "mid", l);
    const b = point(find(l, "end"), "end", l);
    const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
    if (Math.abs(d) < 1e-12) return undefined; // collinear: not an arc
    const a2 = a.x * a.x + a.y * a.y;
    const m2 = m.x * m.x + m.y * m.y;
    const b2 = b.x * b.x + b.y * b.y;
    const center = {
      x: (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d,
      y: (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d,
    };
    const radius = Math.hypot(a.x - center.x, a.y - center.y);
    const as = angleOf(center, a);
    const ccw = normDeg(angleOf(center, b) - as);
    const toMid = normDeg(angleOf(center, m) - as);
    const sweepDeg = toMid <= ccw ? ccw : ccw - 360;
    return { start: a, end: b, center, radius, sweepDeg, layer, width };
  }
  // KiCad 5: (start = centre) (end = arc start point) (angle sweep).
  const center = point(find(l, "start"), "start", l);
  const start = point(find(l, "end"), "end", l);
  const sweepDeg = num(find(l, "angle"), 1) ?? 0;
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const a1 = ((angleOf(center, start) + sweepDeg) * Math.PI) / 180;
  const end = { x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1) };
  return { start, end, center, radius, sweepDeg, layer, width };
}

/** Points that bound an arc: both ends plus every axis extreme inside the sweep. */
function arcExtremes(a: KicadArc): KicadPoint[] {
  const pts = [a.start, a.end];
  const as = angleOf(a.center, a.start);
  for (const q of [0, 90, 180, 270]) {
    const off = a.sweepDeg >= 0 ? normDeg(q - as) : normDeg(as - q);
    if (off <= Math.abs(a.sweepDeg) + 1e-9) {
      pts.push({
        x: a.center.x + a.radius * Math.cos((q * Math.PI) / 180),
        y: a.center.y + a.radius * Math.sin((q * Math.PI) / 180),
      });
    }
  }
  return pts;
}

/**
 * Axis-aligned extent of a pad in the footprint frame. 0/180 keep w x h, 90/270 swap
 * them exactly; any other angle gives the bounding box of the rotated rectangle
 * (a circle pad keeps its size).
 */
export function padExtent(pad: Pick<KicadPad, "w" | "h" | "rotation" | "shape">): {
  w: number;
  h: number;
} {
  const r = normDeg(pad.rotation);
  if (r === 0 || r === 180) return { w: pad.w, h: pad.h };
  if (r === 90 || r === 270) return { w: pad.h, h: pad.w };
  if (pad.shape === "circle") return { w: pad.w, h: pad.h };
  const t = (r * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { w: pad.w * c + pad.h * s, h: pad.w * s + pad.h * c };
}

function parsePad(p: SExpr[]): KicadPad {
  const line = lineOf(p);
  const number = str(p, 1) ?? "";
  const type = str(p, 2);
  const shape = str(p, 3);
  if (type === undefined || !PAD_TYPES.includes(type)) {
    throw new KicadParseError(`pad "${number}": unknown pad type "${type ?? "(list)"}"`, line);
  }
  if (shape === undefined || !PAD_SHAPES.includes(shape)) {
    throw new KicadParseError(`pad "${number}": unknown pad shape "${shape ?? "(list)"}"`, line);
  }
  const at = find(p, "at");
  const pos = point(at, "at", p);
  const size = find(p, "size");
  const w = num(size, 1);
  const h = num(size, 2) ?? w;
  if (w === undefined || h === undefined) {
    throw new KicadParseError(`pad "${number}": missing (size w h)`, line);
  }
  const pad: KicadPad = {
    number,
    type: type as KicadPadType,
    shape: shape as KicadPadShape,
    x: pos.x,
    y: pos.y,
    w,
    h,
    layers: (find(p, "layers") ?? [])
      .slice(1)
      .flatMap((v) => (Array.isArray(v) ? [] : [String(v)])),
    rotation: normDeg(num(at, 3) ?? 0),
    line,
  };
  const drill = find(p, "drill");
  if (drill) {
    const oval = drill.includes("oval");
    const nums = drill.slice(1).filter((v): v is number => typeof v === "number");
    const dw = nums[0];
    if (dw !== undefined && dw > 0) {
      const dh = oval ? (nums[1] ?? dw) : dw;
      pad.drillShape = oval ? "oval" : "circle";
      pad.drillW = dw;
      pad.drillH = dh;
      pad.drill = Math.min(dw, dh);
    }
  }
  return pad;
}

function emptyBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function grow(b: BBox, x: number, y: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x);
  b.maxY = Math.max(b.maxY, y);
}

const LAYER_GROUPS: [keyof Omit<KicadFootprint["bbox"], "pads">, readonly string[]][] = [
  ["edge", ["Edge.Cuts"]],
  ["courtyard", ["F.CrtYd", "B.CrtYd", "F.Courtyard", "B.Courtyard"]],
  ["fab", ["F.Fab", "B.Fab"]],
  ["silk", ["F.SilkS", "B.SilkS", "F.Silkscreen", "B.Silkscreen"]],
];

/** Parse .kicad_mod text. Throws KicadParseError (with a line number) on bad input. */
export function parseKicadMod(text: string): KicadFootprint {
  const root = parseSExpr(text);
  const kind = root[0];
  if (kind !== "footprint" && kind !== "module") {
    const got = typeof kind === "string" || typeof kind === "number" ? String(kind) : "(...)";
    throw new KicadParseError(
      `not a KiCad footprint: expected (footprint ...) or (module ...), got (${got} ...)`,
      lineOf(root),
    );
  }
  const name = str(root, 1);
  if (name === undefined) throw new KicadParseError(`(${kind} ...) has no name`, lineOf(root));

  const fp: KicadFootprint = {
    name,
    format: kind,
    layer: layerOf(root),
    pads: [],
    lines: [],
    rects: [],
    circles: [],
    arcs: [],
    polys: [],
    bbox: {},
  };
  const version = num(find(root, "version"), 1);
  if (version !== undefined) fp.version = version;
  const generator = str(find(root, "generator"), 1);
  if (generator !== undefined) fp.generator = generator;
  const descr = str(find(root, "descr"), 1);
  if (descr !== undefined) fp.descr = descr;
  const tags = str(find(root, "tags"), 1);
  if (tags !== undefined) fp.tags = tags;

  for (const prop of findAll(root, "property")) {
    const k = str(prop, 1)?.toLowerCase();
    const v = str(prop, 2);
    if (k === "reference" && v !== undefined) fp.reference = v;
    else if (k === "value" && v !== undefined) fp.value = v;
  }
  for (const t of findAll(root, "fp_text")) {
    const k = str(t, 1);
    const v = str(t, 2);
    if (v === undefined) continue;
    if (k === "reference" && fp.reference === undefined) fp.reference = v;
    else if (k === "value" && fp.value === undefined) fp.value = v;
  }

  for (const p of findAll(root, "pad")) fp.pads.push(parsePad(p));

  // Per-layer points that bound the graphics.
  const pts: { layer: string; x: number; y: number }[] = [];
  const add = (layer: string, x: number, y: number) => pts.push({ layer, x, y });

  for (const l of findAll(root, "fp_line")) {
    const a = point(find(l, "start"), "start", l);
    const b = point(find(l, "end"), "end", l);
    const line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: layerOf(l), width: strokeWidth(l) };
    fp.lines.push(line);
    add(line.layer, a.x, a.y);
    add(line.layer, b.x, b.y);
  }
  for (const r of findAll(root, "fp_rect")) {
    const a = point(find(r, "start"), "start", r);
    const b = point(find(r, "end"), "end", r);
    const rect = {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      layer: layerOf(r),
      width: strokeWidth(r),
      filled: isFilled(r),
    };
    fp.rects.push(rect);
    add(rect.layer, a.x, a.y);
    add(rect.layer, b.x, b.y);
  }
  for (const c of findAll(root, "fp_circle")) {
    const ctr = point(find(c, "center"), "center", c);
    const e = point(find(c, "end"), "end", c);
    const circle = {
      cx: ctr.x,
      cy: ctr.y,
      r: Math.hypot(e.x - ctr.x, e.y - ctr.y),
      layer: layerOf(c),
      width: strokeWidth(c),
    };
    fp.circles.push(circle);
    add(circle.layer, ctr.x - circle.r, ctr.y - circle.r);
    add(circle.layer, ctr.x + circle.r, ctr.y + circle.r);
  }
  for (const a of findAll(root, "fp_arc")) {
    const arc = parseArc(a);
    if (!arc) continue;
    fp.arcs.push(arc);
    for (const q of arcExtremes(arc)) add(arc.layer, q.x, q.y);
  }
  for (const p of findAll(root, "fp_poly")) {
    const points = findAll(find(p, "pts") ?? [], "xy").map((xy) => point(xy, "xy", p));
    const poly = { points, layer: layerOf(p), width: strokeWidth(p) };
    fp.polys.push(poly);
    for (const q of points) add(poly.layer, q.x, q.y);
  }

  for (const [group, layers] of LAYER_GROUPS) {
    const b = emptyBox();
    for (const p of pts) if (layers.includes(p.layer)) grow(b, p.x, p.y);
    if (b.minX <= b.maxX) fp.bbox[group] = b;
  }
  if (fp.pads.length) {
    const b = emptyBox();
    for (const p of fp.pads) {
      const e = padExtent(p);
      grow(b, p.x - e.w / 2, p.y - e.h / 2);
      grow(b, p.x + e.w / 2, p.y + e.h / 2);
    }
    fp.bbox.pads = b;
  }
  return fp;
}
