import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FritzingRunningError,
  installPart,
  listInstalledParts,
  parseBinInstances,
  prune,
  prunePlan,
  type InstalledPart,
} from "../src/core/export/index.js";
import type { FritzingPaths } from "../src/core/fritzing.js";
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const V1 = "fritzkit-spike-swap-v1-00000001";

/** Version n of the swap family: new moduleId, <version>n</version>, variant "vn hash". */
function swapVersion(n: number) {
  const id = `fritzkit-spike-swap-0000000${n}`;
  const entries = swapV1().entries.map((e) => {
    let text = dec.decode(e.data).replaceAll(V1, id);
    if (e.name.endsWith(".fzp")) {
      text = text
        .replace("<version>1</version>", `<version>${n}</version>`)
        .replace(/<property name="variant">[^<]*</, `<property name="variant">v${n} 0000000${n}<`);
    }
    return { name: e.name.replaceAll(V1, id), data: enc.encode(text) };
  });
  return { id, entries };
}

async function installThree(paths: FritzingPaths) {
  const ids: string[] = [];
  for (const n of [2, 1, 3]) {
    const v = swapVersion(n);
    await installPart(v, { paths, isRunning: notRunning, updateBin: true, now: FIXED_NOW });
    ids[n] = v.id;
  }
  await installPart(vectorPart(), { paths, isRunning: notRunning, updateBin: true });
  return ids as [string, string, string, string];
}

describe("listInstalledParts", () => {
  it("lists folders with an fzp, tolerating skeletons and odd fzp names", async () => {
    const { paths } = tmp();
    const ids = await installThree(paths);
    mkdirSync(join(paths.userPartsDir, "skeleton_part_1", "breadboard"), { recursive: true });
    const odd = join(paths.userPartsDir, "fd7bc393ad1fcd6608c3b0309dbe33fa");
    mkdirSync(odd);
    writeFileSync(
      join(odd, "Some_Other_Name.fzp"),
      '<module moduleId="fd7bc393ad1fcd6608c3b0309dbe33fa"><title>Odd</title></module>',
    );
    const broken = join(paths.userPartsDir, "broken_part_1");
    mkdirSync(broken);
    writeFileSync(join(broken, "broken_part_1.fzp"), "<nope/>");
    const two = join(paths.userPartsDir, "two_fzps_1");
    mkdirSync(two);
    writeFileSync(join(two, "a.fzp"), '<module moduleId="aaaaaaaa"/>');
    writeFileSync(join(two, "b.fzp"), '<module moduleId="bbbbbbbb"/>');
    writeFileSync(join(paths.userPartsDir, "stray.txt"), "x");

    const parts = await listInstalledParts(paths);
    expect(parts.map((p) => p.moduleId)).toEqual([
      "fd7bc393ad1fcd6608c3b0309dbe33fa",
      ids[1],
      ids[2],
      ids[3],
      "fritzkit-spike-vector-00000001",
    ]);
    const odd1 = parts[0]!;
    expect(odd1.fzpPath).toBe(join(odd, "Some_Other_Name.fzp"));
    expect(odd1.title).toBe("Odd");
    expect(odd1.family).toBeUndefined();
    const v3 = parts[3]!;
    expect(v3).toEqual({
      moduleId: ids[3],
      dir: join(paths.userPartsDir, ids[3]),
      fzpPath: join(paths.userPartsDir, ids[3], `${ids[3]}.fzp`),
      family: "fritzkit-spike-swap",
      variant: "v3 00000003",
      title: "Swap spike v1",
      version: 3,
    });
  });

  it("returns [] when the user parts folder does not exist", async () => {
    const { paths } = tmp();
    expect(await listInstalledParts({ userPartsDir: join(paths.userPartsDir, "nope") })).toEqual(
      [],
    );
  });
});

