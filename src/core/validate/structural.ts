/**
 * Structural validator: pure checks over a compiled part (fzp text + one SVG per view +
 * the flat zip entry list). Catches the mistakes Fritzing either rejects on import or
 * silently mis-renders, before the (slower, Python) vendored part checker runs.
 * No fs, no network.
 */
import { XMLParser } from "fast-xml-parser";
import type { View } from "../compile/types.js";
import { VIEWS } from "../compile/types.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  /** kebab-case check id, e.g. "layer-ids". */
  code: string;
  message: string;
  /** Where the problem is: a zip entry name, "fzp", "<view> svg", a connector id ... */
  where?: string;
  /** How to fix it. */
  fix?: string;
}

/** The subset of CompiledPart the validator reads (a CompiledPart is assignable). */
export interface ValidateInput {
  fzp: string;
  svgs: Partial<Record<View, string>>;
  entries: { name: string; data: Uint8Array }[];
}

export const ALLOWED_FONTS = ["Noto Sans", "OCR-Fritzing-mono"] as const;

const VIEW_TAG: Record<View, string> = {
  breadboard: "breadboardView",
  schematic: "schematicView",
  pcb: "pcbView",
  icon: "iconView",
};

// ---------------------------------------------------------------------------
// fzp model

interface FzpP {
  layer: string;
  svgId?: string;
  terminalId?: string;
  legId?: string;
  hybrid?: string;
}

interface FzpConnector {
  id: string;
  name?: string;
  views: Partial<Record<View, FzpP[]>>;
}

interface FzpView {
  image?: string;
  layers: string[];
}

interface FzpModel {
  moduleId?: string;
  fritzingVersion?: string;
  tags: Record<string, string | undefined>;
  properties: { name: string; value: string }[];
  views: Partial<Record<View, FzpView>>;
  connectors: FzpConnector[];
  buses: { id: string; members: string[] }[];
  spiceLines: string[];
}

type XmlObj = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  "connector",
  "layer",
  "layers",
  "p",
  "property",
  "bus",
  "nodeMember",
  "line",
  "tag",
  "model",
]);

function asObj(v: unknown): XmlObj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as XmlObj) : undefined;
}

function asArr(v: unknown): XmlObj[] {
  if (Array.isArray(v)) return v.map((x) => asObj(x) ?? { "#text": String(x) });
  const o = asObj(v);
  if (o) return [o];
  if (v === undefined || v === null) return [];
  return [{ "#text": String(v) }];
}

function textOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) return textOf(v[0]);
  const o = asObj(v);
  if (o) {
    const t = o["#text"];
    return t === undefined ? "" : String(t);
  }
  return undefined;
}

