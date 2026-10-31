import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePartSpec, type PartSpecInput } from "../src/core/schema/part.js";
import { validateCompiled } from "../src/core/validate/index.js";
import {
  compileFromDir,
  defaultWorkspace,
  initWorkspace,
  listParts,
  newPartTemplate,
  PartJsonError,
  partDir,
  persistPinIds,
  readAssets,
  readPart,
  readPartJson,
  resolveWorkspace,
  SCHEMA_URL,
  serializePart,
  writePart,
} from "../src/core/workspace.js";

const DATE = "2026-01-01";
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fritzkit-ws-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const spec = (over: Partial<PartSpecInput> = {}): PartSpecInput => ({
  slug: "relay-module",
  title: "Relay module",
  outline: { widthMm: 30, heightMm: 20 },
  pins: [
    { key: "IN", name: "IN", xMm: 2.54, yMm: 2.54 },
    { key: "GND", name: "GND", role: "gnd", xMm: 2.54, yMm: 5.08 },
  ],
  ...over,
});

describe("workspace paths", () => {
  it("defaultWorkspace prefers FRITZKIT_WORKSPACE, else ~/fritzkit/parts", () => {
    expect(defaultWorkspace({ FRITZKIT_WORKSPACE: join(tmp, "w") })).toBe(join(tmp, "w"));
    expect(defaultWorkspace({ USERPROFILE: tmp })).toBe(join(tmp, "fritzkit", "parts"));
    expect(defaultWorkspace({ HOME: tmp })).toBe(join(tmp, "fritzkit", "parts"));
    expect(defaultWorkspace({})).toMatch(/fritzkit[\\/]parts$/);
    expect(defaultWorkspace()).toMatch(/parts$|./);
  });

  it("resolveWorkspace lets the flag win and is absolute", () => {
    expect(resolveWorkspace(join(tmp, "flag"), { FRITZKIT_WORKSPACE: join(tmp, "env") })).toBe(
      join(tmp, "flag"),
    );
    expect(resolveWorkspace(undefined, { FRITZKIT_WORKSPACE: join(tmp, "env") })).toBe(
      join(tmp, "env"),
    );
    expect(resolveWorkspace(undefined, { USERPROFILE: tmp })).toBe(join(tmp, "fritzkit", "parts"));
  });

  it("partDir accepts slugs and rejects anything path-like", () => {
    expect(partDir(tmp, "relay-module")).toBe(join(tmp, "relay-module"));
    for (const bad of ["../x", "a/b", "AB", "ab", "-abc", "x".repeat(61)]) {
      expect(() => partDir(tmp, bad)).toThrow(/invalid slug/);
    }
  });

  it("initWorkspace creates the folder and is idempotent", async () => {
    const ws = join(tmp, "a", "b");
    expect(await initWorkspace(ws)).toBe(ws);
    expect(existsSync(ws)).toBe(true);
    expect(await initWorkspace(ws)).toBe(ws);
  });
});

describe("readPart / writePart", () => {
  it("round-trips part.json byte for byte (2-space, LF, trailing newline, key order)", async () => {
    const dir = join(tmp, "relay-module");
    const { slug, title, ...rest } = spec();
    const raw: PartSpecInput = { title, slug, ...rest };
    const file = await writePart(dir, raw);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(serializePart(raw));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text.split("\n")[1]).toBe('  "title": "Relay module",');
    const loaded = await readPart(dir);
    expect(loaded.raw).toEqual(raw);
    expect(loaded.spec.pins[0]?.type).toBe("female");
    expect(loaded.dir).toBe(dir);
    expect(loaded.assets.size).toBe(0);
  });

  it("collects every asset file sorted, skipping dotfiles", async () => {
    const dir = join(tmp, "p");
    mkdirSync(join(dir, "assets", "sub"), { recursive: true });
    writeFileSync(join(dir, "assets", "z.png"), "z");
    writeFileSync(join(dir, "assets", "a.png"), "a");
    writeFileSync(join(dir, "assets", "sub", "m.jpg"), "m");
    writeFileSync(join(dir, "assets", ".gitkeep"), "");
    writeFileSync(join(dir, "top.png"), "not an asset");
    const assets = await readAssets(dir);
    expect([...assets.keys()]).toEqual(["assets/a.png", "assets/sub/m.jpg", "assets/z.png"]);
    expect(new TextDecoder().decode(assets.get("assets/a.png"))).toBe("a");
    expect((await readAssets(join(tmp, "nothing"))).size).toBe(0);
  });

  it("reports a missing part.json, bad JSON and an invalid spec", async () => {
    await expect(readPart(join(tmp, "none"))).rejects.toBeInstanceOf(PartJsonError);
    const dir = join(tmp, "bad");
    mkdirSync(dir);
    writeFileSync(join(dir, "part.json"), "{ nope");
    await expect(readPartJson(dir)).rejects.toThrow(/not valid JSON/);
    writeFileSync(join(dir, "part.json"), String.fromCharCode(0xfeff) + '{"slug": "x"}');
    expect(await readPartJson(dir)).toEqual({ slug: "x" });
    await expect(readPart(dir)).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rethrows unexpected read errors", async () => {
    const dir = join(tmp, "isdir");
    mkdirSync(join(dir, "part.json"), { recursive: true });
    await expect(readPartJson(dir)).rejects.not.toBeInstanceOf(PartJsonError);
  });
});

