/**
 * Parse a saved Fritzing sketch (.fzz) and count, per connector of a given part
 * instance, how many wires are attached in the breadboard view.
 *
 * .fz shape (verified on 1.0.7): <instance moduleIdRef=.. modelIndex=..> with
 * <views><breadboardView><connectors><connector connectorId="connectorN">
 *   <connects><connect connectorId=".." modelIndex=".." layer="breadboardWire"/></connects>
 * Wires are instances with moduleIdRef="WireModuleID".
 */
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

export interface ConnectorWiring {
  connectorId: string;
  /** modelIndex values of wires attached in the breadboard view. */
  wires: string[];
  /** modelIndex values of other (non-wire) items attached, e.g. the breadboard itself. */
  others: string[];
}

export interface SketchVerification {
  moduleId: string;
  instanceFound: boolean;
  instanceTitle?: string;
  connectors: ConnectorWiring[];
  wireCount: number;
  /** Breadboard-view wires that touch the part and also touch a breadboard instance. */
  wiresToBreadboard: number;
}

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function readSketchXml(fzzPath: string): string {
  const entries = unzipSync(new Uint8Array(readFileSync(fzzPath)));
  const fz = Object.keys(entries).find((n) => n.toLowerCase().endsWith(".fz"));
  if (!fz) throw new Error(`${fzzPath}: no .fz entry inside`);
  return new TextDecoder().decode(entries[fz]!);
}

export function verifySketch(fzzPath: string, moduleId: string): SketchVerification {
  const xml = readSketchXml(fzzPath);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml) as Node;
  const module = doc.module as Node;
  const instances = asArray((module.instances as Node | undefined)?.instance as Node | Node[]);

  const wires = new Set<string>();
  const breadboards = new Set<string>();
  for (const inst of instances) {
    const ref = String(inst["@_moduleIdRef"] ?? "");
    const idx = String(inst["@_modelIndex"] ?? "");
    if (ref === "WireModuleID") wires.add(idx);
    else if (/breadboard/i.test(ref)) breadboards.add(idx);
  }

  const part = instances.find((i) => String(i["@_moduleIdRef"] ?? "").trim() === moduleId);
  if (!part) {
    return { moduleId, instanceFound: false, connectors: [], wireCount: 0, wiresToBreadboard: 0 };
  }
  const bbView = ((part.views as Node | undefined)?.breadboardView ?? {}) as Node;
  const conns = asArray((bbView.connectors as Node | undefined)?.connector as Node | Node[]);
  const connectors: ConnectorWiring[] = conns.map((c) => {
    const connects = asArray((c.connects as Node | undefined)?.connect as Node | Node[]);
    const w: string[] = [];
    const o: string[] = [];
    for (const k of connects) {
      const idx = String(k["@_modelIndex"] ?? "");
      (wires.has(idx) ? w : o).push(idx);
    }
    return { connectorId: String(c["@_connectorId"] ?? ""), wires: w, others: o };
  });

  // A wire counts as "to the breadboard" when its other end connects to a breadboard instance.
  let wiresToBreadboard = 0;
  const partWires = new Set(connectors.flatMap((c) => c.wires));
  for (const inst of instances) {
    const idx = String(inst["@_modelIndex"] ?? "");
    if (!partWires.has(idx)) continue;
    const bb = ((inst.views as Node | undefined)?.breadboardView ?? {}) as Node;
    const wc = asArray((bb.connectors as Node | undefined)?.connector as Node | Node[]);
    const touchesBreadboard = wc.some((c) =>
      asArray((c.connects as Node | undefined)?.connect as Node | Node[]).some((k) =>
        breadboards.has(String(k["@_modelIndex"] ?? "")),
      ),
    );
    if (touchesBreadboard) wiresToBreadboard++;
  }

  return {
    moduleId,
    instanceFound: true,
    instanceTitle: typeof part.title === "string" ? part.title : undefined,
    connectors,
    wireCount: partWires.size,
    wiresToBreadboard,
  };
}

if (process.argv[1] && /verify-sketch/.test(process.argv[1])) {
  const [fzz, id] = process.argv.slice(2);
  if (!fzz || !id) throw new Error("usage: verify-sketch <file.fzz> <moduleId>");
  console.log(JSON.stringify(verifySketch(fzz, id), null, 2));
}
