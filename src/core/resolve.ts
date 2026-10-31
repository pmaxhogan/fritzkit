/**
 * Resolve a PartSpec into the flat connector list and canvas frame every renderer
 * and the fzp builder consume. Pure and deterministic.
 *
 * Connector ids (decision D12a): each pin key gets a connector number from
 * spec.pinIds; new keys are allocated the next free number and numbers are never
 * reused, so re-exporting a part keeps every surviving connector id stable and the
 * Inspector swap keeps wires attached.
 */
import { milToMm, PITCH_MM, ringGeometry } from "./units.js";
import type {
  ConnectorType,
  Header,
  Lead,
  PadGeometry,
  PartSpec,
  Pin,
  PinRole,
} from "./schema/part.js";

export type ConnectorSource = "pin" | "header" | "lead";

export interface ResolvedLead {
  color: string;
  lengthMm: number;
  /** Where the lead leaves the board, part frame. */
  fromXMm: number;
  fromYMm: number;
  direction: Lead["direction"];
  gaugeMm: number;
}

export interface ResolvedHeaderRef {
  key: string;
  kind: Header["kind"];
  row: number;
  col: number;
  pitchMm: number;
  orientation: Header["orientation"];
}

export interface ResolvedConnector {
  /** Connector number N. */
  id: number;
  /** fzp connector id: connectorN. */
  fzpId: string;
  /** SVG element ids. */
  svgId: string;
  terminalId: string;
  /** Only leads have a leg (bendable wire). A connector has EITHER a leg or a terminal. */
  legId?: string;
  key: string;
  name: string;
  label: string;
  description: string;
  role: PinRole;
  type: ConnectorType;
  source: ConnectorSource;
  /** Connector centre in the PART frame (mm). For a lead: its free end. */
  xMm: number;
  yMm: number;
  pad: PadGeometry;
  /** true = through hole (copper0 + copper1); false = SMD (copper1 only). */
  tht: boolean;
  header?: ResolvedHeaderRef;
  lead?: ResolvedLead;
}

export interface ResolvedBus {
  id: string;
  connectorIds: number[];
}

/**
 * Canvas frame. A part-frame point (x, y) lands on the canvas at
 * (x + offsetXMm, y + offsetYMm). The canvas is the SVG size; it grows past the
 * outline to hold leads and overhanging pins, and shifts so the first header pin
 * sits on a 100 mil multiple (parts with headers must seat in a breadboard).
 */
