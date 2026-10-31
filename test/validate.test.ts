import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { compilePart } from "../src/core/compile/index.js";
import type { CompiledPart, View } from "../src/core/compile/types.js";
import { parsePartSpec, type PartSpecInput } from "../src/core/schema/part.js";
import { breakoutInput, FIXTURES as SPEC_FIXTURES, TINY_PNG_B64 } from "./breadboard-fixtures.js";
import {
  entriesToInput,
  entryNameForImage,
  explain,
  explainCheckerLine,
  formatIssues,
  parseFzp,
  parseSvg,
  validateCompiled,
  validateFzpzBytes,
  validateFzpzFile,
  validateSpecJson,
  type Issue,
  type ValidateInput,
} from "../src/core/validate/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "validate");
const ID = "fritzkit-spike-vector-00000001";

function loadFixture(name: string): ValidateInput {
  const dir = join(FIXTURES, name);
  const entries = readdirSync(dir)
    .sort()
    .map((f) => ({ name: f, data: new Uint8Array(readFileSync(join(dir, f))) }));
  return entriesToInput(entries);
}

const base = loadFixture("spike-vector");

// Compile-time contract check: a CompiledPart must be accepted by validateCompiled.
export const _compiledIsInput = (c: CompiledPart): ValidateInput => c;

type Mut = {
  fzp?: (s: string) => string;
  svg?: Partial<Record<View, (s: string) => string>>;
  entries?: (e: ValidateInput["entries"]) => ValidateInput["entries"];
};

function mutate(m: Mut): ValidateInput {
  const svgs: Partial<Record<View, string>> = { ...base.svgs };
  for (const [v, fn] of Object.entries(m.svg ?? {}) as [View, (s: string) => string][]) {
    const before = svgs[v] ?? "";
    const after = fn(before);
    expect(after, `mutation of ${v} svg did nothing`).not.toBe(before);
    svgs[v] = after;
  }
  const fzp = m.fzp ? m.fzp(base.fzp) : base.fzp;
  if (m.fzp) expect(fzp, "fzp mutation did nothing").not.toBe(base.fzp);
  return { fzp, svgs, entries: m.entries ? m.entries(base.entries) : base.entries };
}

const errorCodes = (issues: Issue[]) =>
  [...new Set(issues.filter((i) => i.level === "error").map((i) => i.code))].sort();

