import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Call-through spies on every fs entry point the export code uses, so the traversal
// test can assert that nothing touched the filesystem.
const fsSpy = vi.hoisted(() => ({ existsSync: undefined as unknown as ReturnType<typeof vi.fn> }));
const fspSpies = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  fsSpy.existsSync = vi.fn(orig.existsSync);
  return { ...orig, existsSync: fsSpy.existsSync };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  const out: Record<string, unknown> = { ...orig };
  for (const k of ["mkdir", "writeFile", "rename", "rm", "readFile", "copyFile"] as const) {
    fspSpies[k] = vi.fn(orig[k] as (...a: unknown[]) => unknown);
    out[k] = fspSpies[k];
  }
  return out;
});
import {
  binInstancePath,
  EMPTY_MY_PARTS_BIN,
  FritzingRunningError,
  installPart,
  isSafeEntryName,
  parseBinInstances,
  partDirFor,
  plannedInstallLayout,
  writeFzpz,
} from "../src/core/export/index.js";
import { FIXED_NOW, notRunning, swapV1, tempFritzing, vectorPart } from "./export-helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
function tmp() {
  const t = tempFritzing();
  cleanups.push(t.cleanup);
  return t;
}
const ID = "fritzkit-spike-vector-00000001";
const enc = new TextEncoder();

describe("plannedInstallLayout", () => {
  it("maps the flat entries onto Fritzing's folder layout", () => {
    const { paths } = tmp();
    const l = plannedInstallLayout(vectorPart().entries, paths);
    const dir = resolve(paths.userPartsDir, ID);
    expect(l.moduleId).toBe(ID);
    expect(l.dir).toBe(dir);
    expect(l.fzpPath).toBe(join(dir, `${ID}.fzp`));
    expect(l.files).toEqual({
      [`part.${ID}.fzp`]: join(dir, `${ID}.fzp`),
      [`svg.breadboard.${ID}_breadboard.svg`]: join(dir, "breadboard", `${ID}_breadboard.svg`),
      [`svg.schematic.${ID}_schematic.svg`]: join(dir, "schematic", `${ID}_schematic.svg`),
      [`svg.pcb.${ID}_pcb.svg`]: join(dir, "pcb", `${ID}_pcb.svg`),
      [`svg.icon.${ID}_icon.svg`]: join(dir, "icon", `${ID}_icon.svg`),
    });
  });

  it("rejects unsafe and colliding entries, ignores ones Fritzing would skip", () => {
    const { paths } = tmp();
    const base = vectorPart().entries;
    const d = enc.encode("<svg/>");
    const bad = (name: string) => plannedInstallLayout([...base, { name, data: d }], paths);
    expect(() => bad("svg.icon..._icon.svg")).toThrow(/unsafe/);
    expect(() => bad("svg.icon.a\\b.svg")).toThrow(/unsafe/);
    expect(() => bad("svg.icon.a/b.svg")).toThrow(/unsafe/);
    expect(() => bad("../evil.svg")).toThrow(/unsafe/);
    expect(() => bad("C:evil.svg")).toThrow(/unsafe/);
    expect(bad("svg.foo.x.svg").ignored).toEqual(["svg.foo.x.svg"]);
    expect(bad("readme.txt").ignored).toEqual(["readme.txt"]);
    expect(Object.keys(bad("readme.txt").files)).toHaveLength(5);
    expect(() => bad(`svg.icon.${ID}_icon.svg`)).toThrow(/two entries/);
    expect(() => plannedInstallLayout(base.slice(1), paths)).toThrow(/exactly one/);
  });
});

describe("path traversal guard", () => {
  it("rejects a moduleId like ..\\x before any fs call", async () => {
    const { paths } = tmp();
    const evil = vectorPart().entries.map((e) =>
      e.name.endsWith(".fzp")
        ? { ...e, data: enc.encode(new TextDecoder().decode(e.data).replaceAll(ID, "..\\x")) }
        : e,
    );
    const spies = [fsSpy.existsSync, ...Object.values(fspSpies)];
    expect(spies).toHaveLength(7);
    for (const sp of spies) sp.mockClear();
    await expect(installPart({ entries: evil }, { paths, isRunning: notRunning })).rejects.toThrow(
      /unsafe moduleId/,
    );
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(() => partDirFor(paths.userPartsDir, "../../etc")).toThrow(/unsafe/);
    expect(() => partDirFor(paths.userPartsDir, "........")).toThrow(/unsafe/);
    expect(() => partDirFor(paths.userPartsDir, "short")).toThrow(/unsafe/);
    for (const id of [
      "",
      "..",
      "..\\x",
      "a/bcdefghij",
      "C:\\Windows\\x",
      "C:abcdefgh",
      "\\\\server\\share\\x",
      "fritzkit-x-12345678.",
      "NUL.abcdefgh",
      "com1.abcdefgh",
      "fritzkit x 12345678",
    ]) {
      expect(() => partDirFor(paths.userPartsDir, id), id).toThrow(/unsafe/);
    }
    expect(readdirSync(paths.userPartsDir)).toEqual([]);
  });
});