function attr(o: XmlObj | undefined, name: string): string | undefined {
  const v = o?.[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

/** Parse an fzp string. Throws on malformed XML. */
export function parseFzp(fzp: string): FzpModel {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const doc = asObj(parser.parse(fzp, true));
  const mod = asObj(doc?.module);
  if (!mod) throw new Error("fzp has no <module> root element");

  const tags: Record<string, string | undefined> = {};
  for (const t of ["title", "label", "date", "author", "version", "description"]) {
    tags[t] = textOf(mod[t]);
  }

  const properties: { name: string; value: string }[] = [];
  for (const props of asArr(mod.properties)) {
    for (const p of asArr(props.property)) {
      properties.push({ name: attr(p, "name") ?? "", value: (textOf(p) ?? "").trim() });
    }
  }

  const views: Partial<Record<View, FzpView>> = {};
  const viewsEl = asObj(mod.views);
  for (const v of VIEWS) {
    const ve = asObj(viewsEl?.[VIEW_TAG[v]]);
    if (!ve) continue;
    const layersEls = asArr(ve.layers);
    const first = layersEls[0];
    views[v] = {
      image: attr(first, "image"),
      layers: layersEls.flatMap((le) =>
        asArr(le.layer)
          .map((l) => attr(l, "layerId"))
          .filter((x): x is string => x !== undefined),
      ),
    };
  }

  const connectors: FzpConnector[] = [];
  for (const cs of asArr(mod.connectors)) {
    for (const c of asArr(cs.connector)) {
      const cviews: Partial<Record<View, FzpP[]>> = {};
      const cv = asObj(c.views);
      for (const v of VIEWS) {
        const ve = asObj(cv?.[VIEW_TAG[v]]);
        if (!ve) continue;
        cviews[v] = asArr(ve.p).map((p) => ({
          layer: attr(p, "layer") ?? "",
          svgId: attr(p, "svgId"),
          terminalId: attr(p, "terminalId"),
          legId: attr(p, "legId"),
          hybrid: attr(p, "hybrid"),
        }));
      }
      connectors.push({ id: attr(c, "id") ?? "", name: attr(c, "name"), views: cviews });
    }
  }

  const buses: { id: string; members: string[] }[] = [];
  for (const bs of asArr(mod.buses)) {
    for (const b of asArr(bs.bus)) {
      buses.push({
        id: attr(b, "id") ?? "",
        members: asArr(b.nodeMember).map((n) => attr(n, "connectorId") ?? ""),
      });
    }
  }

  const spiceLines: string[] = [];
  for (const sp of asArr(mod.spice)) {
    for (const l of asArr(sp.line)) spiceLines.push(textOf(l) ?? "");
    for (const m of asArr(sp.model)) spiceLines.push(textOf(m) ?? "");
  }

  return {
    moduleId: attr(mod, "moduleId"),
    fritzingVersion: attr(mod, "fritzingVersion"),
    tags,
    properties,
    views,
    connectors,
    buses,
    spiceLines,
  };
}

// ---------------------------------------------------------------------------
// SVG model: a flat list of elements with their ancestors

export interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  /** Ancestor elements, outermost first (excluding this node). */
  ancestors: { tag: string; id?: string }[];
  /** Concatenated direct text content (for <text> diagnostics). */
  text: string;
}

/** Parse an SVG into a flat element list in document order. Throws on malformed XML. */
export function parseSvg(svg: string): SvgNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false,
    preserveOrder: true,
    trimValues: true,
  });
  const tree = parser.parse(svg, true) as unknown[];
  const out: SvgNode[] = [];
  const walk = (items: unknown[], ancestors: { tag: string; id?: string }[]) => {
    for (const item of items) {
      const o = asObj(item);
      if (!o) continue;
      const tag = Object.keys(o).find((k) => k !== ":@");
      if (!tag || tag.startsWith("?") || tag.startsWith("#")) continue;
      const rawAttrs = asObj(o[":@"]) ?? {};
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (k.startsWith("@_")) attrs[k.slice(2)] = String(v);
      }
      const children = Array.isArray(o[tag]) ? (o[tag] as unknown[]) : [];
      const text = children
        .map((c) => {
          const co = asObj(c);
          return co && "#text" in co ? String(co["#text"]) : "";
        })
        .join("");
      out.push({ tag: localName(tag), attrs, ancestors, text });
      walk(children, [...ancestors, { tag: localName(tag), id: attrs.id }]);
    }
  };
  walk(tree, []);
  return out;
}

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// checks

const CONNECTOR_RE = /^connector(\d+)$/;
const CONNECTOR_ELEMENT_RE = /^(connector\d+)(pin|terminal|leg|pad)$/;

function err(code: string, message: string, where?: string, fix?: string): Issue {
  return { level: "error", code, message, ...(where ? { where } : {}), ...(fix ? { fix } : {}) };
}

function warn(code: string, message: string, where?: string, fix?: string): Issue {
  return { level: "warning", code, message, ...(where ? { where } : {}), ...(fix ? { fix } : {}) };
}

function checkModuleId(m: FzpModel): Issue[] {
  const issues: Issue[] = [];
  const id = m.moduleId;
  if (!id) {
    issues.push(err("module-id", "module has no moduleId attribute", "fzp"));
  } else {
    if (id.length < 8) {
      issues.push(
        err(
          "module-id",
          `moduleId "${id}" is shorter than 8 characters`,
          "fzp",
          "use a longer, unique id",
        ),
      );
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      issues.push(
        err(
          "module-id",
          `moduleId "${id}" contains characters outside [A-Za-z0-9_.-]`,
          "fzp",
          "the moduleId becomes a folder name; keep it to letters, digits, _ . -",
        ),
      );
    }
  }
  if (!m.fritzingVersion) {
    issues.push(
      err(
        "module-id",
        "module has no fritzingVersion attribute",
        "fzp",
        'add fritzingVersion="1.0.7"',
      ),
    );
  }
  return issues;
}