describe("structural validator on the known-good fixtures", () => {
  it("spike-vector has no issues", () => {
    expect(validateCompiled(base)).toEqual([]);
  });

  it("spike-photo (embedded PNG in breadboard) has no issues", () => {
    expect(validateCompiled(loadFixture("spike-photo"))).toEqual([]);
  });

  it("a data: image in the icon (photo-style icon) is accepted", () => {
    const issues = validateCompiled(
      mutate({
        svg: {
          icon: (s) =>
            s.replace(
              '<g id="icon">',
              '<g id="icon"><image width="10" height="10" href="data:image/png;base64,AAAA"/>',
            ),
        },
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe("structural validator on real compiler output", () => {
  const png = new Uint8Array(Buffer.from(TINY_PNG_B64, "base64"));
  const specs: [string, PartSpecInput][] = [
    ...Object.entries(SPEC_FIXTURES),
    [
      "custom outline",
      {
        slug: "test-custom",
        title: "Custom outline",
        outline: { widthMm: 20, heightMm: 10, shape: "custom", pathMm: "M0 0 L20 0 L20 10 L0 5 Z" },
        pins: [{ key: "a", name: "A", xMm: 3, yMm: 3 }],
      },
    ],
    [
      "photo",
      {
        ...breakoutInput,
        slug: "test-breakout-photo",
        artwork: { ...breakoutInput.artwork, style: "photo", photo: { src: "assets/top.png" } },
      },
    ],
  ];
  for (const [name, input] of specs) {
    it(`${name} validates with no errors`, async () => {
      const c = await compilePart(parsePartSpec(input), {
        date: "2026-10-31",
        assets: new Map([["assets/top.png", png]]),
        preparePhoto: () => Promise.resolve({ png, widthPx: 3, heightPx: 2, opacity: 0.8 }),
      });
      expect(c.warnings).toEqual([]);
      const issues = validateCompiled(c);
      expect(errorCodes(issues), formatIssues(issues)).toEqual([]);
    });
  }
});

describe("mutations trigger exactly the expected error code", () => {
  const cases: [string, Mut, string][] = [
    [
      "missing svg entry",
      { entries: (e) => e.filter((x) => !x.name.startsWith("svg.schematic.")) },
      "zip-entries",
    ],
    [
      "mismatched image name",
      {
        fzp: (s) => s.replace(`breadboard/${ID}_breadboard.svg`, `breadboard/${ID}_breadbord.svg`),
      },
      "zip-entries",
    ],
    [
      "style attribute",
      { svg: { breadboard: (s) => s.replace('fill="#1B7F3B"', 'style="fill:#1B7F3B"') } },
      "svg-style",
    ],
    [
      "tspan",
      {
        svg: {
          breadboard: (s) => s.replace(">vector</text>", "><tspan>vector</tspan></text>"),
        },
      },
      "svg-style",
    ],
    [
      "Arial font",
      { svg: { schematic: (s) => s.replace('font-family="Noto Sans"', 'font-family="Arial"') } },
      "svg-style",
    ],
    [
      "unitless root",
      { svg: { pcb: (s) => s.replace('width="1.8898in"', 'width="1.8898"') } },
      "svg-root",
    ],
    [
      "gorn attribute",
      {
        svg: {
          breadboard: (s) => s.replace('<g id="breadboard">', '<g id="breadboard" gorn="0.1">'),
        },
      },
      "svg-style",
    ],
    [
      "duplicate connector id",
      { fzp: (s) => s.replace('<connector id="connector1"', '<connector id="connector0"') },
      "connector-numbering",
    ],
    [
      "bus referencing a missing connector",
      {
        fzp: (s) =>
          s.replace(
            " </connectors>",
            ' </connectors>\n <buses>\n  <bus id="gnd">\n   <nodeMember connectorId="connector0"/>\n   <nodeMember connectorId="connector9"/>\n  </bus>\n </buses>',
          ),
      },
      "buses",
    ],
    [
      "terminal with zero size",
      {
        svg: {
          breadboard: (s) =>
            s.replace(
              'id="connector0terminal" x="191.85" y="388.7" width="10"',
              'id="connector0terminal" x="191.85" y="388.7" width="0"',
            ),
        },
      },
      "connector-refs",
    ],
    [
      "legId on a non-line",
      {
        fzp: (s) =>
          s.replace(
            '<p layer="breadboard" svgId="connector0pin" terminalId="connector0terminal"/>',
            '<p layer="breadboard" svgId="connector0pin" legId="connector0terminal"/>',
          ),
      },
      "connector-refs",
    ],
    [
      "copper0 missing while a connector lists it",
      { fzp: (s) => s.replace('    <layer layerId="copper0"/>\n', "") },
      "pcb-layers",
    ],
    [
      "spice referencing connector9",
      {
        fzp: (s) =>
          s.replace(
            " <views>",
            " <spice>\n  <line>R{instanceTitle} {net connector0} {net connector9} 1k</line>\n </spice>\n <views>",
          ),
      },
      "spice",
    ],
    [
      "layer group missing",
      { svg: { icon: (s) => s.replace('<g id="icon">', '<g id="iconx">') } },
      "layer-ids",
    ],
    [
      "short module id",
      { fzp: (s) => s.replace(`moduleId="${ID}"`, 'moduleId="abc"') },
      "module-id",
    ],
    ["missing label", { fzp: (s) => s.replace(" <label>SP</label>\n", "") }, "required-tags"],
    [
      "svgId not in svg",
      { svg: { schematic: (s) => s.replace('id="connector1pin"', 'id="connectorXpin"') } },
      "connector-refs",
    ],
    [
      "gradient",
      {
        svg: {
          breadboard: (s) =>
            s.replace(
              '<g id="breadboard">',
              '<defs><linearGradient id="g1"/></defs><g id="breadboard">',
            ),
        },
      },
      "svg-style",
    ],
    [
      "image outside breadboard and icon",
      {
        svg: {
          schematic: (s) =>
            s.replace(
              '<g id="schematic">',
              '<g id="schematic"><image width="10" height="10" href="data:image/png;base64,AAAA"/>',
            ),
        },
      },
      "svg-style",
    ],
    [
      "duplicate svg id",
      {
        svg: {
          breadboard: (s) =>
            s.replace(
              '<g id="breadboard">',
              '<g id="breadboard"><rect id="dup" width="1" height="1"/><rect id="dup" width="1" height="1"/>',
            ),
        },
      },
      "svg-ids",
    ],
    [
      "image with external href",
      {
        svg: {
          breadboard: (s) =>
            s.replace(
              '<g id="breadboard">',
              '<g id="breadboard"><image width="10" height="10" xlink:href="photo.png" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
            ),
        },
      },
      "svg-style",
    ],
  ];

  for (const [name, mut, code] of cases) {
    it(name, () => {
      const issues = validateCompiled(mutate(mut));
      expect(errorCodes(issues), formatIssues(issues)).toEqual([code]);
    });
  }
});

describe("warnings", () => {
  const warnCodes = (issues: Issue[]) =>
    issues.filter((i) => i.level === "warning").map((i) => i.code);

  it("connector gaps warn and explain D12a", () => {
    const issues = validateCompiled(
      mutate({
        fzp: (s) =>
          s
            .replace('<connector id="connector1"', '<connector id="connector3"')
            .replace(/connector1pin/g, "connector3pin")
            .replace(/connector1terminal/g, "connector3terminal"),
        svg: {
          breadboard: (s) => s.replace(/connector1(pin|terminal)/g, "connector3$1"),
          schematic: (s) => s.replace(/connector1(pin|terminal)/g, "connector3$1"),
          pcb: (s) => s.replace(/connector1pin/g, "connector3pin"),
          icon: (s) => s.replace(/connector1(pin|terminal)/g, "connector3$1"),
        },
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    const gap = issues.find((i) => i.code === "connector-numbering");
    expect(gap?.level).toBe("warning");
    expect(gap?.message).toContain("connector1, connector2");
    expect(gap?.fix).toContain("D12a");
  });

  it("orphan connector element warns", () => {
    const issues = validateCompiled(
      mutate({
        svg: {
          breadboard: (s) =>
            s.replace(
              '<g id="breadboard">',
              '<g id="breadboard"><rect id="connector7pin" width="1" height="1"/>',
            ),
        },
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues)).toEqual(["connector-refs"]);
  });

  it("copper0 as a sibling of copper1 warns", () => {
    const issues = validateCompiled(
      mutate({
        svg: {
          pcb: (s) =>
            s
              .replace(
                '<g id="copper1">\n    <g id="copper0">',
                '<g id="copper1"></g>\n    <g id="copper0">',
              )
              .replace("    </g>\n  </g>\n</svg>", "    </g>\n</svg>"),
        },
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues)).toEqual(["layer-ids"]);
  });

  it("viewBox not 1 mil per unit warns", () => {
    const issues = validateCompiled(
      mutate({
        svg: { pcb: (s) => s.replace('viewBox="0 0 1889.76 787.4"', 'viewBox="0 0 48 20"') },
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues)).toEqual(["svg-root", "svg-root"]);
  });

  it("text in copper warns", () => {
    const issues = validateCompiled(
      mutate({
        svg: {
          pcb: (s) =>
            s.replace('<g id="copper0">', '<g id="copper0"><text font-family="Noto Sans">x</text>'),
        },
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues)).toEqual(["copper-only"]);
  });

  it("copper0 listed but unused warns", () => {
    const issues = validateCompiled(
      mutate({ fzp: (s) => s.replace(/ *<p layer="copper0" svgId="connector\dpin"\/>\n/g, "") }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues)).toEqual(["pcb-layers"]);
  });

  it("missing variant and unknown spice property warn; small bus warns", () => {
    const issues = validateCompiled(
      mutate({
        fzp: (s) =>
          s
            .replace('  <property name="variant">vector</property>\n', "")
            .replace(
              " <views>",
              " <spice>\n  <line>V{instanceTitle} {net connector0} {net connector1} DC {voltage}</line>\n </spice>\n <views>",
            )
            .replace(
              " </connectors>",
              ' </connectors>\n <buses><bus id="a"><nodeMember connectorId="connector0"/></bus></buses>',
            ),
      }),
    );
    expect(errorCodes(issues)).toEqual([]);
    expect(warnCodes(issues).sort()).toEqual(["buses", "required-tags", "spice"]);
  });
});

describe("more error paths", () => {
  it("terminalId and legId both set", () => {
    const issues = validateCompiled(
      mutate({
        fzp: (s) =>
          s.replace(
            'svgId="connector0pin" terminalId="connector0terminal"/>',
            'svgId="connector0pin" terminalId="connector0terminal" legId="connector0leg"/>',
          ),
        svg: {
          breadboard: (s) =>
            s.replace(
              '<g id="breadboard">',
              '<g id="breadboard"><line id="connector0leg" x1="0" y1="0" x2="1" y2="1"/>',
            ),
        },
      }),
    );
    expect(issues.filter((i) => i.level === "error").map((i) => i.message)).toEqual([
      "connector0 sets both terminalId and legId in breadboardView",
    ]);
  });

  it("connector in two buses and duplicate bus id", () => {
    const issues = validateCompiled(
      mutate({
        fzp: (s) =>
          s.replace(
            " </connectors>",
            ' </connectors>\n <buses><bus id="a"><nodeMember connectorId="connector0"/><nodeMember connectorId="connector1"/></bus><bus id="a"><nodeMember connectorId="connector0"/><nodeMember connectorId="connector1"/></bus></buses>',
          ),
      }),
    );
    const msgs = issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(msgs).toContain('duplicate bus id "a"');
    expect(errorCodes(issues)).toEqual(["buses"]);
  });

  it("bad connector id, empty property, bad date, no family, extra/folder entries", () => {
    const issues = validateCompiled(
      mutate({
        fzp: (s) =>
          s
            .replace("<date>2026-10-31</date>", "<date>Oct 31 2026</date>")
            .replace(
              '<property name="family">fritzkit-spike</property>',
              '<property name="mpn"></property>',
            )
            .replace('<connector id="connector1"', '<connector id="pin1"')
            .replace('fritzingVersion="1.0.7"', ""),
        entries: (e) => [
          ...e,
          { name: "svg.breadboard.extra.svg", data: strToU8("<svg/>") },
          { name: "breadboard/x.svg", data: strToU8("<svg/>") },
          { name: "readme.txt", data: strToU8("hi") },
        ],
      }),
    );
    expect(errorCodes(issues)).toEqual([
      "connector-numbering",
      "module-id",
      "required-tags",
      "zip-entries",
    ]);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("readme.txt"))).toBe(
      true,
    );
  });

  it("malformed XML becomes an issue instead of throwing", () => {
    expect(validateCompiled({ ...base, fzp: "<module" })[0]?.code).toBe("fzp-xml");
    expect(validateCompiled({ ...base, fzp: "<foo/>" })[0]?.code).toBe("fzp-xml");
    const issues = validateCompiled({ ...base, svgs: { ...base.svgs, icon: "<svg><g></svg>" } });
    expect(errorCodes(issues)).toEqual(["svg-xml"]);
  });

  it("svg root without viewBox or with a non-svg root", () => {
    const noVb = validateCompiled(
      mutate({ svg: { icon: (s) => s.replace(' viewBox="0 0 1889.76 787.4"', "") } }),
    );
    expect(noVb.map((i) => i.message)).toEqual(["the icon svg has no viewBox"]);
    const notSvg = validateCompiled({
      ...base,
      svgs: { ...base.svgs, icon: '<g id="icon"/>' },
    });
    expect(notSvg.map((i) => i.code)).toEqual(["svg-root"]);
    const missingH = validateCompiled(
      mutate({ svg: { icon: (s) => s.replace(' height="0.7874in"', "") } }),
    );
    expect(errorCodes(missingH)).toEqual(["svg-root"]);
  });
});

describe("parsers and helpers", () => {
  it("parseFzp reads views, connectors and properties", () => {
    const m = parseFzp(base.fzp);
    expect(m.moduleId).toBe(ID);
    expect(m.views.pcb?.layers).toEqual(["copper0", "silkscreen", "copper1"]);
    expect(m.connectors.map((c) => c.id)).toEqual(["connector0", "connector1"]);
    expect(m.properties.find((p) => p.name === "family")?.value).toBe("fritzkit-spike");
  });

  it("parseSvg flattens with ancestors", () => {
    const nodes = parseSvg(base.svgs.pcb ?? "");
    const pad = nodes.find((n) => n.attrs.id === "connector0pin");
    expect(pad?.tag).toBe("circle");
    expect(pad?.ancestors.map((a) => a.id)).toEqual([undefined, "copper1", "copper0"]);
  });

  it("entryNameForImage maps view folders to flat names", () => {
    expect(entryNameForImage("pcb/x_pcb.svg")).toBe("svg.pcb.x_pcb.svg");
  });
});

describe("fzpz files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fritzkit-validate-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("validateFzpzFile on the zipped fixture is clean", () => {
    const files = Object.fromEntries(base.entries.map((e) => [e.name, e.data]));
    const p = join(tmp, "spike-vector.fzpz");
    writeFileSync(p, zipSync(files));
    expect(validateFzpzFile(p)).toEqual([]);
  });

  it("rejects garbage and zips without an fzp", () => {
    expect(validateFzpzBytes(strToU8("not a zip"))[0]?.code).toBe("zip-entries");
    const noFzp = zipSync({ "svg.icon.x.svg": strToU8("<svg/>") });
    expect(validateFzpzBytes(noFzp)[0]?.message).toContain("no part.*.fzp");
  });
});

describe("validateSpecJson", () => {
  it("returns one issue per zod error with its path", () => {
    const issues = validateSpecJson({ slug: "Bad Slug", title: "" });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.every((i) => i.code === "spec-schema" && i.level === "error")).toBe(true);
    expect(issues.map((i) => i.where)).toContain("slug");
    expect(issues.map((i) => i.where)).toContain("title");
    expect(issues.map((i) => i.where)).toContain("outline");
  });

  it("returns a root issue for a non-object and nothing for a valid spec", () => {
    const root = validateSpecJson(42);
    expect(root).toHaveLength(1);
    expect(root[0]?.where).toBeUndefined();
    const ok = validateSpecJson({
      slug: "relay-module",
      title: "Relay module",
      outline: { widthMm: 50, heightMm: 26 },
    });
    expect(ok.map((i) => i.message)).toEqual([]);
  });
});

describe("formatIssues and explain", () => {
  const e: Issue = {
    level: "error",
    code: "layer-ids",
    message: "layer missing",
    where: "pcb svg",
    fix: "add it",
  };
  const w: Issue = { level: "warning", code: "buses", message: "small bus" };

  it("formats errors first with a summary", () => {
    expect(formatIssues([w, e])).toBe(
      "ERROR [layer-ids] <pcb svg> layer missing (fix: add it)\nWARN  [buses] small bus\n1 error, 1 warning",
    );
    expect(formatIssues([])).toBe("No issues found.");
    expect(formatIssues([e, e])).toContain("2 errors, 0 warnings");
  });

  it("explain includes why and fix", () => {
    expect(explain(e)).toBe(
      "Error [layer-ids]: layer missing (in pcb svg)\n  Why: Each layer the fzp lists must be a <g id=...> group in that view's SVG.\n  Fix: add it",
    );
    expect(explain(w)).toContain("Warning [buses]: small bus");
    expect(explain({ level: "error", code: "nope", message: "m" })).toBe("Error [nope]: m");
  });

  it("explainCheckerLine maps common checker messages", () => {
    expect(explainCheckerLine("Invalid font family 'DroidSans' in element: [A]")).toContain(
      "Noto Sans",
    );
    expect(explainCheckerLine("Found gorn attribute with value '0'")).toContain("gorn");
    expect(explainCheckerLine("Missing viewBox attribute")).toContain("viewBox");
    expect(explainCheckerLine("Layer ID 'icon' from iconView not found in SVG")).toContain("icon");
    expect(explainCheckerLine("Property 'layer' has an empty value.")).toContain("value");
    expect(explainCheckerLine("Missing required tag: label")).toContain("missing element");
    expect(explainCheckerLine("Duplicate id attribute: x (occurrence 2 of 2)")).toContain("unique");
    expect(explainCheckerLine("something entirely new")).toBeUndefined();
    // The svg file prefix (a slug can contain "terminal" or "style") must not steer the match.
    expect(
      explainCheckerLine("svg.pcb.fritzkit-terminal-block-1_pcb.svg: Invalid font family 'X'"),
    ).toContain("Noto Sans");
    expect(
      explainCheckerLine("Leg ID 'connector0leg' from SVG not referenced in any FZP connector"),
    ).toContain("Declare the connector");
  });
});