describe("prunePlan", () => {
  const p = (moduleId: string, extra: Partial<InstalledPart> = {}): InstalledPart => ({
    moduleId,
    dir: `/u/${moduleId}`,
    fzpPath: `/u/${moduleId}/${moduleId}.fzp`,
    family: "fam",
    ...extra,
  });

  it("keeps the newest of three versions by default", () => {
    const parts = [
      p("fritzkit-fam-a", { version: 2 }),
      p("fritzkit-fam-b", { version: 3 }),
      p("fritzkit-fam-c", { version: 1 }),
      p("fritzkit-other", { family: "other", version: 9 }),
    ];
    const plan = prunePlan(parts, { family: "fam" });
    expect(plan.keep.map((x) => x.moduleId)).toEqual(["fritzkit-fam-b"]);
    expect(plan.remove.map((x) => x.moduleId)).toEqual(["fritzkit-fam-a", "fritzkit-fam-c"]);
  });

  it("falls back to the variant version, then the variant string", () => {
    const parts = [
      p("fritzkit-fam-a", { variant: "v2 aaaa" }),
      p("fritzkit-fam-b", { variant: "v10 bbbb" }),
      p("fritzkit-fam-c", { variant: "v10 cccc" }),
      p("fritzkit-fam-d"),
    ];
    expect(prunePlan(parts, { family: "fam" }).keep.map((x) => x.moduleId)).toEqual([
      "fritzkit-fam-c",
    ]);
  });

  it("honours keep and protects non-fritzkit parts unless onlyFritzkit is off", () => {
    const parts = [
      p("fritzkit-fam-a", { version: 1 }),
      p("fritzkit-fam-b", { version: 2 }),
      p("vendor_fam_1", { version: 5 }),
    ];
    const plan = prunePlan(parts, { family: "fam", keep: "fritzkit-fam-a" });
    expect(plan.remove.map((x) => x.moduleId)).toEqual(["fritzkit-fam-b"]);
    expect(plan.keep.map((x) => x.moduleId).sort()).toEqual(["fritzkit-fam-a", "vendor_fam_1"]);
    expect(
      prunePlan(parts, { family: "fam", keep: ["fritzkit-fam-a", "fritzkit-fam-b"] }).remove,
    ).toEqual([]);
    const all = prunePlan(parts, { family: "fam", onlyFritzkit: false });
    expect(all.keep.map((x) => x.moduleId)).toEqual(["vendor_fam_1"]);
    expect(all.remove).toHaveLength(2);
    expect(prunePlan(parts, { family: "none" })).toEqual({ remove: [], keep: [] });
  });

  it("throws on a keep id that is not a family member instead of removing everything", () => {
    const parts = [p("fritzkit-fam-a", { version: 1 }), p("fritzkit-fam-b", { version: 2 })];
    expect(() => prunePlan(parts, { family: "fam", keep: "fritzkit-fam-typo" })).toThrow(
      /not an installed member/,
    );
    expect(() => prunePlan(parts, { family: "fam", keep: ["fritzkit-fam-a", "x"] })).toThrow(/"x"/);
  });
});