/** "breadboard/x.svg" -> "svg.breadboard.x.svg". */
export function entryNameForImage(image: string): string {
  return `svg.${image.replace(/[\\/]/g, ".")}`;
}

function checkZipEntries(m: FzpModel, input: ValidateInput): Issue[] {
  const issues: Issue[] = [];
  const names = input.entries.map((e) => e.name);
  for (const n of names) {
    if (/[\\/]/.test(n)) {
      issues.push(
        err(
          "zip-entries",
          `zip entry "${n}" is inside a folder`,
          n,
          "a .fzpz is flat: part.<id>.fzp and svg.<view>.<name>.svg at the root",
        ),
      );
    }
  }
  const fzps = names.filter((n) => n.startsWith("part.") && n.endsWith(".fzp"));
  if (fzps.length !== 1) {
    issues.push(
      err(
        "zip-entries",
        `expected exactly one part.*.fzp entry, found ${fzps.length}`,
        "zip",
        "a .fzpz holds one fzp named part.<moduleId>.fzp",
      ),
    );
  }
  const expected = new Set<string>();
  for (const v of VIEWS) {
    const img = m.views[v]?.image;
    if (img === undefined) continue;
    const want = entryNameForImage(img);
    expected.add(want);
    if (!names.includes(want)) {
      issues.push(
        err(
          "zip-entries",
          `${v}View image "${img}" has no matching zip entry "${want}"`,
          `${v}View`,
          "Fritzing maps svg.<view>.<file> to <view>/<file>; the names must match byte for byte",
        ),
      );
    }
  }
  for (const n of names) {
    if (n.startsWith("svg.") && n.endsWith(".svg") && !expected.has(n)) {
      issues.push(
        err(
          "zip-entries",
          `zip entry "${n}" is not referenced by any <layers image> in the fzp`,
          n,
          "remove the extra svg or fix the image attribute that should point at it",
        ),
      );
    } else if (!n.startsWith("svg.") && !(n.startsWith("part.") && n.endsWith(".fzp"))) {
      issues.push(warn("zip-entries", `unexpected zip entry "${n}"`, n, "Fritzing ignores it"));
    }
  }
  return issues;
}

function checkRequiredTags(m: FzpModel): Issue[] {
  const issues: Issue[] = [];
  for (const t of ["title", "label", "date", "author", "version"]) {
    const v = m.tags[t];
    if (v === undefined || v.trim() === "") {
      issues.push(err("required-tags", `missing or empty <${t}>`, "fzp", `add a <${t}> element`));
    }
  }
  const date = m.tags.date;
  if (date && date.trim() !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    issues.push(
      err("required-tags", `<date> "${date}" is not YYYY-MM-DD`, "fzp", "use an ISO date"),
    );
  }
  const names = m.properties.map((p) => p.name.toLowerCase());
  if (!names.includes("family")) {
    issues.push(
      err(
        "required-tags",
        'properties have no "family"',
        "fzp",
        'add <property name="family">; parts with the same family swap in the Inspector',
      ),
    );
  }
  if (!names.includes("variant")) {
    issues.push(
      warn(
        "required-tags",
        'properties have no "variant"',
        "fzp",
        'add <property name="variant"> so versions of the part are distinguishable',
      ),
    );
  }
  for (const p of m.properties) {
    if (p.value === "") {
      issues.push(
        err(
          "required-tags",
          `property "${p.name}" has an empty value`,
          "fzp",
          "give it a value or remove it",
        ),
      );
    }
  }
  return issues;
}

function idsOf(nodes: SvgNode[]): Map<string, SvgNode> {
  const m = new Map<string, SvgNode>();
  for (const n of nodes) {
    const id = n.attrs.id;
    if (id !== undefined && !m.has(id)) m.set(id, n);
  }
  return m;
}