describe("persistPinIds", () => {
  it("merges new ids without touching existing ids or reordering keys", async () => {
    const dir = join(tmp, "p");
    await writePart(dir, { ...spec(), pinIds: { IN: 5 }, description: "after pinIds" });
    const added = await persistPinIds(dir, { IN: 0, GND: 6 });
    expect(added).toEqual(["GND"]);
    const raw = JSON.parse(readFileSync(join(dir, "part.json"), "utf8"));
    expect(raw.pinIds).toEqual({ IN: 5, GND: 6 });
    expect(Object.keys(raw)).toEqual(["slug", "title", "outline", "pins", "pinIds", "description"]);
  });

  it("appends pinIds at the end when absent and writes nothing when nothing is new", async () => {
    const dir = join(tmp, "p");
    await writePart(dir, spec());
    expect(await persistPinIds(dir, { IN: 0 })).toEqual(["IN"]);
    const raw = JSON.parse(readFileSync(join(dir, "part.json"), "utf8"));
    expect(Object.keys(raw).at(-1)).toBe("pinIds");
    const before = readFileSync(join(dir, "part.json"), "utf8");
    expect(await persistPinIds(dir, { IN: 9 })).toEqual([]);
    expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(before);
  });
});

describe("newPartTemplate", () => {
  it("is a valid generic breakout spec with a $schema and one pin", async () => {
    const t = newPartTemplate("sensor-breakout", "Sensor breakout");
    expect(t.$schema).toBe(SCHEMA_URL);
    expect(t.pins).toHaveLength(1);
    const parsed = parsePartSpec(t);
    expect(parsed.slug).toBe("sensor-breakout");
    const dir = join(tmp, "sensor-breakout");
    await writePart(dir, t);
    const compiled = await compileFromDir(dir, { date: DATE });
    expect(validateCompiled(compiled).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("listParts", () => {
  it("lists part folders sorted by slug, with a title fallback", async () => {
    await writePart(join(tmp, "zeta-part"), spec({ slug: "zeta-part", title: "Zeta" }));
    await writePart(join(tmp, "alpha-part"), spec({ slug: "alpha-part", title: "Alpha" }));
    mkdirSync(join(tmp, "broken"));
    writeFileSync(join(tmp, "broken", "part.json"), "{");
    mkdirSync(join(tmp, "notapart"));
    writeFileSync(join(tmp, "loose.json"), "{}");
    const parts = await listParts(tmp);
    expect(parts.map((p) => [p.slug, p.title])).toEqual([
      ["alpha-part", "Alpha"],
      ["broken", "broken"],
      ["zeta-part", "Zeta"],
    ]);
    expect(parts[0]?.dir).toBe(join(tmp, "alpha-part"));
    expect(await listParts(join(tmp, "missing"))).toEqual([]);
  });
});

describe("compileFromDir", () => {
  it("persists new pinIds before compiling so the moduleId is stable", async () => {
    const dir = join(tmp, "relay-module");
    await writePart(dir, spec());
    const first = await compileFromDir(dir, { date: DATE });
    expect(first.persistedPinKeys).toEqual(["IN", "GND"]);
    expect(JSON.parse(readFileSync(join(dir, "part.json"), "utf8")).pinIds).toEqual({
      IN: 0,
      GND: 1,
    });
    const second = await compileFromDir(dir, { date: DATE, generator: "test" });
    expect(second.persistedPinKeys).toEqual([]);
    expect(second.identity.moduleId).toBe(first.identity.moduleId);
    expect(second.fzp).toContain("connector1");
  });

  it("persist:false leaves part.json alone but compiles the same part", async () => {
    const dir = join(tmp, "relay-module");
    await writePart(dir, spec());
    const before = readFileSync(join(dir, "part.json"), "utf8");
    const c = await compileFromDir(dir, { date: DATE, persist: false });
    expect(c.persistedPinKeys).toEqual([]);
    expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(before);
    const persisted = await compileFromDir(dir, { date: DATE });
    expect(persisted.identity.moduleId).toBe(c.identity.moduleId);
  });

  it("embeds a photo asset through the image module", async () => {
    const dir = join(tmp, "photo-part");
    mkdirSync(join(dir, "assets"), { recursive: true });
    const png = await sharp({
      create: { width: 60, height: 40, channels: 3, background: { r: 20, g: 120, b: 60 } },
    })
      .png()
      .toBuffer();
    writeFileSync(join(dir, "assets", "top.png"), png);
    await writePart(
      dir,
      spec({
        slug: "photo-part",
        artwork: { style: "photo", photo: { src: "assets/top.png", removeBackground: false } },
      }),
    );
    const c = await compileFromDir(dir, { date: DATE });
    expect(c.warnings).toEqual([]);
    expect(c.svgs.breadboard).toContain("data:image/png;base64,");
  });
});
