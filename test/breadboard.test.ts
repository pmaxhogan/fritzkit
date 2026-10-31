import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  BB,
  extraNamespaces,
  group,
  headerLabelSize,
  renderBreadboard,
  renderBreadboardContent,
  XLINK_NS,
} from "../src/core/compile/breadboard.js";
import { darkenHex, PathParseError, scalePath } from "../src/core/compile/breadboard-util.js";
import { renderIcon } from "../src/core/compile/icon.js";
import { STYLE } from "../src/core/compile/style.js";
import { fzpzEntryNames, layerImage } from "../src/core/identity.js";
import type { ResolvedPart } from "../src/core/resolve.js";
import { formatIn } from "../src/core/svg.js";
import { mmToIn } from "../src/core/units.js";
import {
  attrValues,
  build,
  FIXTURES,
  numAttr,
  photoFixture,
  tagWithId,
  TINY_PNG_B64,
} from "./breadboard-fixtures.js";

function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

/** Invariants every breadboard SVG must satisfy. */
function assertHouseRules(svg: string, part: ResolvedPart): void {
  // exactly one layer group, and it is the only child of the root
  expect(count(svg, 'id="breadboard"')).toBe(1);
  const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"));
  expect(inner.trim().startsWith('<g id="breadboard">')).toBe(true);
  expect(inner.trim().endsWith("</g>")).toBe(true);
  expect(count(inner, "<g")).toBe(count(inner, "</g>"));
  // root size in inches matches the frame
  expect(svg).toContain(`width="${formatIn(mmToIn(part.frame.widthMm))}in"`);
  expect(svg).toContain(`height="${formatIn(mmToIn(part.frame.heightMm))}in"`);
  // fonts, no CSS, no tspans, ASCII only
  for (const f of attrValues(svg, "font-family"))
    expect(["Noto Sans", "OCR-Fritzing-mono"]).toContain(f);
  expect(svg).not.toContain("style=");
  expect(svg).not.toContain("<style");
  expect(svg).not.toContain("tspan");
  expect([...svg].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  // ids unique
  const ids = attrValues(svg, "id");
  expect(new Set(ids).size).toBe(ids.length);
  // connector elements
  for (const c of part.connectors) {
    expect(count(svg, `id="${c.svgId}"`)).toBe(1);
    if (c.source === "lead") {
      expect(count(svg, `id="${c.legId}"`)).toBe(1);
      expect(svg).not.toContain(`id="${c.terminalId}"`);
    } else {
      expect(count(svg, `id="${c.terminalId}"`)).toBe(1);
      const t = tagWithId(svg, c.terminalId)!;
      expect(numAttr(t, "width")).toBeGreaterThan(0);
      expect(numAttr(t, "height")).toBeGreaterThan(0);
    }
    // the pin element is visible
    const pin = tagWithId(svg, c.svgId)!;
    expect(pin).toMatch(/fill="#[0-9A-F]{6}"/);
  }
}

/** Centre of an element (rect or circle) from its formatted attributes. */
function centre(tag: string): { x: number; y: number } {
  if (tag.startsWith("<circle")) return { x: numAttr(tag, "cx"), y: numAttr(tag, "cy") };
  return {
    x: numAttr(tag, "x") + numAttr(tag, "width") / 2,
    y: numAttr(tag, "y") + numAttr(tag, "height") / 2,
  };
}

function onGrid(v: number): boolean {
  const r = ((v % 100) + 100) % 100;
  return r < 0.01 || 100 - r < 0.01;
}

describe("renderBreadboard", () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`${name}: follows the house rules and matches the snapshot`, async () => {
      const { part, ctx } = build(input);
      const svg = renderBreadboard(part, ctx);
      assertHouseRules(svg, part);
      expect(svg).not.toContain("xmlns:xlink");
      expect(renderBreadboard(part, ctx)).toBe(svg); // deterministic
      await expect(svg).toMatchFileSnapshot(`__snapshots__/breadboard-${name}.svg`);
    });
  }

  it("puts every header pin on a 100 mil multiple of the canvas", () => {
    for (const input of [FIXTURES.breakout, FIXTURES.castellated]) {
      const { part, ctx } = build(input);
      const svg = renderBreadboard(part, ctx);
      const headerPins = part.connectors.filter((c) => c.source === "header");
      expect(headerPins.length).toBe(14);
      for (const c of headerPins) {
        const p = centre(tagWithId(svg, c.svgId)!);
        expect(onGrid(p.x), `${c.svgId} x=${p.x}`).toBe(true);
        expect(onGrid(p.y), `${c.svgId} y=${p.y}`).toBe(true);
        const t = centre(tagWithId(svg, c.terminalId)!);
        expect(t.x).toBeCloseTo(p.x, 2);
        expect(t.y).toBeCloseTo(p.y, 2);
      }
    }
  });

  it("draws male, female and castellated headers in the core palette", () => {
    const b = renderBreadboard(build(FIXTURES.breakout).part, build(FIXTURES.breakout).ctx);
    for (const c of ["#404040", "#8D8C8C", "#8C8663", "#B8AF82", "#80795B", "#5E5B43", "#9A916C"])
      expect(b).toContain(`fill="${c}"`);
    for (const c of ["#2A2A29", "#474747", "#595959", "#373737"])
      expect(b).toContain(`fill="${c}"`);
    // male pin element is the grey pin square, female pin element is the black hole
    const { part } = build(FIXTURES.breakout);
    const male = part.connectors.find((c) => c.header?.kind === "male")!;
    const female = part.connectors.find((c) => c.header?.kind === "female")!;
    expect(tagWithId(b, male.svgId)).toContain('fill="#8D8C8C"');
    expect(tagWithId(b, female.svgId)).toContain('fill="#000000"');
    // pin square is ~32% of the 100 mil cell (core header proportions)
    expect(numAttr(tagWithId(b, male.svgId)!, "width")).toBeCloseTo(31.9, 0);
    // labels on the inward side: top row labelled below its pins, bottom row above
    const vin = /<text[^>]*>VIN<\/text>/.exec(b)![0];
    expect(numAttr(vin, "y")).toBeGreaterThan(centre(tagWithId(b, male.svgId)!).y);
    expect(vin).toContain('fill="#F2A6A1"');
    const a0 = /<text[^>]*>A0<\/text>/.exec(b)![0];
    expect(numAttr(a0, "y")).toBeLessThan(centre(tagWithId(b, female.svgId)!).y);
    // header labels are 80% of the label size
    expect(vin).toContain(`font-size="${STYLE.labelFontSizeMil * BB.headerLabelScale}"`);

    const cs = build(FIXTURES.castellated);
    const c = renderBreadboard(cs.part, cs.ctx);
    const left = cs.part.connectors.find((x) => x.key === "lD0")!;
    expect(tagWithId(c, left.svgId)).toContain('fill="#9A916C"');
    expect(/<text[^>]*>D0<\/text>/.exec(c)![0]).toContain('text-anchor="start"');
    expect(/<text[^>]*>5V<\/text>/.exec(c)![0]).toContain('text-anchor="end"');
  });

  it("skips header labels below 2 mm pitch and labels only the innermost row", () => {
    const { part, ctx } = build({
      slug: "test-fine",
      title: "Fine pitch",
      outline: { widthMm: 20, heightMm: 10 },
      headers: [
        {
          key: "h",
          cols: 4,
          pitchMm: 1.27,
          xMm: 3,
          yMm: 2,
          pins: ["A", "B", "C", "D"].map((n) => ({ key: n, name: n })),
        },
        {
          key: "dual",
          kind: "female",
          rows: 2,
          cols: 2,
          xMm: 10,
          yMm: 5,
          pins: ["P", "Q", "R", "S"].map((n) => ({ key: n, name: n })),
        },
      ],
    });
    const svg = renderBreadboard(part, ctx);
    for (const n of ["A", "B", "C", "D"]) expect(svg).not.toContain(`>${n}</text>`);
    // dual row at y 5 and 7.54 sits in the bottom half -> row 0 is innermost (labelled above)
    expect(svg).toContain(">P</text>");
    expect(svg).toContain(">Q</text>");
    expect(svg).not.toContain(">R</text>");
    expect(svg).not.toContain(">S</text>");
    // gaps (null pins) draw nothing
    const g = build({
      slug: "test-gap",
      title: "Gap",
      outline: { widthMm: 20, heightMm: 10 },
      headers: [
        {
          key: "h",
          cols: 3,
          xMm: 3,
          yMm: 3,
          pins: [{ key: "a", name: "A" }, null, { key: "c", name: "C" }],
        },
      ],
    });
    const gs = renderBreadboard(g.part, g.ctx);
    expect(count(gs, 'fill="#8D8C8C"')).toBe(2);
  });

  it("shrinks horizontal header labels so long names do not overlap at 100 mil", () => {
    const names = ["GND", "GPIO12", "GPIO13", "VBUS"];
    const { part, ctx } = build({
      slug: "test-long-labels",
      title: "Long labels",
      outline: { widthMm: 12, heightMm: 8 },
      headers: [
        {
          key: "h",
          cols: 4,
          xMm: 1.27,
          yMm: 1.27,
          pins: names.map((n) => ({ key: n, name: n })),
        },
      ],
    });
    const svg = renderBreadboard(part, ctx);
    const sizes = names.map((n) =>
      numAttr(new RegExp(`<text[^>]*>${n}</text>`).exec(svg)![0], "font-size"),
    );
    // one size for the whole header; 6 chars * 0.6 em must fit in 90 mil
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]! * 6 * BB.charWidthEm).toBeLessThanOrEqual(90);
    expect(sizes[0]).toBeLessThan(STYLE.labelFontSizeMil * BB.headerLabelScale);
    // short labels and vertical columns keep the default size; the floor holds
    const g = part.connectors;
    expect(headerLabelSize(g.slice(0, 1), "horizontal", 100)).toBe(40);
    expect(headerLabelSize(g, "vertical", 100)).toBe(40);
    const long = [{ ...g[0]!, label: "VERYLONGLABEL1234" }];
    expect(headerLabelSize(long, "horizontal", 100)).toBe(BB.minHeaderLabelMil);
  });

  it("draws free-standing pads by shape with holes, labels and terminals", () => {
    const { part, ctx } = build(FIXTURES.pads);
    const svg = renderBreadboard(part, ctx);
    const by = (k: string) => part.connectors.find((c) => c.key === k)!;
    expect(tagWithId(svg, by("vcc").svgId)).toMatch(/^<rect /);
    expect(tagWithId(svg, by("sig").svgId)).toMatch(/^<circle /);
    const oval = tagWithId(svg, by("en").svgId)!;
    expect(oval).toMatch(/^<rect /);
    expect(numAttr(oval, "rx")).toBeCloseTo(31.496, 2); // min(3, 1.6) / 2 mm
    for (const k of ["vcc", "gnd", "sig", "en"])
      expect(tagWithId(svg, by(k).svgId)).toContain('stroke-width="6"');
    // two holes (vcc, gnd) in the pad hole colour
    expect(count(svg, `<circle cx=`)).toBeGreaterThanOrEqual(2);
    expect(count(svg, `r="19.685" fill="${BB.padHole}"`)).toBe(1);
    // labels: left half -> start, right half -> end; power/gnd use the role colours
    expect(/<text[^>]*>VCC<\/text>/.exec(svg)![0]).toContain('fill="#F2A6A1"');
    expect(/<text[^>]*>VCC<\/text>/.exec(svg)![0]).toContain('text-anchor="start"');
    expect(/<text[^>]*>GND<\/text>/.exec(svg)![0]).toContain('fill="#E6E6E6"');
    expect(/<text[^>]*>SIG<\/text>/.exec(svg)![0]).toContain('text-anchor="end"');
    expect(/<text[^>]*>SIG<\/text>/.exec(svg)![0]).toContain('fill="#E6E6E6"');
    // silkscreen kinds
    expect(svg).toContain('transform="rotate(-90 ');
    expect(svg).toContain('stroke-linecap="round"');
    expect(/<text[^>]*>PADS<\/text>/.exec(svg)![0]).not.toContain("transform");
    expect(svg).toContain('fill="#EEEEEE"');
    expect(svg).not.toContain("SOIC-8"); // notes are not rendered
  });

  it("draws leads as bendable legs anchored on the board", () => {
    const { part, ctx } = build(FIXTURES.esc);
    const svg = renderBreadboard(part, ctx);
    const vbat = part.connectors.find((c) => c.key === "vbat")!;
    const leg = tagWithId(svg, vbat.legId!)!;
    expect(leg).toMatch(/^<line /);
    expect(leg).toContain('stroke="#D02020"');
    expect(leg).toContain('stroke-linecap="round"');
    expect(numAttr(leg, "stroke-width")).toBeCloseTo(78.74, 2);
    const pin = tagWithId(svg, vbat.svgId)!;
    // the pin sits at the leg's start (x1, y1), the leg runs 25 mm to the right
    expect(numAttr(pin, "cx")).toBe(numAttr(leg, "x1"));
    expect(numAttr(pin, "cy")).toBe(numAttr(leg, "y1"));
    expect(numAttr(leg, "x2") - numAttr(leg, "x1")).toBeCloseTo(984.252, 2);
    const m1 = part.connectors.find((c) => c.key === "m1")!;
    const leg1 = tagWithId(svg, m1.legId!)!;
    // The leg runs PAST the canvas (core convention: the viewBox holds only the body).
    expect(numAttr(leg1, "x2")).toBeLessThan(0);
    expect(count(svg, "terminal")).toBe(0);
  });

  it("draws outlines: rect, rounded with holes and custom paths", () => {
    const r = build(FIXTURES.pads);
    const rs = renderBreadboard(r.part, r.ctx);
    expect(rs).toMatch(/<rect x="4" y="4" width="[\d.]+" height="[\d.]+" fill="#1B7F3B"/);
    expect(rs).toContain(`stroke="${darkenHex("#1B7F3B")}" stroke-width="8"`);
    const b = build(FIXTURES.breakout);
    const bs = renderBreadboard(b.part, b.ctx);
    expect(bs).toMatch(/rx="55.055" ry="55.055" fill="#1B4F9C"/); // 1.5 mm - 4 mil
    expect(count(bs, 'fill="#000000" stroke="#9A916C" stroke-width="10"')).toBe(2);

    const c = build({
      slug: "test-custom",
      title: "Custom",
      outline: { widthMm: 10, heightMm: 10, shape: "custom", pathMm: "M0 0 H10 V10 H0 Z" },
    });
    const cs = renderBreadboard(c.part, c.ctx);
    // the frame pads a custom outline by 4 mil on every side (half the board stroke)
    expect(cs).toContain('<g transform="translate(4 4)"><path d="M0 0 H393.701 V393.701 H0 Z"');
    // custom without a path falls back to a plain rect
    const f = build({
      slug: "test-custom2",
      title: "Custom",
      outline: { widthMm: 10, heightMm: 10, shape: "custom" },
    });
    // (the 4 mil custom-outline frame padding applies here too: 4 + half the 8 mil stroke)
    expect(renderBreadboard(f.part, f.ctx)).toContain('<rect x="8" y="8"');
  });

  it("embeds the photo as a wrapped base64 data URI with xlink", async () => {
    const { part, ctx } = photoFixture(0.8);
    const svg = renderBreadboard(part, ctx);
    assertHouseRules(svg, part);
    expect(svg).toContain(`xmlns:xlink="${XLINK_NS}"`);
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('opacity="0.8"');
    expect(svg).not.toContain("clipPath");
    const href = /xlink:href="([^"]*)"/.exec(svg)![1]!;
    expect(href.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = href.slice("data:image/png;base64,".length);
    const lines = b64.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l.length).toBe(60);
    expect(lines.join("")).toBe(TINY_PNG_B64);
    // the image covers exactly the outline rect
    const img = /<image[^>]*>/.exec(svg)![0];
    expect(numAttr(img, "width")).toBeCloseTo(1000, 3);
    expect(numAttr(img, "height")).toBeCloseTo(700, 3);
    // drawn after the board, before the header bodies
    expect(svg.indexOf("<image")).toBeGreaterThan(svg.indexOf('fill="#1B4F9C"'));
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf('fill="#404040"'));
    await expect(svg).toMatchFileSnapshot("__snapshots__/breadboard-photo.svg");
    // opacity 1 omits the attribute
    const full = photoFixture(1);
    expect(renderBreadboard(full.part, full.ctx)).not.toContain("opacity=");
  });
});

