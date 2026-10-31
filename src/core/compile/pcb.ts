/**
 * pcb view renderer: a real footprint built from the resolved pad table (decision D7).
 *
 * Layout (copied from Fritzing's core THT parts, e.g. svg/core/pcb/dip_8_300mil.svg):
 *
 *   <g id="silkscreen">outline + mounting holes</g>
 *   <g id="copper1">
 *     <g id="copper0">THT pads</g>     (omitted when the part has no THT connector)
 *     SMD pads
 *   </g>
 *
 * A THT pad lives ONCE, inside copper0. Because copper0 is nested in copper1 the same
 * element is a descendant of both layer groups, so the fzp's copper0 and copper1 <p>
 * entries both resolve to it. Emitting a second copy would duplicate the id, which the
 * Fritzing part checker reports as an error.
 *
 * Canvas = part.frame (same size and offsets as the breadboard view, so the views line
 * up). viewBox units are mils.
 */
import { toCanvas, type ResolvedConnector, type ResolvedPart } from "../resolve.js";
import { el, svgRoot } from "../svg.js";
import { fmt, MIL_PER_MM, mmToMil } from "../units.js";
import { STYLE } from "./style.js";
import type { RenderContext } from "./types.js";

/** Annular ring geometry in mils. */
export interface Ring {
  /** Drill radius. */
  holeR: number;
  /** Outer copper radius. */
  padR: number;
  /** circle r (centre line of the stroke). */
  r: number;
  /** circle stroke-width (ring width). */
  strokeWidth: number;
}

/**
 * Ring geometry for a through-hole pad of the given copper size and drill (mm).
 * The drill is clamped to STYLE.pcb.minHoleMil and the ring width to
 * STYLE.pcb.minRingMil (the pad grows; the hole never shrinks).
 */
export function ringGeometry(wMm: number, hMm: number, holeMm: number | undefined): Ring {
  const holeR = Math.max(mmToMil(holeMm ?? 0) / 2, STYLE.pcb.minHoleMil / 2);
  const padR = Math.max(mmToMil(Math.min(wMm, hMm)) / 2, holeR + STYLE.pcb.minRingMil);
  return { holeR, padR, r: (holeR + padR) / 2, strokeWidth: padR - holeR };
}

/** Where a connector's copper sits, canvas mm. A lead is soldered at its board end. */
function padCentre(part: ResolvedPart, c: ResolvedConnector): { x: number; y: number } {
  if (c.lead) return toCanvas(part.frame, c.lead.fromXMm, c.lead.fromYMm);
  return toCanvas(part.frame, c.xMm, c.yMm);
}

function thtPad(part: ResolvedPart, c: ResolvedConnector): string[] {
  const { x, y } = padCentre(part, c);
  const cx = mmToMil(x);
  const cy = mmToMil(y);
  const pad = c.pad;
  const out: string[] = [];
  // resolve.ts already stores a lead's drill (0.6 x gauge) in pad.holeMm.
  const ring = ringGeometry(pad.wMm, pad.hMm, pad.holeMm);
  const longSide = Math.max(pad.wMm, pad.hMm);
  const shortSide = Math.min(pad.wMm, pad.hMm);
  if (!c.lead && pad.shape !== "round" && longSide > 1.3 * shortSide) {
    // Oblong solder pad: real copper under the ring (no id; the ring carries it).
    const w = mmToMil(pad.wMm);
    const h = mmToMil(pad.hMm);
    out.push(
      el("rect", {
        x: cx - w / 2,
        y: cy - h / 2,
        width: w,
        height: h,
        rx: pad.shape === "oval" ? Math.min(w, h) / 2 : undefined,
        fill: STYLE.pcb.copper,
        stroke: "none",
      }),
    );
  }
  out.push(
    el("circle", {
      id: c.svgId,
      cx,
      cy,
      r: ring.r,
      fill: "none",
      stroke: STYLE.pcb.copper,
      "stroke-width": ring.strokeWidth,
    }),
  );
  return out;
}

function smdPad(part: ResolvedPart, c: ResolvedConnector): string {
  const { x, y } = padCentre(part, c);
  const w = mmToMil(c.pad.wMm);
  const h = mmToMil(c.pad.hMm);
  const rounded = c.pad.shape === "oval" || c.pad.shape === "round";
  return el("rect", {
    id: c.svgId,
    x: mmToMil(x) - w / 2,
    y: mmToMil(y) - h / 2,
    width: w,
    height: h,
    rx: rounded ? Math.min(w, h) / 2 : undefined,
    fill: STYLE.pcb.copper,
    stroke: "none",
  });
}

function silkscreen(part: ResolvedPart): string[] {
  const o = part.spec.outline;
  const f = part.frame;
  const sw = STYLE.pcb.silkStrokeMil;
  const out: string[] = [];
  if (o.shape === "custom" && o.pathMm) {
    // The path is in part-frame mm: map it onto the canvas with translate + scale and
    // compensate the stroke so it renders at silkStrokeMil.
    out.push(
      el(
        "g",
        {
          transform: `translate(${fmt(mmToMil(f.offsetXMm))} ${fmt(mmToMil(f.offsetYMm))}) scale(${fmt(MIL_PER_MM)})`,
        },
        el("path", {
          d: o.pathMm,
          fill: "none",
          stroke: STYLE.pcb.silkscreen,
          "stroke-width": sw / MIL_PER_MM,
        }),
      ),
    );
  } else {
    // Stroke centred half a stroke inside the outline so it stays on the canvas edge.
    const x = mmToMil(f.offsetXMm) + sw / 2;
    const y = mmToMil(f.offsetYMm) + sw / 2;
    const w = Math.max(mmToMil(o.widthMm) - sw, 0);
    const h = Math.max(mmToMil(o.heightMm) - sw, 0);
    const r = o.shape === "rounded" ? Math.min(mmToMil(o.cornerRadiusMm), w / 2, h / 2) : 0;
    out.push(
      el("rect", {
        x,
        y,
        width: w,
        height: h,
        rx: r > 0 ? r : undefined,
        ry: r > 0 ? r : undefined,
        fill: "none",
        stroke: STYLE.pcb.silkscreen,
        "stroke-width": sw,
      }),
    );
  }
  for (const hole of o.holes) {
    const { x, y } = toCanvas(f, hole.xMm, hole.yMm);
    out.push(
      el("circle", {
        cx: mmToMil(x),
        cy: mmToMil(y),
        r: mmToMil(hole.dMm) / 2,
        fill: "none",
        stroke: STYLE.pcb.silkscreen,
        "stroke-width": sw,
      }),
    );
  }
  return out;
}

/** One child per line (readable golden files); empty stays empty so el() self-closes. */
function lines(children: string[]): string {
  return children.length ? `\n${children.join("\n")}\n` : "";
}

export function renderPcb(part: ResolvedPart, _ctx: RenderContext): string {
  const silk = part.spec.pcb.silkscreenOutline ? silkscreen(part) : [];
  const tht: string[] = [];
  const smd: string[] = [];
  for (const c of part.connectors) {
    if (c.tht) tht.push(...thtPad(part, c));
    else smd.push(smdPad(part, c));
  }
  const copper1: string[] = [];
  if (part.hasTht) copper1.push(el("g", { id: "copper0" }, lines(tht)));
  copper1.push(...smd);
  // An empty group would self-close; that is still a valid layer element.
  return svgRoot(part.frame.widthMm, part.frame.heightMm, [
    el("g", { id: "silkscreen" }, lines(silk)),
    el("g", { id: "copper1" }, lines(copper1)),
  ]);
}
