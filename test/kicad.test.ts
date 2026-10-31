import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseOutline,
  importKicadFile,
  KicadImportError,
  KicadParseError,
  kicadToSpecFragment,
  padExtent,
  parseKicadMod,
  type KicadFootprint,
} from "../src/core/kicad/index.js";
import { parsePartSpec } from "../src/core/schema/part.js";
import { resolvePart } from "../src/core/resolve.js";

const FIX = join(import.meta.dirname, "fixtures", "kicad");
const load = (name: string): KicadFootprint => parseKicadMod(readFileSync(join(FIX, name), "utf8"));

/** Pin positions and geometry as compact tuples for exact comparison. */
function pinTable(frag: ReturnType<typeof kicadToSpecFragment>) {
  return (frag.pins ?? []).map((p) => [p.key, p.name, p.type, p.xMm, p.yMm, p.pad]);
}

function parseError(text: string): KicadParseError {
  try {
    parseKicadMod(text);
  } catch (e) {
    expect(e).toBeInstanceOf(KicadParseError);
    return e as KicadParseError;
  }
  throw new Error("expected a KicadParseError");
}

describe("parseKicadMod", () => {
  it("(a) KiCad 8 2x3 THT header: header fields, pads, drills, bboxes", () => {
    const fp = load("pin_header_2x03.kicad_mod");
    expect(fp.format).toBe("footprint");
    expect(fp.name).toBe("PinHeader_2x03_P2.54mm_Vertical");
    expect(fp.version).toBe(20240108);
    expect(fp.generator).toBe("pcbnew");
    expect(fp.layer).toBe("F.Cu");
    expect(fp.reference).toBe("REF**");
    expect(fp.value).toBe("PinHeader_2x03_P2.54mm_Vertical");
    expect(fp.tags).toBe("Through hole pin header THT 2x03 2.54mm double row");
    expect(fp.pads.map((p) => [p.number, p.type, p.shape, p.x, p.y, p.drill])).toEqual([
      ["1", "thru_hole", "rect", 0, 0, 1],
      ["2", "thru_hole", "oval", 2.54, 0, 1],
      ["3", "thru_hole", "circle", 0, 2.54, 1],
      ["4", "thru_hole", "oval", 2.54, 2.54, 0.8],
      ["5", "thru_hole", "circle", 0, 5.08, 1],
      ["6", "thru_hole", "circle", 2.54, 5.08, 1],
    ]);
    const p4 = fp.pads[3]!;
    expect([p4.drillShape, p4.drillW, p4.drillH]).toEqual(["oval", 1.2, 0.8]);
    expect(fp.pads[0]!.drillShape).toBe("circle");
    expect(fp.pads[0]!.layers).toEqual(["*.Cu", "*.Mask"]);
    expect(fp.pads[0]!.line).toBe(64);
    expect(fp.rects.map((r) => [r.layer, r.width, r.filled])).toEqual([
      ["F.Fab", 0.1, false],
      ["F.CrtYd", 0.05, false],
    ]);
    expect(fp.bbox.courtyard).toEqual({ minX: -1.8, minY: -1.8, maxX: 4.34, maxY: 6.88 });
    expect(fp.bbox.fab).toEqual({ minX: -1.27, minY: -1.27, maxX: 3.81, maxY: 6.35 });
    expect(fp.bbox.edge).toBeUndefined();
    expect(fp.bbox.pads!.minY).toBe(-1);
  });

  it("(b) SMD module: roundrect pads, duplicate numbers, v6 arc and poly bboxes", () => {
    const fp = load("smd_module.kicad_mod");
    expect(fp.pads).toHaveLength(10);
    expect(fp.pads.every((p) => p.type === "smd" && p.drill === undefined)).toBe(true);
    expect(fp.pads.slice(0, 4).every((p) => p.shape === "roundrect")).toBe(true);
    expect(fp.descr).toBe(
      'XIAO-style castellated MCU module, 4 pads per side, plus a split "GND" pad',
    );
    expect(fp.reference).toBe("U**");
    expect(fp.arcs).toHaveLength(1);
    const arc = fp.arcs[0]!;
    expect(arc.center.x).toBeCloseTo(0, 9);
    expect(arc.center.y).toBeCloseTo(-10, 9);
    expect(arc.radius).toBeCloseTo(1, 9);
    expect(arc.sweepDeg).toBeCloseTo(180, 9);
    expect(fp.polys[0]!.points).toHaveLength(3);
    expect(fp.polys[0]!.width).toBe(0.12);
    const silk = fp.bbox.silk!;
    expect(silk.minX).toBeCloseTo(-9.5, 9);
    expect(silk.minY).toBeCloseTo(-11, 9);
    expect(silk.maxX).toBeCloseTo(1, 9);
    expect(silk.maxY).toBeCloseTo(-8.5, 9);
    expect(fp.bbox.courtyard).toBeUndefined();
  });

  it("(c) KiCad 5 legacy module: unquoted atoms, Edge.Cuts lines, np hole, v5 arc", () => {
    const fp = load("relay_board_legacy.kicad_mod");
    expect(fp.format).toBe("module");
    expect(fp.name).toBe("Relay_Board_3pin");
    expect(fp.version).toBeUndefined();
    expect(fp.reference).toBe("REF**");
    expect(fp.value).toBe("Relay_Board_3pin");
    expect(fp.pads.map((p) => [p.number, p.type, p.shape])).toEqual([
      ["1", "thru_hole", "rect"],
      ["2", "thru_hole", "circle"],
      ["3", "thru_hole", "circle"],
      ["", "np_thru_hole", "circle"],
    ]);
    expect(fp.lines.filter((l) => l.layer === "Edge.Cuts")).toHaveLength(4);
    expect(fp.lines[0]!.width).toBe(0.15);
    expect(fp.bbox.edge).toEqual({ minX: -5, minY: -5, maxX: 25, maxY: 15 });
    expect(fp.circles[0]).toMatchObject({ cx: 20, cy: 10, layer: "F.Fab", width: 0.1 });
    expect(fp.circles[0]!.r).toBeCloseTo(1.6, 9);
    const arc = fp.arcs[0]!;
    expect(arc.center).toEqual({ x: 0, y: 10 });
    expect(arc.start).toEqual({ x: 2, y: 10 });
    expect(arc.sweepDeg).toBe(90);
    expect(arc.end.x).toBeCloseTo(0, 9);
    expect(arc.end.y).toBeCloseTo(12, 9);
    expect(fp.bbox.silk!.maxY).toBeCloseTo(12, 9);
    expect(fp.bbox.fab!.minX).toBeCloseTo(18.4, 9);
  });

  it("(d) rotated pads: rotation normalised, connect and custom pads", () => {
    const fp = load("mixed_rotated.kicad_mod");
    expect(fp.pads.map((p) => [p.number, p.type, p.shape, p.rotation])).toEqual([
      ["1", "smd", "rect", 90],
      ["2", "smd", "roundrect", 270],
      ["3", "thru_hole", "oval", 180],
      ["4", "connect", "circle", 0],
      ["5", "smd", "rect", 45],
      ["A/1", "smd", "custom", 0],
    ]);
    expect(fp.pads[2]!.drill).toBe(0.6);
    expect(fp.bbox.courtyard).toEqual({ minX: -3, minY: -2, maxX: 3, maxY: 2 });
    expect(fp.bbox.edge).toBeUndefined();
    expect(fp.bbox.fab).toBeUndefined();
  });

  it("(e) KiCad 8 library 1x04 header: KLC silk/fab/courtyard geometry, y down", () => {
    const fp = load("pin_header_1x04.kicad_mod");
    expect(fp.name).toBe("PinHeader_1x04_P2.54mm_Vertical");
    expect(fp.pads.map((p) => [p.number, p.shape, p.x, p.y, p.w, p.h, p.drill])).toEqual([
      ["1", "rect", 0, 0, 1.7, 1.7, 1],
      ["2", "oval", 0, 2.54, 1.7, 1.7, 1],
      ["3", "oval", 0, 5.08, 1.7, 1.7, 1],
      ["4", "oval", 0, 7.62, 1.7, 1.7, 1],
    ]);
    expect(fp.lines).toHaveLength(15);
    expect(fp.bbox.silk).toEqual({ minX: -1.33, minY: -1.33, maxX: 1.33, maxY: 8.95 });
    expect(fp.bbox.fab).toEqual({ minX: -1.27, minY: -1.27, maxX: 1.27, maxY: 8.89 });
    expect(fp.bbox.courtyard).toEqual({ minX: -1.8, minY: -1.8, maxX: 1.8, maxY: 9.4 });
    // y down: the pin-1 silk marker and the Reference text sit above pin 1 (negative y).
    expect(fp.bbox.silk!.minY).toBeLessThan(fp.pads[0]!.y);
    const frag = kicadToSpecFragment(fp, { slug: "hdr-1x4" });
    expect([frag.outline.widthMm, frag.outline.heightMm]).toEqual([3.6, 11.2]);
    expect(frag.pins!.map((p) => [p.key, p.xMm, p.yMm])).toEqual([
      ["p1", 1.8, 1.8],
      ["p2", 1.8, 4.34],
      ["p3", 1.8, 6.88],
      ["p4", 1.8, 9.42],
    ]);
    expect(resolvePart(parsePartSpec(frag)).connectors).toHaveLength(4);
  });

  it("handles a degenerate v6 arc, filled rects, missing drill and single-value size", () => {
    const fp = parseKicadMod(
      [
        '(footprint "t" (layer "F.Cu")',
        '  (fp_arc (start 0 0) (mid 1 0) (end 2 0) (layer "F.SilkS") (width 0.1))',
        '  (fp_rect (start 0 0) (end 1 1) (fill solid) (layer "F.SilkS"))',
        '  (fp_arc (start 0 0) (mid 1 1) (end 2 0) (layer "F.SilkS"))',
        '  (pad "1" thru_hole circle (at 0 0) (size 1.5) (drill 0) (layers "*.Cu"))',
        ")",
      ].join("\n"),
    );
    expect(fp.arcs).toHaveLength(1);
    expect(fp.arcs[0]!.sweepDeg).toBeCloseTo(-180, 9);
    expect(fp.rects[0]!.filled).toBe(true);
    expect(fp.rects[0]!.width).toBe(0);
    expect(fp.pads[0]!.h).toBe(1.5);
    expect(fp.pads[0]!.drill).toBeUndefined();
    expect(fp.bbox.silk!.maxY).toBeCloseTo(1, 9);
  });

  it("throws KicadParseError with a line number on bad input", () => {
    const unbalanced = parseError(
      '(footprint "x"\n  (layer "F.Cu")\n  (pad "1" smd rect (at 0 0)\n',
    );
    expect(unbalanced.line).toBe(3);
    const notFp = parseError('\n\n(kicad_pcb (version 20240108)\n  (generator "pcbnew"))');
    expect(notFp.line).toBe(3);
    expect(notFp.message).toMatch(/expected \(footprint \.\.\.\) or \(module \.\.\.\)/);
    expect(parseError("((x))").message).toMatch(/got \(\(\.\.\.\) \.\.\.\)/);
    expect(parseError("(footprint)").message).toMatch(/has no name/);
    const badType = parseError('(footprint "x"\n  (pad "1" via rect (at 0 0) (size 1 1)))');
    expect([badType.line, /unknown pad type "via"/.test(badType.message)]).toEqual([2, true]);
    expect(parseError('(footprint "x" (pad "1" smd blob (at 0 0) (size 1 1)))').message).toMatch(
      /unknown pad shape "blob"/,
    );
    expect(parseError('(footprint "x" (pad "1" smd (at 0 0)))').message).toMatch(
      /unknown pad shape "\(list\)"/,
    );
    expect(parseError('(footprint "x" (pad "1" (x) rect))').message).toMatch(
      /unknown pad type "\(list\)"/,
    );
    const noAt = parseError('(footprint "x"\n\n  (pad "1" smd rect (size 1 1)))');
    expect([noAt.line, /\(at x y\)/.test(noAt.message)]).toEqual([3, true]);
    expect(parseError('(footprint "x" (pad "1" smd rect (at 0 0)))').message).toMatch(
      /missing \(size w h\)/,
    );
    const badLine = parseError(
      '(footprint "x"\n  (fp_line (start 0 0) (end a 1) (layer "F.SilkS")))',
    );
    expect([badLine.line, /\(end x y\)/.test(badLine.message)]).toEqual([2, true]);
  });
});

