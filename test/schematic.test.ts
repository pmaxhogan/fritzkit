import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildFzp } from "../src/core/compile/fzp.js";
import {
  chooseTitle,
  DEFAULT_SIDES,
  estimateTextWidthMil,
  layoutSchematic,
  renderSchematic,
  sideMap,
} from "../src/core/compile/schematic.js";
import { STYLE } from "../src/core/compile/style.js";
import type { RenderContext } from "../src/core/compile/types.js";
import { fzpzEntryNames, identityFor } from "../src/core/identity.js";
import { resolvePart, type ResolvedPart } from "../src/core/resolve.js";
import { parsePartSpec } from "../src/core/schema/part.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const DATE = "2026-10-31";

function build(input: unknown): { part: ResolvedPart; ctx: RenderContext; svg: string } {
  const spec = parsePartSpec(input);
  const part = resolvePart(spec);
  const ctx: RenderContext = { identity: identityFor(spec), date: DATE, generator: "fritzkit" };
  return { part, ctx, svg: renderSchematic(part, ctx) };
}

const pin = (key: string, name: string, role: string, i: number) => ({
  key,
  name,
  role,
  xMm: 2.54 + i * 2.54,
  yMm: 2,
});

const breakout = {
  slug: "generic-sensor-breakout",
  title: "Sensor Breakout",
  outline: { widthMm: 25, heightMm: 18 },
  pins: [
    pin("vcc", "VCC", "power", 0),
    pin("gnd", "GND", "gnd", 1),
    pin("sda", "SDA", "i2c", 2),
    pin("scl", "SCL", "i2c", 3),
    pin("int", "INT", "io", 4),
    pin("v33", "3V3", "power", 5),
    pin("gnd2", "GND2", "gnd", 6),
  ],
};

