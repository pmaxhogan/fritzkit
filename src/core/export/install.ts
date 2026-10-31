/**
 * Install a part the way Fritzing's own .fzpz import lays it out:
 *
 *   <userPartsDir>/<moduleId>/<moduleId>.fzp           (the "part." prefix stripped)
 *   <userPartsDir>/<moduleId>/<view>/<base>_<view>.svg  (the "svg.<view>." prefix stripped)
 *
 * plus an instance in Documents/Fritzing/bins/my_parts.fzb (updateBin, default on).
 * Verified on Fritzing 1.0.7b: the My Parts bin shows only what my_parts.fzb lists (it is
 * not rebuilt from local_parts/user), and an instance whose path is the absolute fzp path
 * makes the part appear there after a restart. Fritzing must be closed: it reads
 * my_parts.fzb and local_parts only at startup and rewrites the bin file on exit.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isFritzingRunning, type FritzingPaths, fritzingPaths } from "../fritzing.js";
import { MODULE_ID_RE } from "../identity.js";
import type { CompiledPart, View } from "../compile/types.js";
import { VIEWS } from "../compile/types.js";
import { addBinInstance, readBin, writeBin, writeFileAtomic } from "./bin.js";
import { parseFzpInfo, readFzpz, type FzpzEntry } from "./fzpz.js";

export class FritzingRunningError extends Error {
  constructor(action = "install") {
    super(
      `Fritzing is running; ${action} needs Fritzing closed. Fritzing reads my_parts.fzb ` +
        `and local_parts only at startup (it would not see the change) and rewrites the bin ` +
        `file on exit (it would overwrite the my_parts.fzb edit). Close Fritzing and retry, ` +
        `or pass force to do it anyway.`,
    );
    this.name = "FritzingRunningError";
  }
}

/** Windows device names, which stay devices even with an extension (e.g. NUL.abcdef). */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Throw unless moduleId is a safe single path segment (checked before any fs call). A
 * trailing "." is refused because Windows strips it, so "x-12345678." would alias the
 * folder "x-12345678".
 */
export function assertSafeModuleId(moduleId: string): void {
  if (
    typeof moduleId !== "string" ||
    !MODULE_ID_RE.test(moduleId) ||
    /^\.+$/.test(moduleId) ||
    moduleId.endsWith(".") ||
    WINDOWS_DEVICE_RE.test(moduleId)
  ) {
    throw new Error(
      `unsafe moduleId "${moduleId}": only letters, digits, "-", "_" and "." are allowed ` +
        `(no trailing ".", no Windows device name)`,
    );
  }
}

/** Absolute dir of a part inside userPartsDir; throws if it would escape the folder. */
export function partDirFor(userPartsDir: string, moduleId: string): string {
  assertSafeModuleId(moduleId);
  const root = resolve(userPartsDir);
  const dir = resolve(root, moduleId);
  if (!dir.startsWith(root + sep) || dir.slice(root.length + 1) !== moduleId) {
    throw new Error(`moduleId "${moduleId}" resolves outside ${root}`);
  }
  return dir;
}

export interface InstallLayout {
  moduleId: string;
  dir: string;
  fzpPath: string;
  /** zip entry name -> absolute install path */
  files: Record<string, string>;
  /** Entries Fritzing's own importer would not install either; they are not written. */
  ignored: string[];
}

/**
 * Entry names are single file names. Third-party parts use spaces, parentheses and "+"
 * (e.g. "Adafruit 4980 NeoKey 1x4 QT I2C"), so only what Windows forbids or what could
 * escape the folder is rejected: / \ : * ? " < > |, control chars, empty dot segments
 * (".." included) and a trailing dot or space.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[/\\:*?"<>|\x00-\x1f\x7f]/;

export function isSafeEntryName(name: string): boolean {
  return (
    name !== "" &&
    !UNSAFE_NAME_CHARS.test(name) &&
    !name.split(".").some((s) => s === "") &&
    !/[. ]$/.test(name)
  );
}

function fzpOf(entries: readonly FzpzEntry[]): FzpzEntry {
  const fzps = entries.filter((e) => /\.fzp$/i.test(e.name));
  if (fzps.length !== 1) throw new Error(`expected exactly one .fzp entry, got ${fzps.length}`);
  return fzps[0] as FzpzEntry;
}

/**
 * Pure: where every entry goes. The folder name is the moduleId read from the fzp
 * content; entry names map `part.X.fzp` -> `X.fzp` and `svg.<view>.Y.svg` -> `<view>/Y.svg`.
 * Rejects any entry name with a path separator, `..` or other unsafe characters (a sign
 * of a hostile archive). Other entries (readme, unknown view) are listed in `ignored` and
 * not written: Fritzing's importer (moveToPartsFolder) likewise only copies part.* and
 * the svg.* files the fzp references, and silently skips the rest.
 */
