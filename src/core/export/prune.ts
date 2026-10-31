/**
 * List and prune installed parts. Every export gets a new moduleId (identity D12), so a
 * part iterated N times leaves N folders in local_parts/user; prune removes the old ones
 * of one family together with their my_parts.fzb instances (updateBin, default on).
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isFritzingRunning, type FritzingPaths, fritzingPaths } from "../fritzing.js";
import { readBin, removeBinInstances, writeBin } from "./bin.js";
import { parseFzpInfo } from "./fzpz.js";
import { assertSafeModuleId, FritzingRunningError, partDirFor } from "./install.js";

export interface InstalledPart {
  moduleId: string;
  /** Absolute folder under userPartsDir. */
  dir: string;
  fzpPath: string;
  family?: string;
  variant?: string;
  title?: string;
  /** `<version>` of the fzp, when numeric. */
  version?: number;
}

/**
 * Scan userPartsDir: one entry per folder holding an fzp. Uses `<dir>/<dir>.fzp`, else the
 * single *.fzp in the folder. Folders without an fzp (aborted imports), with several
 * candidate fzps, or with an unparsable fzp are skipped. Sorted by folder name.
 */
export async function listInstalledParts(
  paths: Pick<FritzingPaths, "userPartsDir"> = fritzingPaths(),
): Promise<InstalledPart[]> {
  const root = resolve(paths.userPartsDir);
  if (!existsSync(root)) return [];
  const out: InstalledPart[] = [];
  const dirents = await readdir(root, { withFileTypes: true });
  for (const d of dirents.filter((x) => x.isDirectory()).sort((a, b) => cmp(a.name, b.name))) {
    const dir = join(root, d.name);
    const fzps = (await readdir(dir)).filter((f) => /\.fzp$/i.test(f));
    const name = fzps.includes(`${d.name}.fzp`)
      ? `${d.name}.fzp`
      : fzps.length === 1
        ? (fzps[0] as string)
        : undefined;
    if (!name) continue;
    const fzpPath = join(dir, name);
    try {
      if (!(await stat(fzpPath)).isFile()) continue;
      const info = parseFzpInfo(await readFile(fzpPath, "utf8"));
      const part: InstalledPart = { moduleId: info.moduleId, dir, fzpPath };
      if (info.family !== undefined) part.family = info.family;
      if (info.variant !== undefined) part.variant = info.variant;
      if (info.title !== undefined) part.title = info.title;
      const v = Number(info.version);
      if (info.version !== undefined && Number.isFinite(v)) part.version = v;
      out.push(part);
    } catch {
      continue;
    }
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Version number of a part: `<version>`, else the N of a "vN ..." variant, else 0. */
function versionOf(p: InstalledPart): number {
  if (p.version !== undefined) return p.version;
  const m = /^v(\d+(?:\.\d+)?)\b/.exec(p.variant ?? "");
  return m ? Number(m[1]) : 0;
}

/** Newest first: higher version, then variant string, then moduleId (descending). */
function newerFirst(a: InstalledPart, b: InstalledPart): number {
  return (
    versionOf(b) - versionOf(a) ||
    cmp(b.variant ?? "", a.variant ?? "") ||
    cmp(b.moduleId, a.moduleId)
  );
}

export interface PrunePlanOptions {
  family: string;
  /** moduleId(s) to keep. Default: keep only the newest member of the family. */
  keep?: string | string[];
  /** Only ever remove moduleIds starting with "fritzkit-" (default true). */
  onlyFritzkit?: boolean;
}

export interface PrunePlan {
  remove: InstalledPart[];
  keep: InstalledPart[];
}

/**
 * Pure: split the installed members of a family into remove / keep. "Newest" is decided
 * from the fzp content only (`<version>`, then the variant string), never file mtimes,
 * so the plan is deterministic. Parts outside the "fritzkit-" namespace are always kept
 * when onlyFritzkit is on. Parts of other families are ignored. Throws when a keep id
 * is not an installed member of the family.
 */
export function prunePlan(installed: readonly InstalledPart[], opts: PrunePlanOptions): PrunePlan {
  const onlyFritzkit = opts.onlyFritzkit !== false;
  const members = installed.filter((p) => p.family === opts.family).sort(newerFirst);
  const protectedParts = onlyFritzkit
    ? members.filter((p) => !p.moduleId.startsWith("fritzkit-"))
    : [];
  const candidates = members.filter((p) => !protectedParts.includes(p));
  let keepIds: Set<string>;
  if (opts.keep !== undefined) {
    keepIds = new Set(Array.isArray(opts.keep) ? opts.keep : [opts.keep]);
    // A mistyped keep id would otherwise silently plan the removal of every version.
    const unknown = [...keepIds].filter((id) => !members.some((p) => p.moduleId === id));
    if (unknown.length > 0) {
      throw new Error(
        `keep: ${unknown.map((id) => `"${id}"`).join(", ")} is not an installed member of ` +
          `family "${opts.family}"`,
      );
    }
  } else {
    keepIds = new Set(candidates.slice(0, 1).map((p) => p.moduleId));
  }
  return {
    remove: candidates.filter((p) => !keepIds.has(p.moduleId)),
    keep: members.filter((p) => keepIds.has(p.moduleId) || protectedParts.includes(p)),
  };
}

export interface PruneOptions {
  /** Actually delete; without it prune is a dry run. */
  yes: boolean;
  paths?: FritzingPaths;
  /** Prune even while Fritzing is running. */
  force?: boolean;
  /** Remove the pruned parts' instances from my_parts.fzb (default true, see install.ts). */
  updateBin?: boolean;
  /** Back the bin up before writing it (default true). */
  backupBin?: boolean;
  isRunning?: () => Promise<boolean>;
  now?: () => Date;
  /** Injected for tests; defaults to a recursive rm. */
  removeDir?: (dir: string) => Promise<void>;
}

export interface PruneResult {
  /** Folders removed (or that would be removed on a dry run). */
  removedDirs: string[];
  /** moduleIds whose bin instances were removed (or would be); empty with updateBin: false. */
  removedBinEntries: string[];
  dryRun: boolean;
  binBackupPath?: string;
  /** Folders that could not be removed; their bin instances are kept. */
  failed: { dir: string; moduleId: string; error: string }[];
}

/**
 * Execute a plan. Dry run unless opts.yes. Only deletes a folder whose resolved path is
 * directly under userPartsDir and whose name equals the moduleId being pruned; every
 * check runs for every part before the first deletion.
 */
export async function prune(plan: PrunePlan, opts: PruneOptions): Promise<PruneResult> {
  const paths = opts.paths ?? fritzingPaths();
  const root = resolve(paths.userPartsDir);
  const targets: { dir: string; moduleId: string }[] = [];
  for (const p of plan.remove) {
    assertSafeModuleId(p.moduleId);
    const dir = partDirFor(root, p.moduleId);
    if (resolve(p.dir) !== dir || !dir.startsWith(root + sep)) {
      throw new Error(
        `refusing to prune ${p.dir}: it is not ${dir} (folder name must equal moduleId)`,
      );
    }
    targets.push({ dir, moduleId: p.moduleId });
  }
  const bin = opts.updateBin !== false ? await readBin(paths.myPartsBin) : undefined;
  const inBin = (ids: Set<string>) =>
    bin
      ? [...new Set(bin.instances.filter((i) => ids.has(i.moduleIdRef)).map((i) => i.moduleIdRef))]
      : [];
  const existing = targets.filter((t) => existsSync(t.dir));
  if (!opts.yes) {
    return {
      removedDirs: existing.map((t) => t.dir),
      removedBinEntries: inBin(new Set(targets.map((t) => t.moduleId))),
      dryRun: true,
      failed: [],
    };
  }

  if (!opts.force && (await (opts.isRunning ?? isFritzingRunning)())) {
    throw new FritzingRunningError("prune");
  }
  // Folders first; only ids whose folder is really gone leave the bin, so a failed rm
  // never leaves a bin that disagrees with the parts folder.
  const removeDir = opts.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  const result: PruneResult = { removedDirs: [], removedBinEntries: [], dryRun: false, failed: [] };
  const gone = new Set(targets.filter((t) => !existsSync(t.dir)).map((t) => t.moduleId));
  for (const t of existing) {
    try {
      await removeDir(t.dir);
      result.removedDirs.push(t.dir);
      gone.add(t.moduleId);
    } catch (e) {
      result.failed.push({ ...t, error: e instanceof Error ? e.message : String(e) });
    }
  }
  result.removedBinEntries = inBin(gone);
  if (bin && result.removedBinEntries.length > 0) {
    const xml = removeBinInstances(bin.xml, (i) => gone.has(i.moduleIdRef));
    const bak = await writeBin(paths.myPartsBin, xml, {
      backup: opts.backupBin !== false,
      now: opts.now,
    });
    if (bak) result.binBackupPath = bak;
  }
  return result;
}
