/**
 * Shared fixtures for the breadboard and icon renderer tests (not a test file itself).
 */
import { identityFor } from "../src/core/identity.js";
import { resolvePart, type ResolvedPart } from "../src/core/resolve.js";
import { parsePartSpec, type PartSpecInput, type PinRole } from "../src/core/schema/part.js";
import type { PreparedPhoto, RenderContext } from "../src/core/compile/types.js";

export const DATE = "2026-10-31";

/** A real 3 x 2 RGBA PNG (generated once with sharp, frozen here for stable snapshots). */
export const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4IafxH4YZkDkAngMMT2iu3JAAAAAASUVORK5CYII=";

const row = (prefix: string, names: string[], roles: Record<string, PinRole> = {}) =>
  names.map((n) => ({ key: `${prefix}${n}`, name: n, role: roles[n] ?? ("io" as PinRole) }));

/** (1) 25.4 x 17.78 mm breakout: 1x7 male header on top, 1x7 female header on the bottom. */
export const breakoutInput: PartSpecInput = {
  slug: "test-breakout",
  title: "Test breakout",
  outline: {
    widthMm: 25.4,
    heightMm: 17.78,
    shape: "rounded",
    cornerRadiusMm: 1.5,
    holes: [
      { xMm: 2, yMm: 8.89, dMm: 2.2 },
      { xMm: 23.4, yMm: 8.89, dMm: 2.2 },
    ],
  },
  artwork: {
    boardColor: "#1B4F9C",
    silkscreen: [{ kind: "text", text: "BREAKOUT", xMm: 12.7, yMm: 8.89, sizeMm: 1.4 }],
    components: [{ kind: "rect", xMm: 9, yMm: 5, wMm: 7.4, hMm: 2.2, rxMm: 0.3 }],
  },
  headers: [
    {
      key: "top",
      kind: "male",
      cols: 7,
      xMm: 5.08,
      yMm: 1.27,
      pins: row("t", ["VIN", "GND", "3V3", "SCL", "SDA", "INT", "RST"], {
        VIN: "power",
        GND: "gnd",
        "3V3": "power",
      }),
    },
    {
      key: "bottom",
      kind: "female",
      cols: 7,
      xMm: 5.08,
      yMm: 16.51,
      pins: row("b", ["A0", "A1", "A2", "A3", "D4", "D5", "D6"]),
    },
  ],
};

/** (2) Free-standing pads (two with holes, one round, one oval) plus every silk item kind. */
export const padsInput: PartSpecInput = {
  slug: "test-pads",
  title: "Test pads",
  outline: { widthMm: 30, heightMm: 20, shape: "rect" },
  artwork: {
    silkscreen: [
      { kind: "text", text: "PADS", xMm: 15, yMm: 4, rotate: 0 },
      { kind: "text", text: "R90", xMm: 15, yMm: 12, rotate: -90, anchor: "start" },
      { kind: "line", x1Mm: 2, y1Mm: 18, x2Mm: 28, y2Mm: 18 },
    ],
    components: [
      { kind: "rect", xMm: 11, yMm: 7, wMm: 8, hMm: 6, color: "#222222", note: "SOIC-8" },
      { kind: "circle", xMm: 24, yMm: 4, dMm: 2, color: "#EEEEEE" },
    ],
  },
  pins: [
    {
      key: "vcc",
      name: "VCC",
      role: "power",
      xMm: 3,
      yMm: 5,
      pad: { shape: "rect", wMm: 2, hMm: 2, holeMm: 1 },
    },
    {
      key: "gnd",
      name: "GND",
      role: "gnd",
      xMm: 3,
      yMm: 15,
      pad: { shape: "rect", wMm: 2.5, hMm: 1.8, holeMm: 0.9 },
    },
    { key: "sig", name: "SIG", xMm: 27, yMm: 5, pad: { shape: "round", wMm: 2, hMm: 2 } },
    { key: "en", name: "EN", xMm: 27, yMm: 15, pad: { shape: "oval", wMm: 3, hMm: 1.6 } },
  ],
};