function checkLayerIds(m: FzpModel, svgNodes: Partial<Record<View, SvgNode[]>>): Issue[] {
  const issues: Issue[] = [];
  for (const v of VIEWS) {
    const view = m.views[v];
    const nodes = svgNodes[v];
    if (!view || !nodes) continue;
    const ids = idsOf(nodes);
    for (const l of view.layers) {
      if (!ids.has(l)) {
        issues.push(
          err(
            "layer-ids",
            `layer "${l}" listed in ${v}View has no element with id="${l}" in the ${v} svg`,
            `${v} svg`,
            `wrap the ${v} artwork in <g id="${l}">`,
          ),
        );
      }
    }
    if (v === "pcb") {
      const c0 = ids.get("copper0");
      if (c0 && ids.has("copper1") && !c0.ancestors.some((a) => a.id === "copper1")) {
        issues.push(
          warn(
            "layer-ids",
            "copper0 is not nested inside copper1",
            "pcb svg",
            'nest <g id="copper0"> inside <g id="copper1"> so one THT pad element serves both layers',
          ),
        );
      }
    }
  }
  return issues;
}

function checkConnectorRefs(m: FzpModel, svgNodes: Partial<Record<View, SvgNode[]>>): Issue[] {
  const issues: Issue[] = [];
  const declared = new Set(m.connectors.map((c) => c.id));
  for (const c of m.connectors) {
    for (const v of VIEWS) {
      const ps = c.views[v];
      const nodes = svgNodes[v];
      if (!ps || !nodes) continue;
      const ids = idsOf(nodes);
      for (const p of ps) {
        const where = `${c.id} ${v}View`;
        if (p.terminalId && p.legId) {
          issues.push(
            err(
              "connector-refs",
              `${c.id} sets both terminalId and legId in ${v}View`,
              where,
              "a lead uses legId INSTEAD of a terminal; drop terminalId",
            ),
          );
        }
        if (p.hybrid === "yes") continue;
        for (const [kind, id] of [
          ["svgId", p.svgId],
          ["terminalId", p.terminalId],
          ["legId", p.legId],
        ] as const) {
          if (id === undefined) continue;
          if (!ids.has(id)) {
            issues.push(
              err(
                "connector-refs",
                `${c.id} ${kind}="${id}" (layer ${p.layer}) not found in the ${v} svg`,
                where,
                `add an element with id="${id}" to the ${v} svg or fix the fzp reference`,
              ),
            );
          }
        }
        if (p.svgId === undefined) {
          issues.push(
            err(
              "connector-refs",
              `${c.id} <p layer="${p.layer}"> in ${v}View has no svgId`,
              where,
              'every <p> needs svgId="connectorNpin" (or hybrid="yes")',
            ),
          );
        }
        if (p.legId !== undefined) {
          const n = ids.get(p.legId);
          if (n && n.tag !== "line") {
            issues.push(
              err(
                "connector-refs",
                `${c.id} legId "${p.legId}" is a <${n.tag}>, not a <line>`,
                where,
                "Fritzing only bends legs drawn as a single <line>",
              ),
            );
          }
        }
        if (p.terminalId !== undefined) {
          const n = ids.get(p.terminalId);
          if (n && !hasArea(n)) {
            issues.push(
              err(
                "connector-refs",
                `${c.id} terminal "${p.terminalId}" (<${n.tag}>) has zero size`,
                where,
                "give the terminal a non-zero size, e.g. a 1 mil rect at the pin end",
              ),
            );
          }
        }
      }
    }
  }
  for (const v of VIEWS) {
    const nodes = svgNodes[v];
    if (!nodes) continue;
    const reported = new Set<string>();
    for (const n of nodes) {
      const mm = CONNECTOR_ELEMENT_RE.exec(n.attrs.id ?? "");
      if (!mm || !mm[1] || declared.has(mm[1]) || reported.has(n.attrs.id ?? "")) continue;
      reported.add(n.attrs.id ?? "");
      issues.push(
        warn(
          "connector-refs",
          `element id="${n.attrs.id}" in the ${v} svg belongs to ${mm[1]}, which the fzp does not declare`,
          `${v} svg`,
          "remove the orphan element or declare the connector",
        ),
      );
    }
  }
  return issues;
}

function hasArea(n: SvgNode): boolean {
  switch (n.tag) {
    case "rect":
    case "image":
    case "use": {
      const w = num(n.attrs.width);
      const h = num(n.attrs.height);
      return w !== undefined && h !== undefined && w > 0 && h > 0;
    }
    case "circle": {
      const r = num(n.attrs.r);
      return r !== undefined && r > 0;
    }
    case "ellipse": {
      const rx = num(n.attrs.rx);
      const ry = num(n.attrs.ry);
      return rx !== undefined && ry !== undefined && rx > 0 && ry > 0;
    }
    case "line":
      return false;
    default:
      // path/polygon/g: size cannot be computed cheaply; trust it.
      return true;
  }
}

