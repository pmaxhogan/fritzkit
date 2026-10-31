import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildFzp, fzpDescription, fzpProperties } from "../src/core/compile/fzp.js";
import type { RenderContext } from "../src/core/compile/types.js";
import { fzpzEntryNames, identityFor } from "../src/core/identity.js";
import { resolvePart, type ResolvedPart } from "../src/core/resolve.js";
import { parsePartSpec, type PartSpec } from "../src/core/schema/part.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const DATE = "2026-10-31";

interface Built {
  part: ResolvedPart;
  ctx: RenderContext;
  xml: string;
}

function buildSpec(spec: PartSpec): Built {
  const part = resolvePart(spec);
  const ctx: RenderContext = { identity: identityFor(spec), date: DATE, generator: "fritzkit" };
  return { part, ctx, xml: buildFzp(part, ctx) };
}

function build(input: unknown): Built {
  return buildSpec(parsePartSpec(input));
}

const breakout = {
  slug: "generic-sensor-breakout",
  title: "Generic Sensor Breakout",
  label: "U",
  author: "Test Author",
  tags: ["sensor", "i2c"],
  description: "A small I2C sensor breakout.",
  sources: ["https://example.com/listing", "https://example.com/datasheet.pdf"],
  properties: { mpn: "GSB-01", chip: "XYZ123" },
  outline: { widthMm: 20, heightMm: 15 },
  pins: [
    { key: "vcc", name: "VCC", role: "power", xMm: 3, yMm: 13 },
    { key: "gnd", name: "GND", role: "gnd", xMm: 7, yMm: 13 },
    { key: "sda", name: "SDA", role: "i2c", xMm: 11, yMm: 13, description: "I2C data" },
    { key: "gnd2", name: "GND", role: "gnd", xMm: 15, yMm: 13 },
  ],
  buses: [{ id: "gnd", pins: ["gnd", "gnd2"] }],
};

const escPart = {
  slug: "brushless-esc-30a",
  title: "Brushless ESC 30A",
  outline: { widthMm: 45, heightMm: 25 },
  leads: [
    { key: "a", name: "Motor A", fromXMm: 45, fromYMm: 5, direction: "right" },
    { key: "b", name: "Motor B", fromXMm: 45, fromYMm: 12, direction: "right" },
    { key: "c", name: "Motor C", fromXMm: 45, fromYMm: 19, direction: "right" },
  ],
};

const castellated = {
  slug: "xiao-style-mcu",
  title: "XIAO-style MCU board",
  outline: { widthMm: 17.8, heightMm: 21 },
  headers: [
    {
      key: "left",
      kind: "castellated",
      cols: 3,
      orientation: "vertical",
      xMm: 0.8,
      yMm: 3,
      pins: [
        { key: "d0", name: "D0" },
        { key: "d1", name: "D1" },
        { key: "gnd", name: "GND", role: "gnd" },
      ],
    },
  ],
};

const spiced = {
  slug: "dual-aa-holder",
  title: "Dual AA Battery Holder",
  label: "VCC",
  properties: { voltage: "3V", "internal resistance": "0.2ohm" },
  outline: { widthMm: 30, heightMm: 60 },
  pins: [
    { key: "neg", name: "-", role: "gnd", xMm: 5, yMm: 55 },
    { key: "pos", name: "+", role: "power", xMm: 25, yMm: 55 },
  ],
  spice: {
    model: ".SUBCKT CELL 1 2\nR1 1 2 1k\n.ENDS",
    lines: [
      "V{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector0} DC {voltage}",
      "R{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector1} {internal resistance}",
    ],
  },
};

/** Matches the spike-vector SVGs in test/fixtures/spike-svgs (connector0 and connector1). */
const spike = {
  slug: "spike-vector",
  title: "Spike vector",
  label: "SP",
  outline: { widthMm: 48, heightMm: 20 },
  pins: [
    { key: "a", name: "A", xMm: 5, yMm: 10 },
    { key: "b", name: "B", xMm: 43, yMm: 10 },
  ],
};