describe("padExtent", () => {
  it("swaps w/h at 90/270, keeps them at 0/180, bboxes other angles", () => {
    const pad = { w: 2, h: 1, shape: "rect" as const };
    expect(padExtent({ ...pad, rotation: 0 })).toEqual({ w: 2, h: 1 });
    expect(padExtent({ ...pad, rotation: 180 })).toEqual({ w: 2, h: 1 });
    expect(padExtent({ ...pad, rotation: 90 })).toEqual({ w: 1, h: 2 });
    expect(padExtent({ ...pad, rotation: -90 })).toEqual({ w: 1, h: 2 });
    expect(padExtent({ ...pad, rotation: 450 })).toEqual({ w: 1, h: 2 });
    const e = padExtent({ ...pad, rotation: 30 });
    expect(e.w).toBeCloseTo(2 * Math.cos(Math.PI / 6) + 0.5, 9);
    expect(e.h).toBeCloseTo(1 + Math.cos(Math.PI / 6), 9);
    expect(padExtent({ w: 1, h: 1, shape: "circle", rotation: 30 })).toEqual({ w: 1, h: 1 });
  });
});

describe("chooseOutline", () => {
  it("defaults to edge, then courtyard, then fab, then pads + 1 mm", () => {
    expect(chooseOutline(load("relay_board_legacy.kicad_mod")).source).toBe("edge");
    expect(chooseOutline(load("pin_header_2x03.kicad_mod")).source).toBe("courtyard");
    expect(chooseOutline(load("smd_module.kicad_mod")).source).toBe("fab");
    const bare = parseKicadMod('(footprint "b" (pad "1" smd rect (at 1 2) (size 2 1)))');
    expect(chooseOutline(bare)).toEqual({
      source: "pads",
      box: { minX: -1, minY: 0.5, maxX: 3, maxY: 3.5 },
    });
  });

  it("skips a degenerate courtyard and throws for an unavailable requested outline", () => {
    const fp = parseKicadMod(
      '(footprint "d" (fp_line (start 0 0) (end 5 0) (layer "F.CrtYd")) (pad "1" smd rect (at 0 0) (size 1 1)))',
    );
    expect(chooseOutline(fp).source).toBe("pads");
    expect(() => chooseOutline(fp, "courtyard")).toThrow(KicadImportError);
    expect(() => chooseOutline(fp, "edge")).toThrow(/no usable edge outline/);
    const empty = parseKicadMod('(footprint "e" (layer "F.Cu"))');
    expect(() => chooseOutline(empty)).toThrow(/no pads and no Edge.Cuts/);
    expect(() => chooseOutline(empty, "pads")).toThrow(/\(no pads\)/);
  });
});