function checkConnectorNumbering(m: FzpModel): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const nums: number[] = [];
  for (const c of m.connectors) {
    const mm = CONNECTOR_RE.exec(c.id);
    if (!mm) {
      issues.push(
        err(
          "connector-numbering",
          `connector id "${c.id}" is not of the form connectorN`,
          c.id,
          "use connector0, connector1, ...",
        ),
      );
    } else if (!seen.has(c.id)) {
      nums.push(Number(mm[1]));
    }
    if (seen.has(c.id)) {
      issues.push(
        err(
          "connector-numbering",
          `duplicate connector id "${c.id}"`,
          c.id,
          "every connector needs a unique id",
        ),
      );
    }
    seen.add(c.id);
  }
  nums.sort((a, b) => a - b);
  const missing: number[] = [];
  const max = nums[nums.length - 1];
  if (max !== undefined) {
    const have = new Set(nums);
    for (let i = 0; i < max; i++) if (!have.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    issues.push(
      warn(
        "connector-numbering",
        `connector numbers have gaps (missing ${missing.map((n) => `connector${n}`).join(", ")})`,
        "fzp",
        "expected when pins were removed: fritzkit never reuses a connector number (pinIds, D12a) " +
          "so wires on the remaining pins stay attached when you swap to the new version",
      ),
    );
  }
  return issues;
}

function checkBuses(m: FzpModel): Issue[] {
  const issues: Issue[] = [];
  const declared = new Set(m.connectors.map((c) => c.id));
  const busIds = new Set<string>();
  const owner = new Map<string, string>();
  for (const b of m.buses) {
    if (busIds.has(b.id)) {
      issues.push(err("buses", `duplicate bus id "${b.id}"`, `bus ${b.id}`, "rename one bus"));
    }
    busIds.add(b.id);
    for (const cid of b.members) {
      if (!declared.has(cid)) {
        issues.push(
          err(
            "buses",
            `bus "${b.id}" references "${cid}", which is not a connector`,
            `bus ${b.id}`,
            "remove the nodeMember or fix the connector id",
          ),
        );
      }
      const prev = owner.get(cid);
      if (prev !== undefined && prev !== b.id) {
        issues.push(
          err(
            "buses",
            `${cid} is in both bus "${prev}" and bus "${b.id}"`,
            `bus ${b.id}`,
            "merge the buses: a connector belongs to at most one bus",
          ),
        );
      } else {
        owner.set(cid, b.id);
      }
    }
    if (new Set(b.members).size < 2) {
      issues.push(
        warn(
          "buses",
          `bus "${b.id}" has fewer than 2 members`,
          `bus ${b.id}`,
          "a bus ties two or more connectors together; remove it",
        ),
      );
    }
  }
  return issues;
}

