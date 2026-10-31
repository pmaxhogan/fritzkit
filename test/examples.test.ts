/**
 * Golden example parts under examples/. Every examples/<slug>/part.json must compile with
 * no structural issue, keep its committed pinIds complete, match the golden fzp and SVG
 * snapshots, and pass Fritzing's own part checker (when uv is installed).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VIEWS } from "../src/core/compile/types.js";
import { writeFzpz } from "../src/core/export/fzpz.js";
import { allocatePinIds } from "../src/core/resolve.js";
import { parsePartSpec } from "../src/core/schema/part.js";
import { runFzpChecker } from "../src/core/validate/checker.js";
import { validateCompiled, validateSpecJson } from "../src/core/validate/index.js";
import { compileFromDir, type CompileFromDirResult } from "../src/core/workspace.js";
import { checkExample, listExampleDirs, main } from "../scripts/check-examples.js";

const REPO = resolve(import.meta.dirname, "..");
const EXAMPLES = join(REPO, "examples");
const DATE = "2026-10-31";

function hasUv(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const UV = hasUv();

// The golden examples this suite pins with snapshots. Other folders under examples/ (if
// any) are covered by scripts/check-examples.ts, which validates every part folder.
const slugs = ["2s-18650-pack-sim", "rpi-pico-2w", "xiao-esp32-c6", "zmr-30a-esc"];

const cache = new Map<string, Promise<CompileFromDirResult>>();
function compiled(slug: string): Promise<CompileFromDirResult> {
  let p = cache.get(slug);
  if (!p) {
    p = compileFromDir(join(EXAMPLES, slug), { date: DATE, persist: false });
    cache.set(slug, p);
  }
  return p;
}

const tmp = mkdtempSync(join(tmpdir(), "fritzkit-examples-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** width/height (inches) of an SVG root element. */
function rootSizeIn(svg: string): { w: number; h: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const w = /\bwidth="([\d.]+)in"/.exec(root)?.[1];
  const h = /\bheight="([\d.]+)in"/.exec(root)?.[1];
  return { w: Number(w), h: Number(h) };
}

// vanepp's community Raspberry Pi Pico 2W part (rpi_pico2W_1), breadboard root size.
const VANEPP_BB = { w: 0.82678121, h: 2.0791388 };

describe("examples", () => {
  it("has the four golden examples", () => {
    for (const slug of slugs) expect(existsSync(join(EXAMPLES, slug, "part.json"))).toBe(true);
  });

  describe.each(slugs)("%s", (slug) => {
    it("is a valid spec", () => {
      const raw = JSON.parse(readFileSync(join(EXAMPLES, slug, "part.json"), "utf8")) as unknown;
      expect(validateSpecJson(raw)).toEqual([]);
    });

    it("compiles with no structural issue and complete committed pinIds", async () => {
      const c = await compiled(slug);
      const raw = JSON.parse(readFileSync(join(EXAMPLES, slug, "part.json"), "utf8")) as unknown;
      expect(allocatePinIds(parsePartSpec(raw)).added).toEqual([]);
      expect(c.warnings).toEqual([]);
      expect(validateCompiled(c)).toEqual([]);
    });

    it("matches the golden fzp and SVG snapshots", async () => {
      const c = await compiled(slug);
      await expect(c.fzp).toMatchFileSnapshot(`__snapshots__/examples-${slug}.fzp`);
      for (const v of VIEWS) {
        await expect(c.svgs[v]).toMatchFileSnapshot(`__snapshots__/examples-${slug}-${v}.svg`);
      }
    });

    it.skipIf(!UV)(
      "passes Fritzing's part checker",
      async () => {
        const c = await compiled(slug);
        const file = join(tmp, `${c.identity.moduleId}.fzpz`);
        await writeFzpz(c, file);
        const r = await runFzpChecker(file, { repoRoot: REPO });
        expect(r.available).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.warnings).toEqual([]);
        expect(r.exitCode).toBe(0);
      },
      300_000,
    );
  });
});