describe("empty pin label", () => {
  it('draws no breadboard label text for label ""', () => {
    const input = {
      ...FIXTURES.pads,
      pins: FIXTURES.pads.pins!.map((p) => (p.key === "vcc" ? { ...p, label: "" } : p)),
    };
    const { part, ctx } = build(input);
    const svg = renderBreadboard(part, ctx);
    expect(svg).not.toContain(">VCC</text>");
    expect(svg).toContain(">GND</text>");
    expect(tagWithId(svg, part.connectors.find((c) => c.key === "vcc")!.svgId)).toBeDefined();
  });
});

describe("renderBreadboardContent / helpers", () => {
  it("strips every id when ids is false", () => {
    const { part, ctx } = build(FIXTURES.esc);
    const withIds = renderBreadboardContent(part, ctx, { ids: true }).join("\n");
    const without = renderBreadboardContent(part, ctx, { ids: false }).join("\n");
    expect(withIds).toContain("id=");
    expect(without).not.toContain("id=");
    expect(without).toBe(withIds.replace(/ id="[^"]*"/g, ""));
  });

  it("extraNamespaces adds xlink only with a photo", () => {
    expect(extraNamespaces(build(FIXTURES.pads).ctx)).toEqual({});
    expect(extraNamespaces(photoFixture().ctx)).toEqual({ "xmlns:xlink": XLINK_NS });
  });

  it("group indents children and omits an undefined id", () => {
    expect(group("g1", ["<a/>", "<b/>"])).toBe('<g id="g1">\n  <a/>\n  <b/>\n</g>');
    expect(group(undefined, [], { transform: "scale(2)" })).toBe('<g transform="scale(2)"/>');
  });

  it("darkenHex darkens each channel and rejects bad input", () => {
    expect(darkenHex("#FFFFFF", 0.5)).toBe("#808080");
    expect(darkenHex("#1B7F3B")).toBe("#135929");
    expect(darkenHex("#000000")).toBe("#000000");
    expect(() => darkenHex("red")).toThrow();
  });

  it("scalePath scales absolute and relative commands", () => {
    expect(scalePath("M1,2 L3 4 h5 v-6 Z", 10)).toBe("M10 20 L30 40 h50 v-60 Z");
    expect(scalePath("m1 1 2 2 3 3z", 2)).toBe("m2 2 l4 4 l6 6 z");
    expect(scalePath("M1 1 2 2", 2)).toBe("M2 2 L4 4");
    expect(scalePath("C1 2 3 4 5 6 S1 1 2 2 Q1 1 2 2 T3 3", 2)).toBe(
      "C2 4 6 8 10 12 S2 2 4 4 Q2 2 4 4 T6 6",
    );
    expect(scalePath("M.5-.5 l1e1 0", 2)).toBe("M1 -1 l20 0");
  });

  it("scalePath keeps arc rotation and flags, including the compact flag form", () => {
    expect(scalePath("M0 0 A2 3 45 1 0 4 5", 10)).toBe("M0 0 A20 30 45 1 0 40 50");
    expect(scalePath("a1 1 30 015 5", 2)).toBe("a2 2 30 0 1 10 10");
    expect(scalePath("A1,1,0,1,1,2,2 1 1 0 0 0 3 3", 2)).toBe("A2 2 0 1 1 4 4 A2 2 0 0 0 6 6");
  });

  it("scalePath rejects malformed paths", () => {
    expect(() => scalePath("M1", 2)).toThrow(PathParseError);
    expect(() => scalePath("X1 2", 2)).toThrow(PathParseError);
    expect(() => scalePath("A1 1 0 2 0 1 1", 2)).toThrow(/arc flag/);
  });
});

// ---------------------------------------------------------------------------------
// Fritzing part checker over a complete .fzpz built from these SVGs.

const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

/** Minimal fzp: one connector per resolved connector, all four views. */
function minimalFzp(part: ResolvedPart, moduleId: string): string {
  const views = (["icon", "breadboard", "schematic", "pcb"] as const)
    .map((v) => {
      const layers =
        v === "pcb"
          ? ["copper0", "silkscreen", "copper1"]
          : [v === "icon" ? "icon" : v === "breadboard" ? "breadboard" : "schematic"];
      const img = `${v}/${moduleId}_${v}.svg`;
      return (
        `  <${v}View>\n   <layers image="${img}">\n` +
        layers.map((l) => `    <layer layerId="${l}"/>\n`).join("") +
        `   </layers>\n  </${v}View>\n`
      );
    })
    .join("");
  const conns = part.connectors
    .map((c) => {
      const bb = c.legId
        ? `<p layer="breadboard" svgId="${c.svgId}" legId="${c.legId}"/>`
        : `<p layer="breadboard" svgId="${c.svgId}" terminalId="${c.terminalId}"/>`;
      return (
        `  <connector id="${c.fzpId}" type="${c.type === "wire" ? "male" : c.type === "pad" ? "male" : c.type}" name="${c.name}">\n` +
        `   <description>${c.description}</description>\n   <views>\n` +
        `    <breadboardView>\n     ${bb}\n    </breadboardView>\n` +
        `    <schematicView>\n     <p layer="schematic" svgId="${c.svgId}" terminalId="${c.terminalId}"/>\n    </schematicView>\n` +
        `    <pcbView>\n     <p layer="copper0" svgId="${c.svgId}"/>\n     <p layer="copper1" svgId="${c.svgId}"/>\n    </pcbView>\n` +
        `   </views>\n  </connector>\n`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<module moduleId="${moduleId}" fritzingVersion="1.0.7">\n` +
    ` <version>1</version>\n <author>fritzkit</author>\n <title>${part.spec.title}</title>\n` +
    ` <label>A</label>\n <date>2026-10-31</date>\n <tags>\n  <tag>fritzkit</tag>\n </tags>\n` +
    ` <properties>\n  <property name="family">${part.spec.slug}</property>\n  <property name="variant">v1</property>\n </properties>\n` +
    ` <description>breadboard renderer checker fixture</description>\n <views>\n${views} </views>\n` +
    ` <connectors>\n${conns} </connectors>\n</module>\n`
  );
}

/** Spike-style schematic: one pin rect + 10 mil terminal per connector on the left. */
function stubSchematic(part: ResolvedPart): string {
  const n = part.connectors.length;
  const h = (n + 1) * 100;
  const rows = part.connectors
    .map((c, i) => {
      const y = 95 + i * 100;
      return (
        `    <rect id="${c.svgId}" x="0" y="${y}" width="200" height="10" fill="#555555" stroke="none"/>\n` +
        `    <rect id="${c.terminalId}" x="0" y="${y}" width="10" height="10" fill="#555555" stroke="none"/>\n`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="0.6in" height="${h / 1000}in" viewBox="0 0 600 ${h}">\n` +
    `  <g id="schematic">\n    <rect x="200" y="50" width="390" height="${h - 100}" fill="#FFFFFF" stroke="#000000" stroke-width="10"/>\n${rows}  </g>\n</svg>\n`
  );
}

/** Spike-style pcb: THT ring per connector in copper0 nested in copper1. */
function stubPcb(part: ResolvedPart): string {
  const n = part.connectors.length;
  const w = (n + 1) * 100;
  const pads = part.connectors
    .map(
      (c, i) =>
        `      <circle id="${c.svgId}" cx="${100 + i * 100}" cy="100" r="29" fill="none" stroke="#F7BD13" stroke-width="20"/>\n`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w / 1000}in" height="0.2in" viewBox="0 0 ${w} 200">\n` +
    `  <g id="silkscreen">\n    <rect x="5" y="5" width="${w - 10}" height="190" fill="none" stroke="#000000" stroke-width="10"/>\n  </g>\n` +
    `  <g id="copper1">\n    <g id="copper0">\n${pads}    </g>\n  </g>\n</svg>\n`
  );
}

describe("fzp checker on an assembled .fzpz", () => {
  for (const name of ["breakout", "pads", "esc", "castellated"] as const) {
    it.skipIf(!hasUv)(
      `${name}: breadboard and icon SVGs are checker-clean`,
      () => {
        const { part, ctx } = build(FIXTURES[name]);
        const id = ctx.identity;
        const names = fzpzEntryNames(id);
        expect(layerImage(id, "breadboard")).toBe(`breadboard/${id.baseName}_breadboard.svg`);
        const enc = new TextEncoder();
        const zip = zipSync({
          [names.fzp]: enc.encode(minimalFzp(part, id.moduleId)),
          [names.breadboard]: enc.encode(renderBreadboard(part, ctx)),
          [names.schematic]: enc.encode(stubSchematic(part)),
          [names.pcb]: enc.encode(stubPcb(part)),
          [names.icon]: enc.encode(renderIcon(part, ctx)),
        });
        const dir = mkdtempSync(join(tmpdir(), "fritzkit-bb-"));
        try {
          const file = join(dir, `${part.spec.slug}.fzpz`);
          writeFileSync(file, zip);
          const r = spawnSync("uv", ["run", "--project", "tools/fzp-checker", "check-fzp", file], {
            encoding: "utf8",
            env: { ...process.env, PYTHONUTF8: "1" },
          });
          const out = `${r.stdout}\n${r.stderr}`;
          const bbLines = out
            .split(/\r?\n/)
            .filter((l) => /_(breadboard|icon)\.svg/.test(l))
            .filter((l) => !l.includes("Checking SVG file") && !l.includes("CLEAN"));
          expect(bbLines, out).toEqual([]);
          expect(r.status, out).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
});