/** (3) An ESC with three motor leads on the left and two power leads on the right. */
export const escInput: PartSpecInput = {
  slug: "test-esc",
  title: "Test ESC",
  outline: { widthMm: 40, heightMm: 18, shape: "rounded", cornerRadiusMm: 2 },
  artwork: {
    boardColor: "#2B2B2B",
    silkscreen: [{ kind: "text", text: "30A ESC", xMm: 20, yMm: 9, sizeMm: 2 }],
  },
  leads: [
    { key: "m1", name: "M1", fromXMm: 0, fromYMm: 4, lengthMm: 20, color: "#1060C0" },
    { key: "m2", name: "M2", fromXMm: 0, fromYMm: 9, lengthMm: 20, color: "#1060C0" },
    { key: "m3", name: "M3", fromXMm: 0, fromYMm: 14, lengthMm: 20, color: "#1060C0" },
    {
      key: "vbat",
      name: "VBAT",
      role: "power",
      fromXMm: 40,
      fromYMm: 6,
      direction: "right",
      lengthMm: 25,
      color: "#D02020",
      gaugeMm: 2,
    },
    {
      key: "gnd",
      name: "GND",
      role: "gnd",
      fromXMm: 40,
      fromYMm: 12,
      direction: "right",
      lengthMm: 25,
      color: "#000000",
      gaugeMm: 2,
    },
  ],
};

/** (4) A XIAO-style castellated MCU board: two 1x7 castellated columns 600 mil apart. */
export const castellatedInput: PartSpecInput = {
  slug: "test-castellated",
  title: "Test castellated MCU",
  outline: { widthMm: 17.78, heightMm: 21, shape: "rounded", cornerRadiusMm: 1 },
  artwork: { boardColor: "#101010" },
  headers: [
    {
      key: "left",
      kind: "castellated",
      cols: 7,
      orientation: "vertical",
      xMm: 1.27,
      yMm: 2.88,
      pins: row("l", ["D0", "D1", "D2", "D3", "D4", "D5", "D6"]),
    },
    {
      key: "right",
      kind: "castellated",
      cols: 7,
      orientation: "vertical",
      xMm: 16.51,
      yMm: 2.88,
      pins: row("r", ["5V", "GND", "3V3", "D10", "D9", "D8", "D7"], {
        "5V": "power",
        GND: "gnd",
        "3V3": "power",
      }),
    },
  ],
};

export function build(input: PartSpecInput): { part: ResolvedPart; ctx: RenderContext } {
  const spec = parsePartSpec(input);
  return {
    part: resolvePart(spec),
    ctx: { identity: identityFor(spec), date: DATE, generator: "fritzkit-test" },
  };
}

export function photoFixture(opacity = 0.8): { part: ResolvedPart; ctx: RenderContext } {
  const { part, ctx } = build({
    ...breakoutInput,
    slug: "test-breakout-photo",
    artwork: { ...breakoutInput.artwork, style: "photo", photo: { src: "assets/top.png" } },
  });
  const png = new Uint8Array(Buffer.from(TINY_PNG_B64, "base64"));
  const photo: PreparedPhoto = { png, widthPx: 3, heightPx: 2, opacity };
  return { part, ctx: { ...ctx, photo } };
}

export const FIXTURES = {
  breakout: breakoutInput,
  pads: padsInput,
  esc: escInput,
  castellated: castellatedInput,
} as const;

/** Every attribute value of `name` in document order. */
export function attrValues(svg: string, name: string): string[] {
  const re = new RegExp(`\\s${name.replace(/[-:]/g, (c) => `\\${c}`)}="([^"]*)"`, "g");
  return [...svg.matchAll(re)].map((m) => m[1]!);
}

/** The full start tag of the element with this id. */
export function tagWithId(svg: string, id: string): string | undefined {
  return new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(svg)?.[0];
}

export function numAttr(tag: string, name: string): number {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  if (!m) throw new Error(`no ${name} in ${tag}`);
  return Number(m[1]);
}
