import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPartJson, writePart } from "../src/core/workspace.js";
import { connectorSummary, createServer } from "../src/mcp/server.js";
import { tempEnv, type TempEnv } from "./cli-helpers.js";

let t: TempEnv;
let client: Client;

beforeEach(async () => {
  t = tempEnv("fritzkit-mcp-");
  const server = createServer(t.ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => {
  await client.close();
  t.cleanup();
});

const SLUG = "sensor-breakout";

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(r: CallToolResult): string {
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

async function newPart(): Promise<string> {
  const r = await call("fritzkit_new_part", { slug: SLUG, title: "Sensor breakout" });
  expect(r.isError).toBeFalsy();
  return join(t.ws, SLUG);
}

describe("MCP server", () => {
  it("lists every tool with a short description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(
      [
        "fritzkit_add_pins",
        "fritzkit_doctor",
        "fritzkit_export",
        "fritzkit_get_part",
        "fritzkit_import_kicad",
        "fritzkit_init_workspace",
        "fritzkit_install",
        "fritzkit_list_parts",
        "fritzkit_new_part",
        "fritzkit_patch_part",
        "fritzkit_prune",
        "fritzkit_render",
        "fritzkit_schema",
        "fritzkit_set_part",
        "fritzkit_validate",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description!.length).toBeLessThanOrEqual(140);
      expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("workspace");
    }
  });

  it("init / new / list / get", async () => {
    expect(textOf(await call("fritzkit_init_workspace"))).toBe(t.ws);
    await newPart();
    const list = JSON.parse(textOf(await call("fritzkit_list_parts")));
    expect(list.parts.map((p: { slug: string }) => p.slug)).toEqual([SLUG]);
    const got = JSON.parse(textOf(await call("fritzkit_get_part", { part: SLUG })));
    expect(got.part.slug).toBe(SLUG);
    expect(got.connectors).toEqual([
      expect.objectContaining({ key: "VCC", id: "connector0", role: "power", xMm: 3.81 }),
    ]);
    expect(got.newPinKeys).toEqual(["VCC"]);
  });

  it("get_part reports schema and resolve problems instead of connectors", async () => {
    const dir = await newPart();
    const raw = await readPartJson(dir);
    await writePart(dir, { ...raw, title: "" });
    const bad = JSON.parse(textOf(await call("fritzkit_get_part", { part: SLUG })));
    expect(bad.issues[0].code).toBe("spec-schema");
    expect(bad.connectors).toBeUndefined();
    await writePart(dir, { ...raw, pins: [...raw.pins!, ...raw.pins!] });
    const dup = JSON.parse(textOf(await call("fritzkit_get_part", { part: SLUG })));
    expect(dup.issues[0].message).toMatch(/duplicate pin key/);
  });

  it("set_part validates before writing and keeps pinIds", async () => {
    const dir = await newPart();
    await call("fritzkit_validate", { part: SLUG });
    const raw = await readPartJson(dir);
    const { pinIds: _drop, ...noIds } = raw;
    const ok = await call("fritzkit_set_part", { part: SLUG, json: { ...noIds, title: "New" } });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toMatch(/saved .*part\.json \(fritzkit-sensor-breakout-[0-9a-f]{8}\)/);
    const after = await readPartJson(dir);
    expect(after.title).toBe("New");
    expect(after.pinIds).toEqual({ VCC: 0 });

    const before = readFileSync(join(dir, "part.json"), "utf8");
    const bad = await call("fritzkit_set_part", { part: SLUG, json: { ...after, outline: {} } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("not saved");
    expect(textOf(bad)).toContain("fritzkit schema");
    expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(before);

    const renamed = await call("fritzkit_set_part", {
      part: SLUG,
      json: { ...after, slug: "other-slug" },
    });
    expect(renamed.isError).toBe(true);
    expect(textOf(renamed)).toMatch(/does not match the part folder/);
    expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(before);
  });

  it("set_part creates a missing workspace part, refuses a missing path", async () => {
    const json = {
      slug: "relay-module",
      title: "Relay module",
      outline: { widthMm: 30, heightMm: 20 },
      pins: [{ key: "IN", name: "IN", xMm: 2.54, yMm: 2.54 }],
    };
    const r = await call("fritzkit_set_part", { part: "relay-module", json });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(t.ws, "relay-module", "assets", ".gitkeep"))).toBe(true);
    const p = await call("fritzkit_set_part", { part: join(t.root, "nowhere", "x"), json });
    expect(p.isError).toBe(true);
  });

  it("set_part rejects a spec that does not resolve", async () => {
    await newPart();
    const raw = await readPartJson(join(t.ws, SLUG));
    const r = await call("fritzkit_set_part", {
      part: SLUG,
      json: { ...raw, pins: [...raw.pins!, ...raw.pins!] },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not saved: .*duplicate pin key/);
  });

  it("patch_part applies RFC 6902 ops and refuses a failing test", async () => {
    const dir = await newPart();
    const ok = await call("fritzkit_patch_part", {
      part: SLUG,
      patch: [
        { op: "test", path: "/title", value: "Sensor breakout" },
        { op: "replace", path: "/title", value: "Patched" },
        { op: "add", path: "/tags/-", value: "i2c" },
      ],
    });
    expect(ok.isError).toBeFalsy();
    const raw = await readPartJson(dir);
    expect(raw.title).toBe("Patched");
    expect(raw.tags).toEqual(["sensor", "breakout", "i2c"]);
    const bad = await call("fritzkit_patch_part", {
      part: SLUG,
      patch: [{ op: "test", path: "/title", value: "nope" }],
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/test failed/);
  });

  it("add_pins appends pins and reports compile problems", async () => {
    const dir = await newPart();
    const r = await call("fritzkit_add_pins", {
      part: SLUG,
      pins: [
        { key: "GND", name: "GND", role: "gnd", xMm: 3.81, yMm: 10.16 },
        { key: "SDA", name: "SDA", role: "i2c", xMm: 16.51, yMm: 7.62 },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("No issues found.");
    expect((await readPartJson(dir)).pinIds).toEqual({ VCC: 0, GND: 1, SDA: 2 });
    const dup = await call("fritzkit_add_pins", {
      part: SLUG,
      pins: [{ key: "GND", name: "GND", xMm: 1, yMm: 1 }],
    });
    expect(dup.isError).toBe(true);
  });

  it("set_part rejects colliding pinIds", async () => {
    await newPart();
    const raw = await readPartJson(join(t.ws, SLUG));
    const r = await call("fritzkit_set_part", {
      part: SLUG,
      json: { ...raw, pinIds: { VCC: 0, OLD: 0 } },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not saved: .*used twice/);
  });

  it("validate / render (svg and png) / export / install / prune", async () => {
    await newPart();
    const v = await call("fritzkit_validate", { part: SLUG });
    expect(textOf(v)).toContain("No issues found.");
    const svg = await call("fritzkit_render", { part: SLUG, view: "schematic" });
    expect(textOf(svg)).toMatch(/^<\?xml|^<svg/);
    expect(textOf(svg)).toContain('id="schematic"');
    const png = await call("fritzkit_render", { part: SLUG, png: true, dpi: 100 });
    const img = png.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(img.mimeType).toBe("image/png");
    expect([...Buffer.from(img.data, "base64").subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(textOf(png)).toContain("breadboard view");

    const exp = await call("fritzkit_export", { part: SLUG });
    expect(textOf(exp)).toMatch(/wrote .*\.fzpz/);
    const out = await call("fritzkit_export", { part: SLUG, out: "x.fzpz", force: true });
    expect(textOf(out)).toContain(join(t.root, "x.fzpz"));
    const inst = await call("fritzkit_install", { part: SLUG });
    expect(inst.isError).toBeFalsy();
    expect(textOf(inst)).toContain(t.userParts);

    t.running.value = true;
    const busy = await call("fritzkit_install", { part: SLUG });
    expect(busy.isError).toBe(true);
    expect(textOf(busy)).toContain("Fritzing is running");
    t.running.value = false;

    const dry = await call("fritzkit_prune", { family: SLUG });
    expect(textOf(dry)).toContain("nothing to prune");
    const kept = await call("fritzkit_prune", { family: SLUG, keep: "nope", yes: true });
    expect(kept.isError).toBe(true);
  });

  it("render reports a missing view in a .fzpz-less target and edits refuse a .fzpz", async () => {
    await newPart();
    const exp = await call("fritzkit_export", { part: SLUG });
    const fzpz = /wrote (.*\.fzpz)/.exec(textOf(exp))![1]!;
    const g = await call("fritzkit_get_part", { part: fzpz });
    expect(g.isError).toBe(true);
    expect(textOf(g)).toMatch(/edit tools need a part folder/);
    const r = await call("fritzkit_render", { part: fzpz, view: "pcb" });
    expect(textOf(r)).toContain('id="copper1"');
  });

  it("import_kicad / schema / doctor / unknown part", async () => {
    const file = join(process.cwd(), "test", "fixtures", "kicad", "pin_header_2x03.kicad_mod");
    const k = await call("fritzkit_import_kicad", { file, slug: "header-2x3", title: "Header" });
    expect(textOf(k)).toContain("6 pads");
    const k2 = await call("fritzkit_import_kicad", { file, slug: "header-2x4" });
    expect(k2.isError).toBeFalsy();
    const s = JSON.parse(textOf(await call("fritzkit_schema")));
    expect(s.type ?? s.$ref ?? s.properties).toBeDefined();
    const d = await call("fritzkit_doctor");
    expect(textOf(d)).toContain("uv on PATH");
    const u = await call("fritzkit_validate", { part: "nope", workspace: t.ws });
    expect(u.isError).toBe(true);
    expect(textOf(u)).toMatch(/unknown part "nope"/);
  }, 30_000);

  it("connectorSummary lists resolved connectors", () => {
    const s = connectorSummary({
      slug: "abc-part",
      title: "x",
      outline: { widthMm: 10, heightMm: 10 },
      pins: [{ key: "A", name: "A", xMm: 1, yMm: 1 }],
    });
    expect(s.connectors[0]).toMatchObject({ key: "A", id: "connector0", tht: true });
  });
});