describe("kicadToSpecFragment", () => {
  it("(a) THT header: courtyard outline, shifted pins, round/rect/oval pads, holes", () => {
    const frag = kicadToSpecFragment(load("pin_header_2x03.kicad_mod"), { slug: "hdr-2x3" });
    expect(frag.outline).toEqual({
      widthMm: 6.14,
      heightMm: 8.68,
      shape: "rect",
      cornerRadiusMm: 0,
      holes: [],
    });
    expect(frag.title).toBe("PinHeader_2x03_P2.54mm_Vertical");
    expect(pinTable(frag)).toEqual([
      ["p1", "1", "female", 1.8, 1.8, { shape: "rect", wMm: 1.7, hMm: 1.7, holeMm: 1 }],
      ["p2", "2", "female", 4.34, 1.8, { shape: "oval", wMm: 1.7, hMm: 2, holeMm: 1 }],
      ["p3", "3", "female", 1.8, 4.34, { shape: "round", wMm: 1.7, hMm: 1.7, holeMm: 1 }],
      ["p4", "4", "female", 4.34, 4.34, { shape: "oval", wMm: 1.7, hMm: 2, holeMm: 0.8 }],
      ["p5", "5", "female", 1.8, 6.88, { shape: "round", wMm: 1.7, hMm: 1.7, holeMm: 1 }],
      ["p6", "6", "female", 4.34, 6.88, { shape: "round", wMm: 1.7, hMm: 1.7, holeMm: 1 }],
    ]);
    // y-down kept: the pad with the smallest file y has the smallest yMm.
    expect(frag.pins![0]!.yMm).toBeLessThan(frag.pins![2]!.yMm);
    expect(frag.pins!.every((p) => p.role === "io")).toBe(true);
    expect(frag.buses).toBeUndefined();
    expect(frag.properties).toEqual({ "kicad footprint": "PinHeader_2x03_P2.54mm_Vertical" });
    expect(frag.description).toMatch(/not converted to headers/);
    expect(frag.description).toMatch(/Outline from the courtyard/);
    expect(frag.tags).toEqual([
      "kicad",
      "Through",
      "hole",
      "pin",
      "header",
      "THT",
      "2x03",
      "2.54mm",
      "double",
      "row",
    ]);
    const spec = parsePartSpec(frag);
    const r = resolvePart(spec);
    expect(r.hasTht).toBe(true);
    expect(r.connectors).toHaveLength(6);
  });

  it("(a) honours an explicit fab / pads outline and a title override", () => {
    const fp = load("pin_header_2x03.kicad_mod");
    const fab = kicadToSpecFragment(fp, { slug: "hdr-2x3", outline: "fab", title: "My Header" });
    expect([fab.outline.widthMm, fab.outline.heightMm]).toEqual([5.08, 7.62]);
    expect([fab.pins![0]!.xMm, fab.pins![0]!.yMm]).toEqual([1.27, 1.27]);
    expect(fab.title).toBe("My Header");
    const pads = kicadToSpecFragment(fp, { slug: "hdr-2x3", outline: "pads" });
    expect([pads.outline.widthMm, pads.outline.heightMm]).toEqual([6.24, 8.93]);
    expect([pads.pins![0]!.xMm, pads.pins![0]!.yMm]).toEqual([1.85, 2]);
    expect(pads.description).toMatch(/pad bounding box \+ 1 mm/);
    expect(() => kicadToSpecFragment(fp, { slug: "hdr-2x3", outline: "edge" })).toThrow(
      KicadImportError,
    );
  });

  it("(b) SMD module: fab outline, smd pads, deduped keys tied by a bus, no THT", () => {
    const frag = kicadToSpecFragment(load("smd_module.kicad_mod"), { slug: "mcu-module" });
    expect([frag.outline.widthMm, frag.outline.heightMm]).toEqual([18, 21]);
    const smd = (w: number, h: number) => ({ shape: "rect", wMm: w, hMm: h, smd: true });
    expect(pinTable(frag)).toEqual([
      ["p1", "1", "pad", 1, 6.69, smd(2, 1.2)],
      ["p2", "2", "pad", 1, 9.23, smd(2, 1.2)],
      ["p3", "3", "pad", 1, 11.77, smd(2, 1.2)],
      ["p4", "4", "pad", 1, 14.31, smd(2, 1.2)],
      ["p5", "5", "pad", 17, 6.69, smd(2, 1.2)],
      ["p6", "6", "pad", 17, 9.23, smd(2, 1.2)],
      ["p7", "7", "pad", 17, 11.77, smd(2, 1.2)],
      ["p8", "8", "pad", 17, 14.31, smd(2, 1.2)],
      ["p9", "9", "pad", 7, 19.5, smd(1.5, 1.5)],
      ["p9_2", "9 (2)", "pad", 11, 19.5, smd(1.5, 1.5)],
    ]);
    expect(frag.buses).toEqual([{ id: "pad_9", pins: ["p9", "p9_2"] }]);
    expect(frag.description).toMatch(/split "GND" pad/);
    const r = resolvePart(parsePartSpec(frag));
    expect(r.hasTht).toBe(false);
    expect(r.connectors.every((c) => !c.tht)).toBe(true);
    expect(r.buses).toEqual([{ id: "pad_9", connectorIds: [8, 9] }]);
  });

  it("(c) KiCad 5 legacy: Edge.Cuts outline and the np_thru_hole as an outline hole", () => {
    const frag = kicadToSpecFragment(load("relay_board_legacy.kicad_mod"), { slug: "relay-board" });
    expect(frag.outline).toEqual({
      widthMm: 30,
      heightMm: 20,
      shape: "rect",
      cornerRadiusMm: 0,
      holes: [{ xMm: 25, yMm: 15, dMm: 3.2 }],
    });
    expect(pinTable(frag)).toEqual([
      ["p1", "1", "female", 5, 5, { shape: "rect", wMm: 2, hMm: 2, holeMm: 1.2 }],
      ["p2", "2", "female", 10.08, 5, { shape: "round", wMm: 2, hMm: 2, holeMm: 1.2 }],
      ["p3", "3", "female", 15.16, 5, { shape: "round", wMm: 2, hMm: 2, holeMm: 1.2 }],
    ]);
    expect(frag.tags).toEqual(["kicad", "relay", "module"]);
    expect(frag.description).toMatch(/Outline from the Edge.Cuts/);
    const spec = parsePartSpec(frag);
    expect(spec.outline.holes).toHaveLength(1);
    expect(resolvePart(spec).hasTht).toBe(true);
  });

  it("(d) rotated pads: w/h swapped at 90/270, connect -> smd, custom -> rect, sanitised key", () => {
    const frag = kicadToSpecFragment(load("mixed_rotated.kicad_mod"), { slug: "mixed-rot" });
    expect([frag.outline.widthMm, frag.outline.heightMm]).toEqual([6, 4]);
    expect(pinTable(frag)).toEqual([
      ["p1", "1", "pad", 1, 2, { shape: "rect", wMm: 0.6, hMm: 1, smd: true }],
      ["p2", "2", "pad", 5, 2, { shape: "rect", wMm: 0.6, hMm: 1, smd: true }],
      ["p3", "3", "female", 3, 3, { shape: "oval", wMm: 1.6, hMm: 1, holeMm: 0.6 }],
      ["p4", "4", "pad", 3, 1, { shape: "round", wMm: 0.8, hMm: 0.8, smd: true }],
      ["p5", "5", "pad", 4, 0.8, { shape: "rect", wMm: 1.4142, hMm: 1.4142, smd: true }],
      ["pA_1", "A/1", "pad", 2, 0.8, { shape: "rect", wMm: 0.5, hMm: 0.5, smd: true }],
    ]);
    const r = resolvePart(parsePartSpec(frag));
    expect(r.hasTht).toBe(true);
    expect(r.connectors.filter((c) => c.tht).map((c) => c.key)).toEqual(["p3"]);
  });

  it("handles unnamed pads, key collisions, np holes without drill and a nameless footprint", () => {
    const fp = parseKicadMod(
      [
        '(footprint ""',
        '  (pad "" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "1_2" smd rect (at 1 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "1" smd rect (at 2 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "1" smd rect (at 3 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "" np_thru_hole oval (at 4 0) (size 2 1.5) (layers "*.Cu"))',
        '  (pad "" thru_hole circle (at 5 0) (size 1 1) (layers "*.Cu"))',
        '  (pad "A/1" smd rect (at 6 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "A/1" smd rect (at 7 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "A+1" smd rect (at 8 0) (size 1 1) (layers "F.Cu"))',
        '  (pad "A+1" smd rect (at 9 0) (size 1 1) (layers "F.Cu"))',
        ")",
      ].join("\n"),
    );
    const frag = kicadToSpecFragment(fp, { slug: "edge-cases" });
    expect(frag.title).toBe("edge-cases");
    expect(frag.properties).toBeUndefined();
    expect(frag.pins!.map((p) => [p.key, p.name])).toEqual([
      ["p", "pad"],
      ["p1_2", "1_2"],
      ["p1", "1"],
      ["p1_3", "1 (2)"],
      ["p_2", "pad"],
      ["pA_1", "A/1"],
      ["pA_1_2", "A/1 (2)"],
      ["pA+1", "A+1"],
      ["pA+1_2", "A+1 (2)"],
    ]);
    // A thru_hole pad without a drill is emitted as an SMD "pad" rather than a 0 mm hole.
    expect(frag.pins![4]!.type).toBe("pad");
    expect(frag.pins![4]!.pad).toEqual({ shape: "round", wMm: 1, hMm: 1, smd: true });
    expect(frag.outline.holes).toEqual([{ xMm: 5.5, yMm: 1.75, dMm: 1.5 }]);
    // Bus ids are deduped too: "A/1" and "A+1" both sanitise to pad_A_1.
    expect(frag.buses).toEqual([
      { id: "pad_1", pins: ["p1", "p1_3"] },
      { id: "pad_A_1", pins: ["pA_1", "pA_1_2"] },
      { id: "pad_A_1_2", pins: ["pA+1", "pA+1_2"] },
    ]);
    expect(() => parsePartSpec(frag)).not.toThrow();
  });

  it("skips pads with no copper layer; keeps B.Cu, F&B.Cu, In1.Cu and layer-less pads", () => {
    const fp = parseKicadMod(
      [
        '(footprint "layers" (layer "F.Cu")',
        '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Mask"))',
        '  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Paste"))',
        '  (pad "3" smd rect (at 2 0) (size 1 1) (layers "B.Cu" "B.Paste" "B.Mask"))',
        '  (pad "4" smd rect (at 3 0) (size 1 1))',
        '  (pad "5" thru_hole circle (at 4 0) (size 1.7 1.7) (drill 1) (layers "F&B.Cu"))',
        '  (pad "6" connect circle (at 5 0) (size 1 1) (layers "In1.Cu"))',
        '  (pad "7" smd roundrect (at 6 0) (size 1 1) (layers "F.Cu" "F.Mask")',
        "    (roundrect_rratio 0.25) (chamfer_ratio 0.2) (chamfer top_left bottom_right)",
        '    (thermal_bridge_angle 45) (zone_connect 2) (net 1 "GND") (pinfunction "GND"))',
        ")",
      ].join("\n"),
    );
    expect(fp.pads).toHaveLength(7);
    const frag = kicadToSpecFragment(fp, { slug: "layer-test" });
    expect(frag.pins!.map((p) => p.key)).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    expect(() => parsePartSpec(frag)).not.toThrow();
  });

  it("throws KicadImportError for a zero-size np hole or copper pad", () => {
    const np = parseKicadMod(
      '(footprint "z"\n  (pad "" np_thru_hole circle (at 1 1) (size 0 0) (drill 0) (layers "*.Cu")) (pad "1" smd rect (at 0 0) (size 1 1)))',
    );
    expect(() => kicadToSpecFragment(np, { slug: "zero-np" })).toThrow(
      /line 2: np_thru_hole pad has no positive drill/,
    );
    const pad = parseKicadMod(
      '(footprint "z" (pad "1" smd rect (at 0 0) (size 1 1)) (pad "2" smd rect (at 2 0) (size 0 1)))',
    );
    expect(() => kicadToSpecFragment(pad, { slug: "zero-pad" })).toThrow(KicadImportError);
    expect(() => kicadToSpecFragment(pad, { slug: "zero-pad" })).toThrow(/pad "2" has a zero size/);
  });

  it("is deterministic", () => {
    const fp = load("smd_module.kicad_mod");
    expect(JSON.stringify(kicadToSpecFragment(fp, { slug: "mcu-module" }))).toBe(
      JSON.stringify(kicadToSpecFragment(load("smd_module.kicad_mod"), { slug: "mcu-module" })),
    );
  });
});

describe("importKicadFile", () => {
  it("reads, parses and converts a file", async () => {
    const frag = await importKicadFile(join(FIX, "relay_board_legacy.kicad_mod"), {
      slug: "relay-board",
      outline: "edge",
    });
    expect(frag.slug).toBe("relay-board");
    expect(frag.pins).toHaveLength(3);
    expect(() => parsePartSpec(frag)).not.toThrow();
  });

  it("rejects a missing file", async () => {
    await expect(importKicadFile(join(FIX, "nope.kicad_mod"), { slug: "x-x-x" })).rejects.toThrow(
      /ENOENT/,
    );
  });
});