describe("Raspberry Pi Pico 2 W vs the community part", () => {
  it("has 43 connectors named after the pinout", async () => {
    const c = await compiled("rpi-pico-2w");
    expect(c.resolved.connectors).toHaveLength(43);
    const names = c.resolved.connectors.map((k) => k.name);
    expect(names.filter((n) => /^GP\d+$/.test(n))).toHaveLength(26);
    expect(names.filter((n) => n === "GND")).toHaveLength(8);
    expect(names).toEqual(expect.arrayContaining(["AGND", "VBUS", "VSYS", "RUN", "SWCLK"]));
    expect(names.some((n) => /^pin \d+$/.test(n))).toBe(false);
    expect(c.fzp.match(/<connector /g)).toHaveLength(43);
  });

  it("buses the 7 header GNDs and the debug GND, but not AGND", async () => {
    const c = await compiled("rpi-pico-2w");
    expect(c.resolved.buses).toHaveLength(1);
    const bus = c.resolved.buses[0]!;
    expect(bus.id).toBe("GND");
    expect(bus.connectorIds).toHaveLength(8);
    const byId = new Map(c.resolved.connectors.map((k) => [k.id, k]));
    for (const id of bus.connectorIds) expect(byId.get(id)?.name).toBe("GND");
    const agnd = c.resolved.connectors.find((k) => k.name === "AGND")!;
    expect(bus.connectorIds).not.toContain(agnd.id);
  });

  it("puts the two pin rows 0.7 in apart on the 0.1 in grid", async () => {
    const c = await compiled("rpi-pico-2w");
    const f = c.resolved.frame;
    const male = c.resolved.connectors.filter((k) => k.type === "male");
    expect(male).toHaveLength(40);
    const offGrid = (mm: number) => {
      const mil = mm / 0.0254;
      return Math.abs(mil - Math.round(mil / 100) * 100);
    };
    for (const k of male) {
      expect(offGrid(k.xMm + f.offsetXMm)).toBeLessThan(1e-3);
      expect(offGrid(k.yMm + f.offsetYMm)).toBeLessThan(1e-3);
    }
    const xs = [...new Set(male.map((k) => k.xMm))].sort((a, b) => a - b);
    expect(xs).toHaveLength(2);
    expect(xs[1]! - xs[0]!).toBeCloseTo(17.78, 6);
  });

  it("draws the 21 mm board as wide as vanepp's breadboard root, within 1%", async () => {
    const c = await compiled("rpi-pico-2w");
    // The board rectangle (outline plus its stroke) against vanepp's whole root width.
    const board =
      /<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" fill="#1B7F3B" stroke="#[0-9A-F]+" stroke-width="([\d.]+)"/.exec(
        c.svgs.breadboard,
      );
    expect(board).not.toBeNull();
    const widthIn = (Number(board![1]) + Number(board![3])) / 1000;
    expect(Math.abs(widthIn - VANEPP_BB.w) / VANEPP_BB.w).toBeLessThan(0.01);
    // The root is wider than the board by the 0.1 in grid pad (the first pin sits on a
    // 100 mil multiple) and a little shorter (vanepp leaves more room above the USB).
    const root = rootSizeIn(c.svgs.breadboard);
    expect(Math.abs(root.w - VANEPP_BB.w) / VANEPP_BB.w).toBeLessThan(0.05);
    expect(Math.abs(root.h - VANEPP_BB.h) / VANEPP_BB.h).toBeLessThan(0.05);
  });
});

describe("2S 18650 pack spice model", () => {
  it("resolves every spice token from the properties or connectors", async () => {
    const c = await compiled("2s-18650-pack-sim");
    const spec = c.resolved.spec;
    expect(spec.spice?.lines).toHaveLength(4);
    const ids = new Set(c.resolved.connectors.map((k) => `connector${k.id}`));
    for (const line of spec.spice!.lines) {
      for (const [, token] of line.matchAll(/\{([^}]+)\}/g)) {
        if (token === "instanceTitle") continue;
        const net = /^net (connector\d+)$/.exec(token!);
        if (net) expect(ids.has(net[1]!)).toBe(true);
        else expect(spec.properties[token!], token).toBeDefined();
      }
    }
    expect(spec.properties.voltage).toBe("7.4V");
    expect(c.fzp).toContain("<spice>");
    expect(c.fzp).toContain('<property name="internal resistance">');
  });

  it("stacks the two cells PACK- -> BAL -> PACK+", async () => {
    const c = await compiled("2s-18650-pack-sim");
    const id = (name: string) => c.resolved.connectors.find((k) => k.name === name)!.id;
    expect([id("PACK-"), id("PACK+"), id("BAL")]).toEqual([0, 1, 2]);
    const lines = c.resolved.spec.spice!.lines;
    expect(lines[0]).toMatch(/^V\S+ \{net connector2\}\S* \{net connector0\} DC \{cell voltage\}$/);
    expect(lines[2]).toMatch(/^V\S+ \{net connector1\}\S* \{net connector2\} DC \{cell voltage\}$/);
  });
});

describe("scripts/check-examples.ts", () => {
  it("lists the part folders under a directory", () => {
    expect(listExampleDirs(EXAMPLES)).toEqual(expect.arrayContaining(slugs));
    expect(listExampleDirs(join(tmp, "does-not-exist"))).toEqual([]);
  });

  it("reports no issue for a golden example", async () => {
    const r = await checkExample(join(EXAMPLES, "zmr-30a-esc"), {
      checker: false,
      tmp,
      repoRoot: REPO,
    });
    expect(r.slug).toBe("zmr-30a-esc");
    expect(r.moduleId).toMatch(/^fritzkit-zmr-30a-esc-[0-9a-f]{8}$/);
    expect(r.issues).toEqual([]);
  });

  it("reports schema errors and missing pinIds without touching part.json", async () => {
    const bad = join(tmp, "bad", "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "part.json"), JSON.stringify({ slug: "broken", title: "x" }));
    const r1 = await checkExample(bad, { checker: false, tmp, repoRoot: REPO });
    expect(r1.issues.some((i) => i.code === "spec-schema")).toBe(true);

    const fresh = join(tmp, "fresh", "fresh-part");
    mkdirSync(fresh, { recursive: true });
    const spec = {
      slug: "fresh-part",
      title: "Fresh part",
      outline: { widthMm: 10, heightMm: 10 },
      pins: [{ key: "a", name: "A", xMm: 5, yMm: 5 }],
    };
    const text = JSON.stringify(spec);
    writeFileSync(join(fresh, "part.json"), text);
    const r2 = await checkExample(fresh, { checker: false, tmp, repoRoot: REPO });
    expect(r2.issues.map((i) => i.code)).toContain("pin-ids");
    expect(readFileSync(join(fresh, "part.json"), "utf8")).toBe(text);
  });

  it("main exits 0 on the examples and 1 on an empty or broken folder", async () => {
    expect(await main(["--no-checker", EXAMPLES])).toBe(0);
    const empty = join(tmp, "empty");
    mkdirSync(empty, { recursive: true });
    expect(await main(["--no-checker", empty])).toBe(1);
    expect(await main(["--no-checker", join(tmp, "bad")])).toBe(1);
  });
});