export function plannedInstallLayout(
  entries: readonly FzpzEntry[],
  paths: Pick<FritzingPaths, "userPartsDir">,
): InstallLayout {
  const fzpEntry = fzpOf(entries);
  const { moduleId } = parseFzpInfo(new TextDecoder().decode(fzpEntry.data));
  const dir = partDirFor(paths.userPartsDir, moduleId);
  const files: Record<string, string> = {};
  const ignored: string[] = [];
  let fzpPath = "";
  for (const e of entries) {
    if (!isSafeEntryName(e.name)) {
      throw new Error(`unsafe .fzpz entry name "${e.name}"`);
    }
    let target: string;
    const svg = /^svg\.([a-z]+)\.(.+\.svg)$/i.exec(e.name);
    if (e === fzpEntry) {
      target = resolve(dir, e.name.replace(/^part\./, ""));
      fzpPath = target;
    } else if (svg) {
      const view = svg[1] as string;
      if (!(VIEWS as readonly string[]).includes(view)) {
        ignored.push(e.name);
        continue;
      }
      target = resolve(dir, view, svg[2] as string);
    } else {
      ignored.push(e.name);
      continue;
    }
    if (!target.startsWith(dir + sep)) throw new Error(`entry "${e.name}" escapes ${dir}`);
    if (Object.values(files).includes(target)) {
      throw new Error(`two entries install to ${target}`);
    }
    files[e.name] = target;
  }
  return { moduleId, dir, fzpPath, files, ignored };
}

/**
 * The `path` attribute written into the bin instance. Default: the absolute installed
 * fzp path with forward slashes, verified on Fritzing 1.0.7b to make the part appear in
 * My Parts after a restart. (search.fzb/core.fzb use the bare file name for core parts.)
 */
export function binInstancePath(fzpAbs: string, _moduleId: string): string {
  return fzpAbs.replace(/\\/g, "/");
}

export interface InstallOptions {
  paths?: FritzingPaths;
  /** Install even while Fritzing is running. */
  force?: boolean;
  /** Add an instance to my_parts.fzb so the part shows in My Parts (default true). */
  updateBin?: boolean;
  /** Back the bin up before writing it (default true). */
  backupBin?: boolean;
  /** Compute and report, write nothing. */
  dryRun?: boolean;
  /** Injected for tests; defaults to isFritzingRunning. */
  isRunning?: () => Promise<boolean>;
  /** Injected for tests (backup file timestamp). */
  now?: () => Date;
  /** Bin `path` attribute; defaults to binInstancePath. */
  instancePath?: (fzpAbs: string, moduleId: string) => string;
}

export interface InstallResult {
  moduleId: string;
  installedDir: string;
  /** Absolute paths of the files written (or that would be written on a dry run). */
  files: string[];
  binPath: string;
  binBackupPath?: string;
  /** True when the folder already held this moduleId's fzp (re-install). */
  alreadyInstalled: boolean;
  /** Whether the bin gained (or would gain) an instance; false with updateBin: false. */
  binUpdated: boolean;
  /** Set when nothing was written, with the reason (e.g. "dry run"). */
  skipped?: string;
  /** Archive entries that were not installed (see plannedInstallLayout). */
  ignoredEntries: string[];
  /** Human-readable notes, e.g. one per ignored entry. */
  warnings: string[];
}

/** Input: a .fzpz path or anything carrying the flat entries (a CompiledPart). */
export type InstallSource = string | Pick<CompiledPart, "entries">;

export async function installPart(
  source: InstallSource,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const paths = opts.paths ?? fritzingPaths();
  const entries = typeof source === "string" ? (await readFzpz(source)).entries : source.entries;
  const layout = plannedInstallLayout(entries, paths);

  // Every image the fzp points at must be one of the files we install.
  const info = parseFzpInfo(new TextDecoder().decode(fzpOf(entries).data));
  const targets = new Set(Object.values(layout.files));
  for (const [view, image] of Object.entries(info.images) as [View, string][]) {
    if (!targets.has(resolve(layout.dir, image))) {
      throw new Error(`fzp ${view}View image "${image}" is not among the .fzpz entries`);
    }
  }

  const alreadyInstalled = existsSync(layout.fzpPath);
  const binPath = paths.myPartsBin;
  let newXml: string | undefined;
  if (opts.updateBin !== false) {
    const bin = await readBin(binPath);
    const instancePath = (opts.instancePath ?? binInstancePath)(layout.fzpPath, layout.moduleId);
    const xml = addBinInstance(bin.xml, { moduleIdRef: layout.moduleId, path: instancePath });
    if (xml !== bin.xml || !existsSync(binPath)) newXml = xml;
  }
  const binUpdated = newXml !== undefined;
  const result: InstallResult = {
    moduleId: layout.moduleId,
    installedDir: layout.dir,
    files: Object.values(layout.files),
    binPath,
    alreadyInstalled,
    binUpdated,
    ignoredEntries: layout.ignored,
    warnings: layout.ignored.map(
      (n) =>
        `ignored .fzpz entry "${n}" (not part.*.fzp or svg.<view>.*.svg; Fritzing skips it too)`,
    ),
  };
  if (opts.dryRun) return { ...result, skipped: "dry run" };

  if (!opts.force && (await (opts.isRunning ?? isFritzingRunning)())) {
    throw new FritzingRunningError("install");
  }

  for (const e of entries) {
    const target = layout.files[e.name];
    if (target !== undefined) await writeFileAtomic(target, e.data);
  }
  if (newXml !== undefined) {
    const bak = await writeBin(binPath, newXml, {
      backup: opts.backupBin !== false,
      now: opts.now,
    });
    if (bak) result.binBackupPath = bak;
  }
  return result;
}