export interface Frame {
  offsetXMm: number;
  offsetYMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ResolvedPart {
  spec: PartSpec;
  /** Sorted by id ascending. */
  connectors: ResolvedConnector[];
  buses: ResolvedBus[];
  frame: Frame;
  /** True when at least one connector is through-hole (pcb view lists copper0). */
  hasTht: boolean;
  /** pinIds after allocation (may contain new keys compared to spec.pinIds). */
  pinIds: Record<string, number>;
  /** Keys that were newly allocated in this resolve (the caller should persist them). */
  newPinKeys: string[];
}

export class ResolveError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

const DEFAULT_HEADER_PAD: PadGeometry = { shape: "round", wMm: 1.6, hMm: 1.6, holeMm: 1.0 };
const DEFAULT_CASTELLATED_PAD: PadGeometry = { shape: "rect", wMm: 1.6, hMm: 2.4, smd: true };

/** Every connector key in spec order (pins, then headers row-major, then leads). */
export function listPinKeys(spec: PartSpec): string[] {
  const keys: string[] = [];
  for (const p of spec.pins) keys.push(p.key);
  for (const h of spec.headers) for (const p of h.pins) if (p) keys.push(p.key);
  for (const l of spec.leads) keys.push(l.key);
  return keys;
}

/**
 * Allocate connector numbers: keep existing pinIds entries, give each new key the
 * next free number (max + 1), never reuse a number. Keys that disappeared from the
 * spec keep their entry so the number stays reserved.
 */
export function allocatePinIds(spec: PartSpec): {
  pinIds: Record<string, number>;
  added: string[];
} {
  const pinIds: Record<string, number> = { ...spec.pinIds };
  const used = new Set<number>();
  for (const [k, v] of Object.entries(pinIds)) {
    if (used.has(v))
      throw new ResolveError(`pinIds: connector number ${v} used twice`, `pinIds.${k}`);
    used.add(v);
  }
  let next = used.size ? Math.max(...used) + 1 : 0;
  const added: string[] = [];
  const seen = new Set<string>();
  for (const k of listPinKeys(spec)) {
    if (seen.has(k)) throw new ResolveError(`duplicate pin key "${k}"`, `pins`);
    seen.add(k);
    if (pinIds[k] === undefined) {
      pinIds[k] = next++;
      added.push(k);
    }
  }
  return { pinIds, added };
}

function isTht(pad: PadGeometry, mode: PartSpec["pcb"]["mode"]): boolean {
  if (mode === "tht") return true;
  if (mode === "smd") return false;
  if (pad.smd) return false;
  return (pad.holeMm ?? 0) > 0;
}

function headerPinPos(
  h: Header,
  index: number,
): { xMm: number; yMm: number; row: number; col: number } {
  const row = Math.floor(index / h.cols);
  const col = index % h.cols;
  if (h.orientation === "horizontal") {
    return { xMm: h.xMm + col * h.pitchMm, yMm: h.yMm + row * h.pitchMm, row, col };
  }
  return { xMm: h.xMm + row * h.pitchMm, yMm: h.yMm + col * h.pitchMm, row, col };
}

export function leadEnd(l: Lead): { xMm: number; yMm: number } {
  switch (l.direction) {
    case "left":
      return { xMm: l.fromXMm - l.lengthMm, yMm: l.fromYMm };
    case "right":
      return { xMm: l.fromXMm + l.lengthMm, yMm: l.fromYMm };
    case "up":
      return { xMm: l.fromXMm, yMm: l.fromYMm - l.lengthMm };
    case "down":
      return { xMm: l.fromXMm, yMm: l.fromYMm + l.lengthMm };
  }
}

function makeConnector(
  id: number,
  base: {
    key: string;
    name: string;
    label?: string;
    description?: string;
    role: PinRole;
  },
  rest: Omit<
    ResolvedConnector,
    "id" | "fzpId" | "svgId" | "terminalId" | "key" | "name" | "label" | "description" | "role"
  >,
): ResolvedConnector {
  return {
    id,
    fzpId: `connector${id}`,
    svgId: `connector${id}pin`,
    terminalId: `connector${id}terminal`,
    key: base.key,
    name: base.name,
    label: base.label ?? base.name,
    description: base.description ?? base.name,
    role: base.role,
    ...rest,
  };
}

/** Axis-aligned bbox of everything that must fit on the canvas, part frame, mm. */
export function contentBounds(
  spec: PartSpec,
  connectors: ResolvedConnector[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = spec.outline.widthMm;
  let maxY = spec.outline.heightMm;
  const grow = (x: number, y: number, hw: number, hh: number) => {
    minX = Math.min(minX, x - hw);
    minY = Math.min(minY, y - hh);
    maxX = Math.max(maxX, x + hw);
    maxY = Math.max(maxY, y + hh);
  };
  for (const c of connectors) {
    // A male/female header cell is drawn a full pitch wide, wider than its copper pad.
    const cell = c.header && c.header.kind !== "castellated" ? c.header.pitchMm / 2 : 0;
    // The PCB ring may be larger than the spec pad once the minimum hole/ring apply.
    const ring = c.tht ? milToMm(ringGeometry(c.pad.wMm, c.pad.hMm, c.pad.holeMm).padR) : 0;
    const hw = Math.max(c.pad.wMm / 2, cell, ring);
    const hh = Math.max(c.pad.hMm / 2, cell, ring);
    if (c.lead) {
      // The lead's copper sits at the attachment point. The leg line runs PAST the
      // canvas on purpose: core legged parts (LEDs, battery packs) keep the viewBox to
      // the body and Fritzing draws the bendable leg itself from the legId line.
      grow(c.lead.fromXMm, c.lead.fromYMm, hw, hh);
    } else {
      grow(c.xMm, c.yMm, hw, hh);
    }
  }
  // Artwork that overhangs the outline (a USB connector drawn past the edge) must fit too.
  for (const item of [...spec.artwork.silkscreen, ...spec.artwork.components]) {
    if (item.kind === "rect")
      grow(item.xMm + item.wMm / 2, item.yMm + item.hMm / 2, item.wMm / 2, item.hMm / 2);
    else if (item.kind === "circle") grow(item.xMm, item.yMm, item.dMm / 2, item.dMm / 2);
    else if (item.kind === "line") {
      grow(item.x1Mm, item.y1Mm, item.widthMm / 2, item.widthMm / 2);
      grow(item.x2Mm, item.y2Mm, item.widthMm / 2, item.widthMm / 2);
    }
  }
  if (spec.outline.shape === "custom") {
    // A custom outline path cannot be inset, so leave room for half the silkscreen stroke.
    const pad = milToMm(4);
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
  }
  return { minX, minY, maxX, maxY };
}

const MIL = 25.4 / 1000;

function roundUpMil(mm: number): number {
  return Math.ceil(mm / MIL - 1e-6) * MIL;
}

/**
 * Compute the canvas frame. Offsets are chosen so (a) all content has non-negative
 * canvas coordinates and (b) if the part has headers, the first header pin lands on
 * a 100 mil multiple (the smallest extra shift that achieves it). The canvas size is
 * rounded up to whole mils so the viewBox has clean numbers.
 */
export function computeFrame(spec: PartSpec, connectors: ResolvedConnector[]): Frame {
  const b = contentBounds(spec, connectors);
  let offsetXMm = 0 - b.minX;
  let offsetYMm = 0 - b.minY;
  const first = connectors.find((c) => c.source === "header");
  if (first) {
    const snap = (v: number) => {
      const r = ((v % PITCH_MM) + PITCH_MM) % PITCH_MM; // remainder in [0, pitch)
      return r < 1e-6 || PITCH_MM - r < 1e-6 ? 0 : PITCH_MM - r;
    };
    offsetXMm += snap(first.xMm + offsetXMm);
    offsetYMm += snap(first.yMm + offsetYMm);
  }
  // Offsets stay exact (a header pin must land EXACTLY on a 100 mil multiple); only
  // the canvas size is rounded up to whole mils so the viewBox has clean numbers.
  return {
    offsetXMm,
    offsetYMm,
    widthMm: roundUpMil(b.maxX + offsetXMm),
    heightMm: roundUpMil(b.maxY + offsetYMm),
  };
}

export function resolvePart(spec: PartSpec): ResolvedPart {
  const { pinIds, added } = allocatePinIds(spec);
  const mode = spec.pcb.mode;
  const connectors: ResolvedConnector[] = [];

  for (const p of spec.pins as Pin[]) {
    connectors.push(
      makeConnector(pinIds[p.key]!, p, {
        type: p.type,
        source: "pin",
        xMm: p.xMm,
        yMm: p.yMm,
        pad: p.pad,
        tht: isTht(p.pad, mode),
      }),
    );
  }

  for (const h of spec.headers) {
    // Castellations are elongated ACROSS the board edge: for a vertical column the
    // default pad is rotated so its long side runs along x.
    const defaultPad =
      h.kind === "castellated"
        ? h.orientation === "vertical"
          ? {
              ...DEFAULT_CASTELLATED_PAD,
              wMm: DEFAULT_CASTELLATED_PAD.hMm,
              hMm: DEFAULT_CASTELLATED_PAD.wMm,
            }
          : DEFAULT_CASTELLATED_PAD
        : DEFAULT_HEADER_PAD;
    const pad = h.pad ?? defaultPad;
    const type: ConnectorType = h.kind === "male" ? "male" : h.kind === "female" ? "female" : "pad";
    h.pins.forEach((p, i) => {
      if (!p) return;
      const pos = headerPinPos(h, i);
      connectors.push(
        makeConnector(pinIds[p.key]!, p, {
          type,
          source: "header",
          xMm: pos.xMm,
          yMm: pos.yMm,
          pad,
          tht: isTht(pad, mode),
          header: {
            key: h.key,
            kind: h.kind,
            row: pos.row,
            col: pos.col,
            pitchMm: h.pitchMm,
            orientation: h.orientation,
          },
        }),
      );
    });
  }

  for (const l of spec.leads) {
    const end = leadEnd(l);
    const id = pinIds[l.key]!;
    // Fritzing reserves connector type "wire" for its own wire items (no core part uses
    // it); a bare lead end behaves like a male pin: it plugs into a breadboard hole.
    const c = makeConnector(id, l, {
      type: "male",
      source: "lead",
      xMm: end.xMm,
      yMm: end.yMm,
      pad: { shape: "round", wMm: l.gaugeMm, hMm: l.gaugeMm, holeMm: l.gaugeMm * 0.6 },
      tht: mode !== "smd",
      lead: {
        color: l.color,
        lengthMm: l.lengthMm,
        fromXMm: l.fromXMm,
        fromYMm: l.fromYMm,
        direction: l.direction,
        gaugeMm: l.gaugeMm,
      },
    });
    c.legId = `connector${id}leg`;
    connectors.push(c);
  }

  connectors.sort((a, b) => a.id - b.id);

  const byKey = new Map(connectors.map((c) => [c.key, c] as const));
  const busIds = new Set<string>();
  const buses: ResolvedBus[] = spec.buses.map((b, i) => {
    if (busIds.has(b.id)) throw new ResolveError(`duplicate bus id "${b.id}"`, `buses.${i}.id`);
    busIds.add(b.id);
    return {
      id: b.id,
      connectorIds: b.pins.map((k, j) => {
        const c = byKey.get(k);
        if (!c)
          throw new ResolveError(
            `bus "${b.id}" references unknown pin key "${k}"`,
            `buses.${i}.pins.${j}`,
          );
        return c.id;
      }),
    };
  });
  const seenInBus = new Map<number, string>();
  for (const b of buses) {
    for (const id of b.connectorIds) {
      const prev = seenInBus.get(id);
      if (prev && prev !== b.id) {
        throw new ResolveError(`connector${id} is in two buses ("${prev}" and "${b.id}")`, "buses");
      }
      seenInBus.set(id, b.id);
    }
  }

  return {
    spec,
    connectors,
    buses,
    frame: computeFrame(spec, connectors),
    hasTht: connectors.some((c) => c.tht),
    pinIds,
    newPinKeys: added,
  };
}

/** Part-frame mm -> canvas mm. */
export function toCanvas(frame: Frame, xMm: number, yMm: number): { x: number; y: number } {
  return { x: xMm + frame.offsetXMm, y: yMm + frame.offsetYMm };
}
