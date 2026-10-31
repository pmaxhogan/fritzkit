import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { renderPcb, ringGeometry } from "../src/core/compile/pcb.js";
import { STYLE } from "../src/core/compile/style.js";
import { layerIdsFor, type RenderContext } from "../src/core/compile/types.js";
import {
  fzpzEntryNames,
  identityFor,
  layerImage,
  type PartIdentity,
} from "../src/core/identity.js";
import { resolvePart, type ResolvedPart } from "../src/core/resolve.js";
import { parsePartSpec, type PartSpecInput } from "../src/core/schema/part.js";
import { formatIn } from "../src/core/svg.js";
import { mmToMil } from "../src/core/units.js";

const DATE = "2026-10-31";

function build(input: PartSpecInput): { part: ResolvedPart; ctx: RenderContext; svg: string } {
  const spec = parsePartSpec(input);
  const part = resolvePart(spec);
  const ctx: RenderContext = { identity: identityFor(spec), date: DATE, generator: "fritzkit" };
  return { part, ctx, svg: renderPcb(part, ctx) };
}

/** Inner text of the element <tag id="id" ...>...</tag> (first match, nesting-aware for <g>). */
function group(svg: string, id: string): string {
  const open = svg.indexOf(`<g id="${id}">`);
  if (open < 0) return "";
  let depth = 0;
  const re = /<g\b[^>]*?(\/?)>|<\/g>/g;
  re.lastIndex = open;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (m[0] === "</g>") {
      depth--;
      if (depth === 0) return svg.slice(open, m.index + 4);
    } else if (m[1] !== "/") depth++;
  }
  throw new Error(`unterminated group ${id}`);
}

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