const UNIT_RE = /^\s*([0-9]*\.?[0-9]+(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/;

function checkSvgRoot(v: View, nodes: SvgNode[]): Issue[] {
  const issues: Issue[] = [];
  const where = `${v} svg`;
  const root = nodes[0];
  if (!root || root.tag !== "svg") {
    return [err("svg-root", `the ${v} svg has no <svg> root element`, where)];
  }
  const dims: Record<string, { value: number; unit: string } | undefined> = {};
  for (const d of ["width", "height"] as const) {
    const raw = root.attrs[d];
    const mm = raw === undefined ? null : UNIT_RE.exec(raw);
    if (!mm || !mm[1]) {
      issues.push(
        err(
          "svg-root",
          `the ${v} svg root has no valid ${d} (${raw ?? "missing"})`,
          where,
          `set ${d} in inches, e.g. ${d}="1.2in"`,
        ),
      );
      continue;
    }
    const unit = mm[2] ?? "";
    if (unit !== "in" && unit !== "mm") {
      issues.push(
        err(
          "svg-root",
          `the ${v} svg root ${d}="${raw}" has no in/mm unit`,
          where,
          "unitless or px sizes are read at 90 dpi and the part comes out the wrong size; use in or mm",
        ),
      );
      continue;
    }
    dims[d] = { value: Number(mm[1]), unit };
  }
  const vb = root.attrs.viewBox;
  const parts =
    vb === undefined
      ? []
      : vb
          .trim()
          .split(/[\s,]+/)
          .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    issues.push(
      err(
        "svg-root",
        vb === undefined
          ? `the ${v} svg has no viewBox`
          : `the ${v} svg viewBox "${vb}" is invalid`,
        where,
        'add viewBox="0 0 <width in mils> <height in mils>"',
      ),
    );
    return issues;
  }
  const vbSize = { width: parts[2] ?? 0, height: parts[3] ?? 0 };
  for (const d of ["width", "height"] as const) {
    const dim = dims[d];
    if (!dim || dim.unit !== "in") continue;
    const want = dim.value * 1000;
    if (want > 0 && Math.abs(vbSize[d] - want) / want > 0.005) {
      issues.push(
        warn(
          "svg-root",
          `the ${v} svg viewBox ${d} ${vbSize[d]} is not ${d}*1000 (${want})`,
          where,
          "1 unit should be 1 mil",
        ),
      );
    }
  }
  return issues;
}

function checkSvgStyle(v: View, nodes: SvgNode[]): Issue[] {
  const issues: Issue[] = [];
  const where = `${v} svg`;
  const once = new Set<string>();
  const add = (key: string, issue: Issue) => {
    if (once.has(key)) return;
    once.add(key);
    issues.push(issue);
  };
  for (const n of nodes) {
    const label = n.attrs.id ? `<${n.tag} id="${n.attrs.id}">` : `<${n.tag}>`;
    if (n.attrs.style !== undefined) {
      add(
        `style:${label}`,
        err(
          "svg-style",
          `${label} has a style= attribute`,
          where,
          "use XML attributes, Fritzing converts only a few CSS properties",
        ),
      );
    }
    if (n.tag === "tspan") {
      add(
        "tspan",
        err(
          "svg-style",
          `the ${v} svg uses <tspan>`,
          where,
          "use one <text> element per line; Fritzing mis-places tspans",
        ),
      );
    }
    if (n.tag === "linearGradient" || n.tag === "radialGradient") {
      add(
        `grad:${n.tag}`,
        err(
          "svg-style",
          `the ${v} svg uses <${n.tag}>`,
          where,
          "use flat fills; gradients do not render reliably in Fritzing",
        ),
      );
    }
    if (Object.keys(n.attrs).some((k) => k === "gorn" || k.endsWith(":gorn"))) {
      add(
        "gorn",
        err(
          "svg-style",
          `the ${v} svg has gorn attributes (first on ${label})`,
          where,
          "remove gorn attributes; they are Fritzing-internal and break re-import",
        ),
      );
    }
    if (n.tag === "image") {
      // The icon is the breadboard artwork scaled down (compile/icon.ts), so a photo-style
      // part embeds its photo in both; the Fritzing checker accepts that.
      if (v !== "breadboard" && v !== "icon") {
        add(
          "image-view",
          err(
            "svg-style",
            `the ${v} svg contains an <image>`,
            where,
            "only the breadboard (and icon) view may embed a raster image; draw this view as vectors",
          ),
        );
      }
      const href = (n.attrs["xlink:href"] ?? n.attrs.href ?? "").trim();
      if (!href.startsWith("data:")) {
        add(
          `href:${href}`,
          err(
            "svg-style",
            `<image> href "${href.slice(0, 60)}" is not a data: URI`,
            where,
            "embed the image as a base64 data: URI; a .fzpz cannot carry external files",
          ),
        );
      }
    }
    const ff = n.attrs["font-family"];
    if (ff !== undefined) {
      const fam = ff.trim().replace(/^['"]|['"]$/g, "");
      if (!(ALLOWED_FONTS as readonly string[]).includes(fam)) {
        add(
          `font:${fam}`,
          err(
            "svg-style",
            `font-family "${ff}" is not allowed (on ${label}${n.text ? ` "${n.text}"` : ""})`,
            where,
            `use ${ALLOWED_FONTS.map((f) => `"${f}"`).join(" or ")}`,
          ),
        );
      }
    }
  }
  return issues;
}

function checkDuplicateIds(v: View, nodes: SvgNode[]): Issue[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const id = n.attrs.id;
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const issues: Issue[] = [];
  for (const [id, count] of counts) {
    if (count < 2) continue;
    issues.push(
      err(
        "svg-ids",
        `id "${id}" is used by ${count} elements in the ${v} svg`,
        `${v} svg`,
        "SVG ids must be unique; for a THT pad emit one element inside copper0 nested in copper1",
      ),
    );
  }
  return issues;
}

const COPPER_OK = new Set(["rect", "circle", "path", "polygon", "line", "g", "ellipse"]);

function checkCopperOnly(nodes: SvgNode[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n.ancestors.some((a) => a.id === "copper0" || a.id === "copper1")) continue;
    if (COPPER_OK.has(n.tag) || seen.has(n.tag)) continue;
    seen.add(n.tag);
    issues.push(
      warn(
        "copper-only",
        `<${n.tag}> inside a copper layer`,
        "pcb svg",
        "copper layers should hold only pads/traces (rect, circle, path, polygon, line, ellipse, g); move text and images to silkscreen",
      ),
    );
  }
  return issues;
}

function checkPcbLayers(m: FzpModel): Issue[] {
  const pcb = m.views.pcb;
  if (!pcb) return [];
  const uses = m.connectors.some((c) => (c.views.pcb ?? []).some((p) => p.layer === "copper0"));
  const lists = pcb.layers.includes("copper0");
  if (uses && !lists) {
    return [
      err(
        "pcb-layers",
        "a connector has a copper0 <p> but pcbView does not list copper0",
        "pcbView",
        'add <layer layerId="copper0"/> to pcbView (THT parts need both copper layers)',
      ),
    ];
  }
  if (!uses && lists) {
    return [
      warn(
        "pcb-layers",
        "pcbView lists copper0 but no connector has a copper0 <p>",
        "pcbView",
        "an SMD-only part should list copper1 only",
      ),
    ];
  }
  return [];
}

function checkSpice(m: FzpModel): Issue[] {
  const issues: Issue[] = [];
  const declared = new Set(m.connectors.map((c) => c.id));
  const props = new Set(m.properties.map((p) => p.name.toLowerCase()));
  for (const line of m.spiceLines) {
    for (const mm of line.matchAll(/\{([^{}]*)\}/g)) {
      const tok = (mm[1] ?? "").trim();
      const net = /^net\s+(\S+)$/.exec(tok);
      if (net) {
        if (!declared.has(net[1] ?? "")) {
          issues.push(
            err(
              "spice",
              `spice token {${tok}} references ${net[1]}, which is not a connector`,
              "spice",
              "use a connector id declared in the fzp",
            ),
          );
        }
        continue;
      }
      if (tok === "instanceTitle") continue;
      if (!props.has(tok.toLowerCase())) {
        issues.push(
          warn(
            "spice",
            `spice token {${tok}} does not match any property`,
            "spice",
            `add a property named "${tok}" or fix the token`,
          ),
        );
      }
    }
  }
  return issues;
}

/** Run every structural check. Never throws: XML parse failures become issues. */
export function validateStructure(input: ValidateInput): Issue[] {
  let model: FzpModel;
  try {
    model = parseFzp(input.fzp);
  } catch (e) {
    return [
      err("fzp-xml", `fzp is not valid XML: ${e instanceof Error ? e.message : String(e)}`, "fzp"),
    ];
  }
  const issues: Issue[] = [];
  const svgNodes: Partial<Record<View, SvgNode[]>> = {};
  for (const v of VIEWS) {
    const s = input.svgs[v];
    if (s === undefined) continue;
    try {
      svgNodes[v] = parseSvg(s);
    } catch (e) {
      issues.push(
        err(
          "svg-xml",
          `${v} svg is not valid XML: ${e instanceof Error ? e.message : String(e)}`,
          `${v} svg`,
        ),
      );
    }
  }
  issues.push(
    ...checkModuleId(model),
    ...checkZipEntries(model, input),
    ...checkRequiredTags(model),
    ...checkLayerIds(model, svgNodes),
    ...checkConnectorRefs(model, svgNodes),
    ...checkConnectorNumbering(model),
    ...checkBuses(model),
  );
  for (const v of VIEWS) {
    const nodes = svgNodes[v];
    if (!nodes) continue;
    issues.push(
      ...checkSvgRoot(v, nodes),
      ...checkSvgStyle(v, nodes),
      ...checkDuplicateIds(v, nodes),
    );
    if (v === "pcb") issues.push(...checkCopperOnly(nodes));
  }
  issues.push(...checkPcbLayers(model), ...checkSpice(model));
  return issues;
}