describe("buildFzp", () => {
  it("writes the header, metadata, properties, views, connectors and buses in order", async () => {
    const { xml, ctx } = build(breakout);
    const id = ctx.identity.moduleId;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain(
      `<module moduleId="${id}" referenceFile="${id}.fzp" fritzingVersion="1.0.7">`,
    );
    const order = [
      "<version>1</version>",
      "<author>Test Author</author>",
      "<title>Generic Sensor Breakout</title>",
      "<label>U</label>",
      `<date>${DATE}</date>`,
      "<tags>",
      "<properties>",
      "<description>",
      "<views>",
      "<connectors>",
      "<buses>",
    ];
    let last = -1;
    for (const tag of order) {
      const i = xml.indexOf(tag);
      expect(i, tag).toBeGreaterThan(last);
      last = i;
    }
    expect(xml).not.toContain("<spice>");
    expect(xml).toContain("    <tag>sensor</tag>\n    <tag>i2c</tag>");
    expect(xml).toContain(
      `    <property name="family">generic-sensor-breakout</property>\n` +
        `    <property name="variant">${ctx.identity.variant}</property>\n` +
        `    <property name="chip">XYZ123</property>\n` +
        `    <property name="mpn">GSB-01</property>\n`,
    );
    expect(xml).toMatch(/<iconView>[\s\S]*<breadboardView>[\s\S]*<schematicView>[\s\S]*<pcbView>/);
    expect(xml).toContain(
      `<layers image="pcb/${id}_pcb.svg">\n` +
        `        <layer layerId="copper0"/>\n` +
        `        <layer layerId="copper1"/>\n` +
        `        <layer layerId="silkscreen"/>\n`,
    );
    expect(xml).toContain(`<layers image="icon/${id}_icon.svg">`);
    expect(xml).toContain(`<layers image="breadboard/${id}_breadboard.svg">`);
    expect(xml).toContain(`<layers image="schematic/${id}_schematic.svg">`);
    expect(xml).toContain(
      '    <bus id="gnd">\n' +
        '      <nodeMember connectorId="connector1"/>\n' +
        '      <nodeMember connectorId="connector3"/>\n' +
        "    </bus>\n",
    );
    expect(xml).toContain('<connector id="connector2" type="female" name="SDA">');
    expect(xml).toContain("<description>I2C data</description>");
    expect(xml).toContain(
      '<p layer="breadboard" svgId="connector0pin" terminalId="connector0terminal"/>',
    );
    expect(xml).toContain(
      '<p layer="schematic" svgId="connector0pin" terminalId="connector0terminal"/>',
    );
    expect(xml).toContain(
      '<p layer="copper0" svgId="connector0pin"/>\n          <p layer="copper1" svgId="connector0pin"/>',
    );
    expect(xml.endsWith("</module>\n")).toBe(true);
    expect(xml).not.toContain("\r");
    expect(xml).not.toContain("\t");
    await expect(xml).toMatchFileSnapshot("__snapshots__/fzp-breakout.fzp");
  });

  it("is deterministic", () => {
    expect(build(breakout).xml).toBe(build(breakout).xml);
  });

  it("writes connectors in id order", () => {
    const { xml } = build({ ...breakout, pinIds: { vcc: 3, gnd: 2, sda: 1, gnd2: 0 } });
    const ids = [...xml.matchAll(/<connector id="(connector\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["connector0", "connector1", "connector2", "connector3"]);
  });

  it("uses legId instead of terminalId on the breadboard for wire leads", async () => {
    const { xml } = build(escPart);
    ["A", "B", "C"].forEach((letter, n) => {
      expect(xml).toContain(`<connector id="connector${n}" type="male" name="Motor ${letter}">`);
      expect(xml).toContain(
        `<p layer="breadboard" svgId="connector${n}pin" legId="connector${n}leg"/>`,
      );
      expect(xml).toContain(
        `<p layer="schematic" svgId="connector${n}pin" terminalId="connector${n}terminal"/>`,
      );
    });
    expect(xml).not.toMatch(/<breadboardView>\s*<p [^>]*terminalId/);
    expect(xml).not.toContain("<buses>");
    await expect(xml).toMatchFileSnapshot("__snapshots__/fzp-esc.fzp");
  });

  it("lists copper1 only for an SMD-only part", async () => {
    const { xml, part, ctx } = build(castellated);
    expect(part.hasTht).toBe(false);
    expect(xml).toContain(
      `<layers image="pcb/${ctx.identity.moduleId}_pcb.svg">\n` +
        `        <layer layerId="copper1"/>\n` +
        `        <layer layerId="silkscreen"/>\n` +
        `      </layers>`,
    );
    expect(xml).not.toContain("copper0");
    for (const n of [0, 1, 2]) {
      expect(xml).toContain(
        `<pcbView>\n          <p layer="copper1" svgId="connector${n}pin"/>\n        </pcbView>`,
      );
      expect(xml).toContain(`<connector id="connector${n}" type="pad"`);
    }
    expect(xml).toContain("  <tags/>\n");
    await expect(xml).toMatchFileSnapshot("__snapshots__/fzp-castellated.fzp");
  });

  it("writes a spice block with model and lines after the description", async () => {
    const { xml } = build(spiced);
    expect(xml).toContain(
      "  <spice>\n" +
        "    <model>.SUBCKT CELL 1 2\nR1 1 2 1k\n.ENDS</model>\n" +
        "    <line>V{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector0} DC {voltage}</line>\n" +
        "    <line>R{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector1} {internal resistance}</line>\n" +
        "  </spice>\n  <views>",
    );
    expect(xml.indexOf("</description>")).toBeLessThan(xml.indexOf("<spice>"));
    expect(xml).toContain('<property name="internal resistance">0.2ohm</property>');
    expect(xml).toContain('<connector id="connector0" type="female" name="-">');
    await expect(xml).toMatchFileSnapshot("__snapshots__/fzp-spice.fzp");
  });

  it("omits <model> when the spice block has only lines", () => {
    const { xml } = build({ ...spiced, spice: { lines: ["R{instanceTitle} 1 2 1k"] } });
    expect(xml).toContain("  <spice>\n    <line>R{instanceTitle} 1 2 1k</line>\n  </spice>\n");
    expect(xml).not.toContain("<model>");
  });

  it("skips empty property values and never duplicates family/variant", () => {
    const spec = parsePartSpec(breakout);
    spec.properties = { blank: "", spaces: "   ", family: "other", Variant: "x", keep: "yes" };
    const { part, ctx, xml } = buildSpec(spec);
    expect(fzpProperties(part, ctx).map(([k]) => k)).toEqual(["family", "variant", "keep"]);
    expect(xml).not.toContain('name="blank"');
    expect(xml).not.toContain('name="spaces"');
    expect(xml.match(/name="family"/g)).toHaveLength(1);
    expect(xml.match(/name="variant"/gi)).toHaveLength(1);
  });

  it("escapes XML special characters in text and attributes", () => {
    const { xml } = build({
      ...breakout,
      title: 'A & B <C> "D"',
      author: "Me & You",
      tags: ["<tag>"],
      properties: { 'odd "name"': "x < y & z" },
      pins: [{ key: "p", name: 'P<1>&"', xMm: 1, yMm: 1, description: "a > b" }],
      buses: [],
    });
    expect(xml).toContain("<title>A &amp; B &lt;C&gt; &quot;D&quot;</title>");
    expect(xml).toContain("<author>Me &amp; You</author>");
    expect(xml).toContain("<tag>&lt;tag&gt;</tag>");
    expect(xml).toContain('<property name="odd &quot;name&quot;">x &lt; y &amp; z</property>');
    expect(xml).toContain('name="P&lt;1&gt;&amp;&quot;"');
    expect(xml).toContain("<description>a &gt; b</description>");
    expect(xml).toContain("(c) 2026 Me &amp; You");
  });

  it("passes non-ASCII spec text through unchanged", () => {
    const { xml } = build({ ...breakout, title: "Sensor \u00b5A \u2126", buses: [] });
    expect(xml).toContain("<title>Sensor \u00b5A \u2126</title>");
  });
});

describe("fzpDescription", () => {
  it("appends sources and the notice", () => {
    const { part, ctx } = build(breakout);
    expect(fzpDescription(part, ctx)).toBe(
      "A small I2C sensor breakout.\n\n" +
        "Sources:\nhttps://example.com/listing\nhttps://example.com/datasheet.pdf\n\n" +
        "Generated by fritzkit (https://github.com/pmaxhogan/fritzkit). Part artwork and data " +
        "(c) 2026 Test Author, licensed CC-BY-SA 3.0 like the Fritzing parts library.",
    );
  });

  it("is just the notice when there is no description or source", () => {
    const { part, ctx } = build(escPart);
    expect(fzpDescription(part, ctx)).toBe(
      "Generated by fritzkit (https://github.com/pmaxhogan/fritzkit). Part artwork and data " +
        "(c) 2026 fritzkit, licensed CC-BY-SA 3.0 like the Fritzing parts library.",
    );
  });

  it("names the generator from the render context", () => {
    const { part, ctx } = build(escPart);
    expect(fzpDescription(part, { ...ctx, generator: "fritzkit 9.9.9" })).toMatch(
      /^Generated by fritzkit 9\.9\.9 \(https:/,
    );
  });

  it("normalises CRLF in the spec description", () => {
    const { part, ctx } = build({ ...escPart, description: "line 1\r\nline 2" });
    expect(fzpDescription(part, ctx).startsWith("line 1\nline 2\n\nGenerated")).toBe(true);
  });
});

const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

describe("fzp checker", () => {
  it("matches the spike fixture snapshot", async () => {
    await expect(build(spike).xml).toMatchFileSnapshot("__snapshots__/fzp-spike.fzp");
  });

  (hasUv ? it : it.skip)(
    "accepts the fzp zipped with the spike-vector SVGs",
    async () => {
      const { xml, ctx } = build(spike);
      const names = fzpzEntryNames(ctx.identity);
      const svg = (v: string) =>
        new Uint8Array(readFileSync(join(here, "fixtures", "spike-svgs", `${v}.svg`)));
      // The vendored checker only resolves schematic terminalIds, so check every id the
      // fzp references against the view SVG it belongs to.
      const viewSvg: Record<string, string> = {
        breadboardView: "breadboard",
        schematicView: "schematic",
        pcbView: "pcb",
      };
      let refs = 0;
      for (const m of xml.matchAll(/<(\w+View)>\s*((?:<p [^>]*\/>\s*)+)<\/\1>/g)) {
        const text = new TextDecoder().decode(svg(viewSvg[m[1]!]!));
        for (const ref of m[2]!.matchAll(/(?:svgId|terminalId|legId)="([^"]+)"/g)) {
          expect(text, `${m[1]} ${ref[1]}`).toContain(`id="${ref[1]}"`);
          refs++;
        }
      }
      expect(refs).toBe(12);
      const zip = zipSync({
        [names.fzp]: new TextEncoder().encode(xml),
        [names.breadboard]: svg("breadboard"),
        [names.schematic]: svg("schematic"),
        [names.pcb]: svg("pcb"),
        [names.icon]: svg("icon"),
      });
      const dir = mkdtempSync(join(tmpdir(), "fritzkit-fzp-"));
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