/** Every element carrying a copper colour must sit inside the copper1 group. */
function copperOutsideCopperGroups(svg: string): number {
  const c1 = group(svg, "copper1");
  return count(svg.replace(c1, ""), /#F7BD13/g);
}

function attrNum(tag: string, name: string): number {
  const m = new RegExp(` ${name}="([^"]+)"`).exec(tag);
  if (!m) throw new Error(`no ${name} in ${tag}`);
  return Number(m[1]);
}

function tagWithId(svg: string, id: string): string[] {
  return svg.match(new RegExp(`<[a-z]+ id="${id}"[^>]*/>`, "g")) ?? [];
}

const header1x7: PartSpecInput = {
  slug: "generic-1x7-breakout",
  title: "Generic 1x7 breakout",
  outline: { widthMm: 20, heightMm: 12, shape: "rounded", cornerRadiusMm: 1, holes: [] },
  headers: [
    {
      key: "J1",
      kind: "male",
      cols: 7,
      xMm: 2.38,
      yMm: 9.5,
      pins: ["VCC", "GND", "SCL", "SDA", "INT", "RST", "EN"].map((n) => ({
        key: n.toLowerCase(),
        name: n,
      })),
    },
  ],
};

const castellated2x7: PartSpecInput = {
  slug: "xiao-style-mcu",
  title: "XIAO-style castellated MCU board",
  outline: { widthMm: 17.8, heightMm: 21, shape: "rounded", cornerRadiusMm: 2 },
  headers: [
    {
      key: "L",
      kind: "castellated",
      cols: 7,
      orientation: "vertical",
      xMm: 0.8,
      yMm: 2.88,
      pins: Array.from({ length: 7 }, (_, i) => ({ key: `d${i}`, name: `D${i}` })),
    },
    {
      key: "R",
      kind: "castellated",
      cols: 7,
      orientation: "vertical",
      xMm: 17.0,
      yMm: 2.88,
      pins: Array.from({ length: 7 }, (_, i) => ({ key: `d${i + 7}`, name: `D${i + 7}` })),
    },
  ],
};

const freePads: PartSpecInput = {
  slug: "free-pads",
  title: "Free-standing pads",
  outline: {
    widthMm: 30,
    heightMm: 15,
    shape: "rect",
    holes: [{ xMm: 27, yMm: 3, dMm: 3 }],
  },
  pins: [
    {
      key: "a",
      name: "A",
      xMm: 5,
      yMm: 7.5,
      pad: { shape: "rect", wMm: 2, hMm: 3.2, holeMm: 1.3 },
    },
    {
      key: "b",
      name: "B",
      xMm: 12,
      yMm: 7.5,
      pad: { shape: "round", wMm: 1.8, hMm: 1.8, holeMm: 0.9 },
    },
    { key: "c", name: "C", xMm: 20, yMm: 7.5, pad: { shape: "oval", wMm: 1.2, hMm: 2.4 } },
  ],
};

const escLeads: PartSpecInput = {
  slug: "generic-esc",
  title: "Generic ESC with wire leads",
  outline: { widthMm: 40, heightMm: 20, shape: "rect" },
  leads: [
    {
      key: "vin",
      name: "VIN",
      role: "power",
      color: "#D00000",
      fromXMm: 0,
      fromYMm: 4,
      lengthMm: 30,
      gaugeMm: 2.5,
    },
    { key: "gnd", name: "GND", role: "gnd", fromXMm: 0, fromYMm: 16, lengthMm: 30, gaugeMm: 2.5 },
    { key: "ma", name: "A", fromXMm: 40, fromYMm: 4, direction: "right", lengthMm: 20 },
    { key: "mb", name: "B", fromXMm: 40, fromYMm: 10, direction: "right", lengthMm: 20 },
    {
      key: "mc",
      name: "C",
      fromXMm: 40,
      fromYMm: 16,
      direction: "right",
      lengthMm: 20,
      gaugeMm: 0.5,
    },
  ],
};

describe("ringGeometry", () => {
  it("uses the pad and drill when they are generous", () => {
    const r = ringGeometry(2.54, 2.54, 1.2);
    expect(r.holeR).toBeCloseTo(mmToMil(0.6), 9);
    expect(r.padR).toBeCloseTo(50, 9);
    expect(r.r).toBeCloseTo((r.holeR + r.padR) / 2, 9);
    expect(r.strokeWidth).toBeCloseTo(r.padR - r.holeR, 9);
  });

  it("clamps the drill and grows the pad to keep the minimum ring", () => {
    const r = ringGeometry(0.5, 0.5, 0.2);
    expect(r.holeR).toBe(STYLE.pcb.minHoleMil / 2);
    expect(r.strokeWidth).toBeCloseTo(STYLE.pcb.minRingMil, 9);
    const none = ringGeometry(2, 2, undefined);
    expect(none.holeR).toBe(STYLE.pcb.minHoleMil / 2);
  });
});

describe("renderPcb", () => {
  it("1x7 male header: 7 rings nested in copper0 inside copper1, ids unique", async () => {
    const { part, svg } = build(header1x7);
    expect(part.hasTht).toBe(true);
    const c1 = group(svg, "copper1");
    const c0 = group(svg, "copper0");
    expect(c0).not.toBe("");
    expect(c1).toContain(c0); // copper0 nested in copper1
    expect(count(c0, /<circle /g)).toBe(7);
    for (let i = 0; i < 7; i++) {
      const tags = tagWithId(svg, `connector${i}pin`);
      expect(tags).toHaveLength(1); // once in the file: nesting puts it in both layers
      const t = tags[0]!;
      expect(c0).toContain(t);
      expect(t).toContain('stroke="#F7BD13"');
      expect(t).toContain('fill="none"');
      const r = attrNum(t, "r");
      const sw = attrNum(t, "stroke-width");
      const holeR = r - sw / 2;
      expect(2 * holeR).toBeGreaterThanOrEqual(STYLE.pcb.minHoleMil - 0.01);
      expect(sw).toBeGreaterThanOrEqual(STYLE.pcb.minRingMil - 0.01);
    }
    // first ring sits on the 100 mil grid (header seating)
    const t0 = tagWithId(svg, "connector0pin")[0]!;
    expect(attrNum(t0, "cx") % 100).toBeCloseTo(0, 2);
    expect(attrNum(t0, "cy") % 100).toBeCloseTo(0, 2);
    // ids are unique across the whole file
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of layerIdsFor("pcb", part.hasTht)) expect(svg).toContain(`id="${id}"`);
    expect(copperOutsideCopperGroups(svg)).toBe(0);
    // silkscreen first, with the rounded outline
    expect(svg.indexOf('<g id="silkscreen">')).toBeLessThan(svg.indexOf('<g id="copper1">'));
    const silk = group(svg, "silkscreen");
    expect(silk).toMatch(/<rect [^>]*rx="39.37"[^>]*stroke="#000000" stroke-width="8"\/>/);
    expect(silk).not.toContain("<text");
    // root size = breadboard frame
    expect(svg).toContain(`width="${formatIn(part.frame.widthMm / 25.4)}in"`);
    expect(svg).toContain(`height="${formatIn(part.frame.heightMm / 25.4)}in"`);
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-header-1x7.svg");
  });

  it("castellated 2x7: no copper0 group, 14 SMD rects in copper1", async () => {
    const { part, svg } = build(castellated2x7);
    expect(part.hasTht).toBe(false);
    expect(svg).not.toContain("copper0");
    const c1 = group(svg, "copper1");
    expect(count(c1, /<rect id="connector\d+pin"[^>]*fill="#F7BD13"/g)).toBe(14);
    expect(count(svg, /<circle /g)).toBe(0);
    for (const id of layerIdsFor("pcb", part.hasTht)) expect(svg).toContain(`id="${id}"`);
    expect(copperOutsideCopperGroups(svg)).toBe(0);
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-castellated-2x7.svg");
  });

  it("free-standing pads: oblong THT gets ring + copper rect, round THT ring, SMD oval", async () => {
    const { part, svg } = build(freePads);
    const c0 = group(svg, "copper0");
    const c1 = group(svg, "copper1");
    // pad a: 2 x 3.2 mm rect, 1.3 mm hole
    const a = tagWithId(svg, "connector0pin");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatch(/^<circle /);
    const ar = attrNum(a[0]!, "r");
    const asw = attrNum(a[0]!, "stroke-width");
    expect(2 * (ar - asw / 2)).toBeCloseTo(mmToMil(1.3), 2);
    expect(
      count(c0, /<rect x="[^"]+" y="[^"]+" width="78.74" height="125.984" fill="#F7BD13"/g),
    ).toBe(1);
    // pad b: round THT, ring only
    expect(tagWithId(svg, "connector1pin")[0]).toMatch(/^<circle /);
    expect(count(c0, /<rect /g)).toBe(1);
    expect(count(c0, /<circle /g)).toBe(2);
    // pad c: SMD oval in copper1 (outside copper0)
    const c = tagWithId(svg, "connector2pin");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/^<rect [^>]*rx="23.622"[^>]*fill="#F7BD13"/);
    expect(c0).not.toContain(c[0]);
    expect(c1.replace(c0, "")).toContain(c[0]);
    // mounting hole on silkscreen
    const silk = group(svg, "silkscreen");
    expect(silk).toMatch(/<circle [^>]*r="59.055"[^>]*stroke="#000000"/);
    expect(silk).toMatch(/<rect (?![^>]*rx)/); // plain rect outline
    expect(copperOutsideCopperGroups(svg)).toBe(0);
    expect(part.hasTht).toBe(true);
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-free-pads.svg");
  });

  it("ESC leads: rings at the board attachment point, not the free end", async () => {
    const { part, svg } = build(escLeads);
    const c0 = group(svg, "copper0");
    expect(count(c0, /<circle /g)).toBe(5);
    for (const c of part.connectors) {
      const t = tagWithId(svg, c.svgId)[0]!;
      const fromX = mmToMil(c.lead!.fromXMm + part.frame.offsetXMm);
      const fromY = mmToMil(c.lead!.fromYMm + part.frame.offsetYMm);
      expect(attrNum(t, "cx")).toBeCloseTo(fromX, 2);
      expect(attrNum(t, "cy")).toBeCloseTo(fromY, 2);
      const endX = mmToMil(c.xMm + part.frame.offsetXMm);
      expect(Math.abs(attrNum(t, "cx") - endX)).toBeGreaterThan(100);
      const sw = attrNum(t, "stroke-width");
      const hole = 2 * (attrNum(t, "r") - sw / 2);
      expect(hole).toBeGreaterThanOrEqual(STYLE.pcb.minHoleMil - 0.01);
      expect(hole).toBeCloseTo(Math.max(mmToMil(c.lead!.gaugeMm * 0.6), STYLE.pcb.minHoleMil), 2);
      expect(sw).toBeGreaterThanOrEqual(STYLE.pcb.minRingMil - 0.01);
    }
    expect(count(c0, /<rect /g)).toBe(0);
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-esc-leads.svg");
  });

  it('mode "smd" forces every pad SMD (leads at the from-point)', async () => {
    const { part, svg } = build({ ...freePads, slug: "free-pads-smd", pcb: { mode: "smd" } });
    expect(part.hasTht).toBe(false);
    expect(svg).not.toContain("copper0");
    expect(count(group(svg, "copper1"), /<rect id="connector\d+pin"/g)).toBe(3);
    const esc = build({ ...escLeads, slug: "generic-esc-smd", pcb: { mode: "smd" } });
    for (const c of esc.part.connectors) {
      const t = tagWithId(esc.svg, c.svgId)[0]!;
      const w = attrNum(t, "width");
      expect(attrNum(t, "x") + w / 2).toBeCloseTo(
        mmToMil(c.lead!.fromXMm + esc.part.frame.offsetXMm),
        2,
      );
    }
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-mode-smd.svg");
  });

  it('mode "tht" forces rings even for castellated pads', async () => {
    const { part, svg } = build({
      ...castellated2x7,
      slug: "xiao-style-tht",
      pcb: { mode: "tht" },
    });
    expect(part.hasTht).toBe(true);
    const c0 = group(svg, "copper0");
    expect(count(c0, /<circle id="connector\d+pin"/g)).toBe(14);
    // 1.6 x 2.4 mm rect pads are oblong (ratio 1.5): copper rect under each ring
    expect(count(c0, /<rect /g)).toBe(14);
    expect(count(svg, /<rect id=/g)).toBe(0);
    await expect(svg).toMatchFileSnapshot("__snapshots__/pcb-mode-tht.svg");
  });

  it("custom outline path is mapped with translate+scale; silkscreen can be turned off", async () => {
    const custom = build({
      ...freePads,
      slug: "free-pads-custom",
      outline: { widthMm: 30, heightMm: 15, shape: "custom", pathMm: "M0 0 H30 V15 H0 Z" },
    });
    const silk = group(custom.svg, "silkscreen");
    expect(silk).toMatch(/<g transform="translate\([-\d.]+ [-\d.]+\) scale\(39.37\)">/);
    expect(silk).toContain('d="M0 0 H30 V15 H0 Z"');
    expect(silk).toContain('stroke-width="0.203"');
    await expect(custom.svg).toMatchFileSnapshot("__snapshots__/pcb-custom-outline.svg");

    const off = build({ ...freePads, slug: "free-pads-nosilk", pcb: { silkscreenOutline: false } });
    expect(off.svg).toContain('<g id="silkscreen"/>');
    expect(off.svg).not.toContain('stroke="#000000"');
  });

  it("is deterministic and ASCII only", () => {
    const a = build(header1x7).svg;
    const b = build(header1x7).svg;
    expect(a).toBe(b);
    expect([...a].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fritzing part checker on a minimal .fzpz built around each fixture's pcb SVG.

const REPO = resolvePath(import.meta.dirname, "..");
const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
const hasUv = !uv.error && uv.status === 0;

function trivialSvg(layer: string, part: ResolvedPart): string {
  const w = mmToMil(part.frame.widthMm);
  const h = mmToMil(part.frame.heightMm);
  const pins = part.connectors
    .map(
      (c, i) =>
        `<rect id="${c.svgId}" x="${20 + i * 100}" y="20" width="60" height="60" fill="#9A916C" stroke="none"/>` +
        `<rect id="${c.terminalId}" x="${45 + i * 100}" y="45" width="10" height="10" fill="#9A916C" stroke="none"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w / 1000}in" height="${h / 1000}in" viewBox="0 0 ${w} ${h}">\n` +
    `<g id="${layer}"><rect x="0" y="0" width="${w}" height="${h}" fill="#1B7F3B" stroke="none"/>${layer === "icon" ? "" : pins}</g>\n</svg>\n`
  );
}

function minimalFzp(id: PartIdentity, part: ResolvedPart): string {
  const conns = part.connectors
    .map(
      (c) => ` <connector id="${c.fzpId}" type="male" name="${c.name}">
   <description>${c.name} pin</description>
   <views>
    <breadboardView>
     <p layer="breadboard" svgId="${c.svgId}" terminalId="${c.terminalId}"/>
    </breadboardView>
    <schematicView>
     <p layer="schematic" svgId="${c.svgId}" terminalId="${c.terminalId}"/>
    </schematicView>
    <pcbView>
${c.tht ? `     <p layer="copper0" svgId="${c.svgId}"/>\n` : ""}     <p layer="copper1" svgId="${c.svgId}"/>
    </pcbView>
   </views>
  </connector>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<module moduleId="${id.moduleId}" fritzingVersion="1.0.7">
 <version>1</version>
 <author>fritzkit</author>
 <title>${part.spec.title}</title>
 <label>A</label>
 <date>${DATE}</date>
 <tags>
  <tag>fritzkit</tag>
 </tags>
 <properties>
  <property name="family">${id.family}</property>
  <property name="variant">${id.variant}</property>
 </properties>
 <description>pcb renderer checker fixture</description>
 <views>
  <iconView>
   <layers image="${layerImage(id, "icon")}">
    <layer layerId="icon"/>
   </layers>
  </iconView>
  <breadboardView>
   <layers image="${layerImage(id, "breadboard")}">
    <layer layerId="breadboard"/>
   </layers>
  </breadboardView>
  <schematicView>
   <layers image="${layerImage(id, "schematic")}">
    <layer layerId="schematic"/>
   </layers>
  </schematicView>
  <pcbView>
   <layers image="${layerImage(id, "pcb")}">
${part.hasTht ? '    <layer layerId="copper0"/>\n' : ""}    <layer layerId="silkscreen"/>
    <layer layerId="copper1"/>
   </layers>
  </pcbView>
 </views>
 <connectors>
${conns}
 </connectors>
</module>
`;
}

const checkerFixtures: [string, PartSpecInput][] = [
  ["1x7 header (round THT)", header1x7],
  ["castellated 2x7 (SMD only, no copper0)", castellated2x7],
  [
    "custom outline (transform wrapper, oblong THT copper rect, SMD oval)",
    {
      ...freePads,
      slug: "free-pads-custom",
      outline: { widthMm: 30, heightMm: 15, shape: "custom", pathMm: "M0 0 H30 V15 H0 Z" },
    },
  ],
];

describe("fzp checker", () => {
  it.skipIf(!hasUv).each(checkerFixtures)(
    "accepts the %s pcb svg (no pcb errors)",
    (_name, input) => {
      const { part, ctx, svg } = build(input);
      const id = ctx.identity;
      const names = fzpzEntryNames(id);
      const enc = new TextEncoder();
      const zip = zipSync({
        [names.fzp]: enc.encode(minimalFzp(id, part)),
        [names.breadboard]: enc.encode(trivialSvg("breadboard", part)),
        [names.schematic]: enc.encode(trivialSvg("schematic", part)),
        [names.pcb]: enc.encode(svg),
        [names.icon]: enc.encode(trivialSvg("icon", part)),
      });
      const dir = mkdtempSync(join(tmpdir(), "fritzkit-pcb-"));
      try {
        const file = join(dir, `${id.moduleId}.fzpz`);
        writeFileSync(file, zip);
        const res = spawnSync("uv", ["run", "--project", "tools/fzp-checker", "check-fzp", file], {
          cwd: REPO,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1" },
        });
        const out = `${res.stdout}\n${res.stderr}`;
        const lines = out.split(/\r?\n/);
        const pcbErrors = lines.filter((l) => /error/i.test(l) && /_pcb\.svg/.test(l));
        expect(pcbErrors, out).toEqual([]);
        expect(res.status, out).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