const mcuPins = (names: [string, string][]) =>
  names.map(([name, role]) => ({ key: name.replace(/\//g, "_"), name, role }));

const mcu = {
  slug: "xiao-style-mcu",
  title: "XIAO-style MCU board",
  properties: { mpn: "XS-MCU-14" },
  outline: { widthMm: 17.8, heightMm: 21 },
  headers: [
    {
      key: "l",
      kind: "castellated",
      cols: 7,
      xMm: 0.9,
      yMm: 2.8,
      orientation: "vertical",
      pins: mcuPins([
        ["D0/A0", "analog"],
        ["D1/A1", "analog"],
        ["D2/A2", "analog"],
        ["D3/A3", "analog"],
        ["D4/SDA", "i2c"],
        ["D5/SCL", "i2c"],
        ["D6/TX", "uart"],
      ]),
    },
    {
      key: "r",
      kind: "castellated",
      cols: 7,
      xMm: 16.9,
      yMm: 2.8,
      orientation: "vertical",
      pins: mcuPins([
        ["5V", "power"],
        ["GND", "gnd"],
        ["3V3", "power"],
        ["D10/MOSI", "spi"],
        ["D9/MISO", "spi"],
        ["D8/SCK", "spi"],
        ["D7/RX", "uart"],
      ]),
    },
  ],
};

const lead = (key: string, name: string, role: string, color: string, i: number) => ({
  key,
  name,
  role,
  color,
  fromXMm: 0,
  fromYMm: 3 + i * 3,
  lengthMm: 30,
});

const esc = {
  slug: "brushless-esc-30a",
  title: "Brushless ESC 30A",
  outline: { widthMm: 45, heightMm: 24 },
  leads: [
    lead("batp", "BAT+", "power", "#FF0000", 0),
    lead("batn", "BAT-", "gnd", "#000000", 1),
    lead("sig", "SIG", "pwm", "#FFFFFF", 2),
    lead("sgnd", "SIG GND", "gnd", "#333333", 3),
    lead("ma", "MOTOR A", "other", "#0000FF", 4),
    lead("mb", "MOTOR B", "other", "#0000FF", 5),
    lead("mc", "MOTOR C", "other", "#0000FF", 6),
  ],
};

const topI2c = { ...breakout, schematic: { sides: { top: ["i2c"] } } };

interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function attrNum(tag: string, name: string): number {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  if (!m) throw new Error(`no ${name} in ${tag}`);
  return Number(m[1]);
}

function pinLines(svg: string): Line[] {
  return [...svg.matchAll(/<line[^>]*\/>/g)].map(([tag]) => ({
    id: /id="([^"]*)"/.exec(tag)![1]!,
    x1: attrNum(tag, "x1"),
    y1: attrNum(tag, "y1"),
    x2: attrNum(tag, "x2"),
    y2: attrNum(tag, "y2"),
  }));
}

function bodyRect(svg: string): { x: number; y: number; w: number; h: number } {
  const tag = /<rect(?![^>]*id=)[^>]*\/>/.exec(svg)![0];
  return {
    x: attrNum(tag, "x"),
    y: attrNum(tag, "y"),
    w: attrNum(tag, "width"),
    h: attrNum(tag, "height"),
  };
}

/** The invariants every schematic must satisfy. */
function assertWellFormed(part: ResolvedPart, svg: string) {
  // root: inches = viewBox / 1000, all multiples of 100 mil
  const root = /<svg [^>]*>/.exec(svg)![0];
  const w = /width="([\d.]+)in"/.exec(root)![1]!;
  const h = /height="([\d.]+)in"/.exec(root)![1]!;
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(root)!;
  expect(Number(w) * 1000).toBeCloseTo(Number(vb[1]), 6);
  expect(Number(h) * 1000).toBeCloseTo(Number(vb[2]), 6);
  expect(Number(vb[1]) % 100).toBe(0);
  expect(Number(vb[2]) % 100).toBe(0);

  expect(svg.match(/<g /g)).toHaveLength(1);
  expect(svg).toContain('<g id="schematic">');
  expect(svg).not.toMatch(/style=|<tspan|class=|stroke-linecap/);
  for (const [, font] of svg.matchAll(/font-family="([^"]*)"/g)) {
    expect(["Noto Sans", "OCR-Fritzing-mono"]).toContain(font);
  }
  expect([...svg].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);

  const body = layoutSchematic(part).body;
  for (const v of [body.x, body.y, body.w, body.h]) expect(v % 100).toBe(0);
  expect(body.w).toBeGreaterThanOrEqual(600);
  expect(body.h).toBeGreaterThanOrEqual(300);
  // drawn rect: the grid body, inset by half the stroke on every side without pins so
  // the stroke stays inside the canvas
  const drawn = bodyRect(svg);
  const hs = STYLE.schematic.bodyStrokeMil / 2;
  const sides = new Set(layoutSchematic(part).pins.map((p) => p.side));
  expect(drawn.x).toBeCloseTo(body.x + (sides.has("left") ? 0 : hs), 6);
  expect(drawn.y).toBeCloseTo(body.y + (sides.has("top") ? 0 : hs), 6);
  expect(drawn.x + drawn.w).toBeCloseTo(body.x + body.w - (sides.has("right") ? 0 : hs), 6);
  expect(drawn.y + drawn.h).toBeCloseTo(body.y + body.h - (sides.has("bottom") ? 0 : hs), 6);
  expect(drawn.x - hs).toBeGreaterThanOrEqual(-1e-6);
  expect(drawn.y - hs).toBeGreaterThanOrEqual(-1e-6);
  expect(drawn.x + drawn.w + hs).toBeLessThanOrEqual(Number(vb[1]) + 1e-6);
  expect(drawn.y + drawn.h + hs).toBeLessThanOrEqual(Number(vb[2]) + 1e-6);

  const lines = pinLines(svg);
  expect(lines).toHaveLength(part.connectors.length);
  for (const c of part.connectors) {
    expect(svg.split(`id="${c.svgId}"`)).toHaveLength(2);
    expect(svg.split(`id="${c.terminalId}"`)).toHaveLength(2);
    const l = lines.find((x) => x.id === c.svgId)!;
    expect(l.x2 % 100).toBe(0);
    expect(l.y2 % 100).toBe(0);
    expect(Math.abs(l.x2 - l.x1) + Math.abs(l.y2 - l.y1)).toBe(100);
    // inner end on a body edge
    const onEdge =
      ((l.x1 === body.x || l.x1 === body.x + body.w) && l.y1 > body.y && l.y1 < body.y + body.h) ||
      ((l.y1 === body.y || l.y1 === body.y + body.h) && l.x1 > body.x && l.x1 < body.x + body.w);
    expect(onEdge, c.svgId).toBe(true);
    // terminal: 1 mil rect centred on the outer end
    const term = new RegExp(`<rect id="${c.terminalId}"[^>]*/>`).exec(svg)![0];
    expect(attrNum(term, "x") + 0.5).toBe(l.x2);
    expect(attrNum(term, "y") + 0.5).toBe(l.y2);
    expect(attrNum(term, "width")).toBe(1);
    expect(term).toContain('fill="#555555"');
  }
}

const sidesOf = (part: ResolvedPart) => {
  const out: Record<string, string[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of layoutSchematic(part).pins) out[p.side]!.push(p.connector.label);
  return out;
};

describe("estimateTextWidthMil", () => {
  it("is 0.6 x font size per character", () => {
    expect(estimateTextWidthMil("ABCDE", 50)).toBe(150);
    expect(estimateTextWidthMil("", 50)).toBe(0);
  });
});

describe("sideMap", () => {
  it("returns the defaults without overrides", () => {
    expect(sideMap(undefined)).toEqual(DEFAULT_SIDES);
    expect(sideMap({}).gnd).toBe("bottom");
  });
  it("moves listed roles and keeps the rest", () => {
    const m = sideMap({ top: ["i2c", "power"], left: ["gnd"] });
    expect(m.i2c).toBe("top");
    expect(m.power).toBe("top");
    expect(m.gnd).toBe("left");
    expect(m.io).toBe("right");
    expect(m.usb).toBe("left");
  });
});

describe("chooseTitle", () => {
  it("keeps a title that fits", () => {
    expect(chooseTitle("Short", undefined, 500)).toEqual({ text: "Short", needsWidth: 0 });
  });
  it("prefers a short mpn, else truncates to 16 chars + ...", () => {
    expect(chooseTitle("A very long product title", "MPN-1", 100).text).toBe("MPN-1");
    const t = chooseTitle("A very long product title", "AN-EXTREMELY-LONG-MPN", 100);
    expect(t.text).toBe("A very long prod...");
    expect(t.needsWidth).toBe(estimateTextWidthMil(t.text, STYLE.schematic.titleFontSizeMil));
    expect(chooseTitle("WWWWWW", undefined, 10).text).toBe("WWWWWW");
    // truncating would not shorten a title of up to 16 + 3 chars: keep it whole
    expect(chooseTitle("Brushless ESC 30A", undefined, 100).text).toBe("Brushless ESC 30A");
  });
});

describe("renderSchematic", () => {
  it("lays out a 7-pin breakout: 2 left, 3 right, 2 bottom", async () => {
    const { part, ctx, svg } = build(breakout);
    expect(sidesOf(part)).toEqual({
      left: ["VCC", "3V3"],
      right: ["SDA", "SCL", "INT"],
      top: [],
      bottom: ["GND", "GND2"],
    });
    assertWellFormed(part, svg);
    expect(svg).toContain(">Sensor Breakout</text>");
    expect(svg).toContain('stroke="#000000" stroke-width="9.7"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(renderSchematic(part, ctx)).toBe(svg);
    await expect(svg).toMatchFileSnapshot("__snapshots__/schematic-breakout.svg");
  });

  it("grows the body for a 14-pin castellated MCU board", async () => {
    const { part, svg } = build(mcu);
    const s = sidesOf(part);
    expect(s.left).toEqual(["5V", "3V3"]);
    expect(s.right).toHaveLength(11);
    expect(s.bottom).toEqual(["GND"]);
    assertWellFormed(part, svg);
    const body = bodyRect(svg);
    expect(body.h).toBeGreaterThanOrEqual(1200);
    // the full title does not fit the body: the short mpn is used
    expect(svg).toContain(">XS-MCU-14</text>");
    await expect(svg).toMatchFileSnapshot("__snapshots__/schematic-mcu.svg");
  });

  it("treats wire leads as ordinary pins (ESC)", async () => {
    const { part, svg } = build(esc);
    expect(sidesOf(part)).toEqual({
      left: ["BAT+"],
      right: ["SIG", "MOTOR A", "MOTOR B", "MOTOR C"],
      top: [],
      bottom: ["BAT-", "SIG GND"],
    });
    assertWellFormed(part, svg);
    expect(svg).not.toContain("leg");
    expect(svg).toContain(">Brushless ESC 30A</text>");
    await expect(svg).toMatchFileSnapshot("__snapshots__/schematic-esc.svg");
  });

  it("honours a sides override moving i2c to the top", async () => {
    const { part, svg } = build(topI2c);
    expect(sidesOf(part)).toEqual({
      left: ["VCC", "3V3"],
      right: ["INT"],
      top: ["SDA", "SCL"],
      bottom: ["GND", "GND2"],
    });
    assertWellFormed(part, svg);
    const body = bodyRect(svg);
    expect(body.y).toBe(100);
    for (const l of pinLines(svg).filter((x) => x.y2 === 0)) expect(l.y1).toBe(100);
    expect(svg).toMatch(/text-anchor="end" transform="rotate\(-90 [\d.]+ 125\)">SDA</);
    // rotated labels sit in their own band above the first side row
    const lay = layoutSchematic(part);
    const firstRow = Math.min(...lay.pins.filter((p) => p.side === "left").map((p) => p.y1));
    const topLabel = 25 + estimateTextWidthMil("SDA", STYLE.schematic.fontSizeMil);
    expect(firstRow - body.y).toBeGreaterThan(topLabel);
    await expect(svg).toMatchFileSnapshot("__snapshots__/schematic-top-i2c.svg");
  });

  it("grows the body so a long label does not overflow", async () => {
    const input = {
      ...breakout,
      pins: [...breakout.pins, pin("miso", "SPI_MISO/GPIO12", "spi", 7)],
    };
    const { part, svg } = build(input);
    assertWellFormed(part, svg);
    const fs = STYLE.schematic.fontSizeMil;
    const body = bodyRect(svg);
    const need =
      estimateTextWidthMil("SPI_MISO/GPIO12", fs) + estimateTextWidthMil("VCC", fs) + 2 * 25;
    expect(body.w).toBeGreaterThanOrEqual(need);
    expect(body.w).toBeGreaterThan(bodyRect(build(breakout).svg).w);
    await expect(svg).toMatchFileSnapshot("__snapshots__/schematic-long-label.svg");
  });

  it("handles a part with only top/bottom pins or no pins", () => {
    const onlyGnd = build({ ...breakout, pins: [pin("g", "GND", "gnd", 0)] });
    assertWellFormed(onlyGnd.part, onlyGnd.svg);
    expect(layoutSchematic(onlyGnd.part).widthMil).toBe(600);
    const none = build({ ...breakout, pins: [] });
    const lay = layoutSchematic(none.part);
    expect([lay.widthMil, lay.heightMil]).toEqual([600, 300]);
    expect(pinLines(none.svg)).toHaveLength(0);
    assertWellFormed(none.part, none.svg);
  });

  it("escapes label text", () => {
    const { svg } = build({ ...breakout, pins: [pin("a", "A<&>", "io", 0)] });
    expect(svg).toContain(">A&lt;&amp;&gt;</text>");
  });
});

const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

describe("fzp checker", () => {
  (hasUv ? it : it.skip)(
    "accepts the rendered schematic zipped with the spike-vector views",
    () => {
      const { part, ctx, svg } = build({
        slug: "spike-vector",
        title: "Spike vector",
        label: "SP",
        outline: { widthMm: 48, heightMm: 20 },
        pins: [
          { key: "a", name: "A", xMm: 5, yMm: 10 },
          { key: "b", name: "B", xMm: 43, yMm: 10 },
        ],
      });
      const names = fzpzEntryNames(ctx.identity);
      const fixture = (v: string) =>
        new Uint8Array(readFileSync(join(here, "fixtures", "spike-svgs", `${v}.svg`)));
      const zip = zipSync({
        [names.fzp]: new TextEncoder().encode(buildFzp(part, ctx)),
        [names.breadboard]: fixture("breadboard"),
        [names.schematic]: new TextEncoder().encode(svg),
        [names.pcb]: fixture("pcb"),
        [names.icon]: fixture("icon"),
      });
      const dir = mkdtempSync(join(tmpdir(), "fritzkit-sch-"));
      try {
        const file = join(dir, "spike.fzpz");
        writeFileSync(file, zip);
        const r = spawnSync("uv", ["run", "--project", "tools/fzp-checker", "check-fzp", file], {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1" },
        });
        const out = `${r.stdout}\n${r.stderr}`;
        expect(r.status, out).toBe(0);
        expect(out).toContain("Errors found: 0");
        expect(out).not.toMatch(/warning/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