describe("installPart", () => {
  it("writes the folder layout; every fzp image resolves to an installed file", async () => {
    const { paths } = tmp();
    const r = await installPart(vectorPart(), { paths, isRunning: notRunning });
    expect(r.moduleId).toBe(ID);
    expect(r.alreadyInstalled).toBe(false);
    expect(r.binUpdated).toBe(true);
    expect(r.files).toHaveLength(5);
    const dir = join(paths.userPartsDir, ID);
    expect(readdirSync(dir).sort()).toEqual(
      [`${ID}.fzp`, "breadboard", "icon", "pcb", "schematic"].sort(),
    );
    const fzp = readFileSync(join(dir, `${ID}.fzp`), "utf8");
    expect(fzp).toBe(vectorPart().fzp);
    const images = [...fzp.matchAll(/image="([^"]+)"/g)].map((m) => m[1]!);
    expect(images).toHaveLength(4);
    for (const img of images) expect(existsSync(join(dir, img))).toBe(true);
    // The fs spies are live (so the traversal test's "never called" means something).
    expect(fspSpies.writeFile).toHaveBeenCalled();
    expect(fsSpy.existsSync).toHaveBeenCalled();
    // Default: the bin gets an instance with the absolute fzp path (verified in Fritzing).
    expect(parseBinInstances(readFileSync(paths.myPartsBin, "utf8"))).toEqual([
      {
        moduleIdRef: ID,
        modelIndex: 100000,
        path: join(dir, `${ID}.fzp`).replace(/\\/g, "/"),
      },
    ]);
  });

  it("leaves the bin alone with updateBin: false", async () => {
    const { paths } = tmp();
    const r = await installPart(vectorPart(), { paths, isRunning: notRunning, updateBin: false });
    expect(r.binUpdated).toBe(false);
    expect(r.binBackupPath).toBeUndefined();
    expect(existsSync(join(r.installedDir, `${ID}.fzp`))).toBe(true);
    expect(existsSync(paths.myPartsBin)).toBe(false);
  });

  it("installs from a .fzpz path", async () => {
    const { paths, root } = tmp();
    const out = await writeFzpz(vectorPart(), join(root, "v.fzpz"));
    const r = await installPart(out, { paths, isRunning: notRunning });
    expect(existsSync(join(r.installedDir, "breadboard", `${ID}_breadboard.svg`))).toBe(true);
  });

  it("re-install is idempotent, keeps foreign files and does not duplicate the bin entry", async () => {
    const { paths } = tmp();
    writeFileSync(paths.myPartsBin, EMPTY_MY_PARTS_BIN);
    const opts = { paths, isRunning: notRunning, updateBin: true, now: FIXED_NOW };
    const first = await installPart(vectorPart(), opts);
    expect(first.binUpdated).toBe(true);
    expect(first.binBackupPath).toBe(`${paths.myPartsBin}.bak-20260102-030405`);
    expect(readFileSync(first.binBackupPath!, "utf8")).toBe(EMPTY_MY_PARTS_BIN);
    const binAfterFirst = readFileSync(paths.myPartsBin, "utf8");
    writeFileSync(join(first.installedDir, "pcb", "stale_pcb.svg"), "<svg/>");

    const second = await installPart(vectorPart(), opts);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.binUpdated).toBe(false);
    expect(second.binBackupPath).toBeUndefined();
    expect(readFileSync(paths.myPartsBin, "utf8")).toBe(binAfterFirst);
    expect(existsSync(join(first.installedDir, "pcb", "stale_pcb.svg"))).toBe(true);
    const inst = parseBinInstances(binAfterFirst);
    expect(inst).toEqual([
      {
        moduleIdRef: ID,
        modelIndex: 100000,
        path: join(paths.userPartsDir, ID, `${ID}.fzp`).replace(/\\/g, "/"),
      },
    ]);
    // Only one backup was taken (second install wrote nothing to the bin).
    expect(readdirSync(paths.binsDir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  it("creates the bin when missing (no backup) and supports a custom path function", async () => {
    const { paths } = tmp();
    const r = await installPart(swapV1(), {
      paths,
      isRunning: notRunning,
      updateBin: true,
      instancePath: (abs) => abs.split(/[\\/]/).at(-1)!,
    });
    expect(r.binBackupPath).toBeUndefined();
    const xml = readFileSync(paths.myPartsBin, "utf8");
    expect(xml).toContain(
      '        <instance moduleIdRef="fritzkit-spike-swap-v1-00000001" modelIndex="100000" ' +
        'path="fritzkit-spike-swap-v1-00000001.fzp">\r\n',
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n<module')).toBe(true);
  });

  it("skips the bin backup when backupBin is false", async () => {
    const { paths } = tmp();
    writeFileSync(paths.myPartsBin, EMPTY_MY_PARTS_BIN);
    const r = await installPart(vectorPart(), {
      paths,
      isRunning: notRunning,
      updateBin: true,
      backupBin: false,
    });
    expect(r.binUpdated).toBe(true);
    expect(r.binBackupPath).toBeUndefined();
    expect(readdirSync(paths.binsDir)).toEqual(["my_parts.fzb"]);
  });

  it("dry run reports the plan and writes nothing", async () => {
    const { paths } = tmp();
    const r = await installPart(vectorPart(), {
      paths,
      dryRun: true,
      updateBin: true,
      isRunning: async () => true,
    });
    expect(r.skipped).toBe("dry run");
    expect(r.binUpdated).toBe(true);
    expect(r.files).toHaveLength(5);
    expect(readdirSync(paths.userPartsDir)).toEqual([]);
    expect(existsSync(paths.myPartsBin)).toBe(false);
  });

  it("refuses while Fritzing is running unless forced", async () => {
    const { paths } = tmp();
    const running = async () => true;
    const err = await installPart(vectorPart(), { paths, isRunning: running }).catch((e) => e);
    expect(err).toBeInstanceOf(FritzingRunningError);
    expect(err.message).toMatch(/needs Fritzing closed/);
    expect(err.message).toMatch(/would not see/);
    expect(err.message).toMatch(/startup/);
    expect(err.message).toMatch(/rewrites the bin/);
    expect(readdirSync(paths.userPartsDir)).toEqual([]);
    const r = await installPart(vectorPart(), { paths, isRunning: running, force: true });
    expect(existsSync(r.installedDir)).toBe(true);
  });

  it("installs a third-party archive with extra entries, skipping them with a warning", async () => {
    const { paths } = tmp();
    const entries = [
      ...vectorPart().entries,
      { name: "readme.txt", data: enc.encode("hi") },
      { name: "svg.foo.x.svg", data: enc.encode("<svg/>") },
    ];
    const r = await installPart({ entries }, { paths, isRunning: notRunning });
    expect(r.ignoredEntries).toEqual(["readme.txt", "svg.foo.x.svg"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.files).toHaveLength(5);
    expect(readdirSync(r.installedDir).sort()).toEqual(
      [`${ID}.fzp`, "breadboard", "icon", "pcb", "schematic"].sort(),
    );
  });

  it("installs third-party entry names with spaces, parentheses and +", async () => {
    const { paths } = tmp();
    const bbName = "Adafruit 4980 (QT) I2C+_breadboard.svg";
    const entries = vectorPart().entries.map((e) => {
      if (e.name.startsWith("svg.breadboard.")) return { ...e, name: `svg.breadboard.${bbName}` };
      if (!e.name.endsWith(".fzp")) return e;
      const fzp = new TextDecoder()
        .decode(e.data)
        .replace(`breadboard/${ID}_breadboard.svg`, `breadboard/${bbName}`);
      return { ...e, data: enc.encode(fzp) };
    });
    const r = await installPart({ entries }, { paths, isRunning: notRunning });
    const target = join(paths.userPartsDir, ID, "breadboard", bbName);
    expect(r.files).toContain(target);
    expect(readFileSync(target, "utf8")).toBe(vectorPart().svgs.breadboard);
  });

  it("isSafeEntryName allows common third-party names and rejects risky ones", () => {
    for (const ok of [
      "svg.breadboard.Adafruit 4980 (QT) I2C_breadboard.svg",
      "part.Adafruit 4980 NeoKey 1x4 QT I2C.fzp",
      "svg.pcb.a+b,c;d=e[1]_pcb.svg",
    ]) {
      expect(isSafeEntryName(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "a/b.svg",
      "a\\b.svg",
      "C:x.svg",
      "a*.svg",
      "a?.svg",
      'a".svg',
      "a<b.svg",
      "a>b.svg",
      "a|b.svg",
      "a\tb.svg",
      "a\u0000b.svg",
      "a\u007fb.svg",
      "svg.icon..x.svg",
      ".hidden.svg",
      "x.svg.",
      "x.svg ",
      "..",
    ]) {
      expect(isSafeEntryName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects an fzp whose image does not match any entry", async () => {
    const { paths } = tmp();
    const entries = vectorPart().entries.filter((e) => !e.name.startsWith("svg.icon."));
    await expect(installPart({ entries }, { paths, isRunning: notRunning })).rejects.toThrow(
      /iconView image/,
    );
  });
});

describe("binInstancePath", () => {
  it("returns the absolute fzp path with forward slashes", () => {
    expect(binInstancePath("C:\\a\\b\\x.fzp", "x")).toBe("C:/a/b/x.fzp");
  });
});