describe("prune", () => {
  it("dry run deletes nothing", async () => {
    const { paths } = tmp();
    const ids = await installThree(paths);
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    const before = readFileSync(paths.myPartsBin, "utf8");
    const r = await prune(plan, {
      yes: false,
      paths,
      updateBin: true,
      isRunning: async () => true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.removedDirs).toEqual([
      join(paths.userPartsDir, ids[2]),
      join(paths.userPartsDir, ids[1]),
    ]);
    expect(r.removedBinEntries).toEqual([ids[2], ids[1]]);
    expect(readdirSync(paths.userPartsDir)).toHaveLength(4);
    expect(readFileSync(paths.myPartsBin, "utf8")).toBe(before);
  });

  it("--yes deletes the right folders and bin entries, after a backup", async () => {
    const { paths } = tmp();
    const ids = await installThree(paths);
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    const r = await prune(plan, {
      yes: true,
      paths,
      updateBin: true,
      isRunning: notRunning,
      now: () => new Date(2026, 5, 1, 12, 0, 0),
    });
    expect(r.dryRun).toBe(false);
    expect(readdirSync(paths.userPartsDir).sort()).toEqual(
      [ids[3], "fritzkit-spike-vector-00000001"].sort(),
    );
    expect(
      parseBinInstances(readFileSync(paths.myPartsBin, "utf8")).map((i) => i.moduleIdRef),
    ).toEqual([ids[3], "fritzkit-spike-vector-00000001"]);
    expect(r.binBackupPath).toBe(`${paths.myPartsBin}.bak-20260601-120000`);
    expect(parseBinInstances(readFileSync(r.binBackupPath!, "utf8"))).toHaveLength(4);
  });

  it("a failed folder removal keeps that part's bin entry", async () => {
    const { paths } = tmp();
    const ids = await installThree(paths);
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    const r = await prune(plan, {
      yes: true,
      paths,
      updateBin: true,
      isRunning: notRunning,
      now: FIXED_NOW,
      removeDir: async (dir) => {
        if (dir.endsWith(ids[2])) throw new Error("EBUSY: resource busy or locked");
        rmSync(dir, { recursive: true, force: true });
      },
    });
    expect(r.removedDirs).toEqual([join(paths.userPartsDir, ids[1])]);
    expect(r.failed).toEqual([
      {
        dir: join(paths.userPartsDir, ids[2]),
        moduleId: ids[2],
        error: "EBUSY: resource busy or locked",
      },
    ]);
    expect(r.removedBinEntries).toEqual([ids[1]]);
    expect(existsSync(join(paths.userPartsDir, ids[2]))).toBe(true);
    expect(
      parseBinInstances(readFileSync(paths.myPartsBin, "utf8")).map((i) => i.moduleIdRef),
    ).toEqual([ids[2], ids[3], "fritzkit-spike-vector-00000001"]);
  });

  it("drops the bin entry of a planned part whose folder is already gone", async () => {
    const { paths } = tmp();
    const ids = await installThree(paths);
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    rmSync(join(paths.userPartsDir, ids[1]), { recursive: true });
    const r = await prune(plan, { yes: true, paths, updateBin: true, isRunning: notRunning });
    expect(r.removedDirs).toEqual([join(paths.userPartsDir, ids[2])]);
    expect(r.removedBinEntries.sort()).toEqual([ids[1], ids[2]].sort());
    expect(r.failed).toEqual([]);
  });

  it("leaves the bin alone with updateBin: false", async () => {
    const { paths } = tmp();
    await installThree(paths);
    const before = readFileSync(paths.myPartsBin, "utf8");
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    const r = await prune(plan, { yes: true, paths, updateBin: false, isRunning: notRunning });
    expect(r.removedDirs).toHaveLength(2);
    expect(r.removedBinEntries).toEqual([]);
    expect(r.binBackupPath).toBeUndefined();
    expect(readFileSync(paths.myPartsBin, "utf8")).toBe(before);
  });

  it("refuses while Fritzing is running unless forced", async () => {
    const { paths } = tmp();
    await installThree(paths);
    const plan = prunePlan(await listInstalledParts(paths), { family: "fritzkit-spike-swap" });
    await expect(
      prune(plan, { yes: true, paths, isRunning: async () => true }),
    ).rejects.toBeInstanceOf(FritzingRunningError);
    expect(readdirSync(paths.userPartsDir)).toHaveLength(4);
    const r = await prune(plan, { yes: true, paths, force: true, isRunning: async () => true });
    expect(r.removedDirs).toHaveLength(2);
  });

  it("refuses unsafe moduleIds and dirs that do not match the moduleId", async () => {
    const { paths } = tmp();
    const ok = await installPart(vectorPart(), { paths, isRunning: notRunning });
    const base = { yes: true, paths, isRunning: notRunning };
    const evil: InstalledPart = { moduleId: "..\\x", dir: paths.userPartsDir, fzpPath: "x" };
    await expect(prune({ remove: [evil], keep: [] }, base)).rejects.toThrow(/unsafe moduleId/);
    const mismatched: InstalledPart = {
      moduleId: "fritzkit-other-00000009",
      dir: ok.installedDir,
      fzpPath: "x",
    };
    await expect(prune({ remove: [mismatched], keep: [] }, base)).rejects.toThrow(/refusing/);
    expect(existsSync(ok.installedDir)).toBe(true);
  });
});
