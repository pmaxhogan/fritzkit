/**
 * .fzpz = a FLAT zip (no directories) holding `part.<moduleId>.fzp` plus one
 * `svg.<view>.<base>_<view>.svg` per view (names from identity.fzpzEntryNames).
 * Output is byte-deterministic: fixed compression level and a fixed entry mtime.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { CompiledPart, View } from "../compile/types.js";
import { VIEWS } from "../compile/types.js";
import { writeFileAtomic } from "./bin.js";

export interface FzpzEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Entry mtime. fflate encodes DOS time from LOCAL date components, so build the date from
 * local components too: every machine then writes 2026-01-01 00:00:00 whatever its zone.
 * Built per call (not a module constant) so a TZ change inside the process cannot shift it.
 */
export const fzpzMtime = (): Date => new Date(2026, 0, 1, 0, 0, 0);
export const FZPZ_LEVEL = 6;

/** Zip entries (in the given order) into .fzpz bytes. Throws on bad or duplicate names. */
export function buildFzpzBytes(entries: readonly FzpzEntry[]): Uint8Array {
  const files: Zippable = {};
  for (const e of entries) {
    if (!e.name || /[/\\]/.test(e.name) || e.name === "." || e.name === "..") {
      throw new Error(`invalid .fzpz entry name "${e.name}" (the archive must be flat)`);
    }
    if (Object.prototype.hasOwnProperty.call(files, e.name)) {
      throw new Error(`duplicate .fzpz entry "${e.name}"`);
    }
    files[e.name] = [e.data, { level: FZPZ_LEVEL, mtime: fzpzMtime() }];
  }
  return zipSync(files);
}

/** Write a compiled part as a .fzpz (atomically); returns the absolute output path. */
export async function writeFzpz(
  compiled: Pick<CompiledPart, "entries">,
  outPath: string,
): Promise<string> {
  const abs = resolve(outPath);
  await writeFileAtomic(abs, buildFzpzBytes(compiled.entries));
  return abs;
}

export interface FzpInfo {
  moduleId: string;
  family?: string;
  variant?: string;
  title?: string;
  version?: string;
  /** `<layers image="...">` per view, exactly as written in the fzp. */
  images: Partial<Record<View, string>>;
}

export interface FzpzContents extends FzpInfo {
  entries: FzpzEntry[];
  /** Name of the fzp entry, e.g. part.<moduleId>.fzp. */
  fzpEntry: string;
  fzp: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "property" || name === "layers",
});

function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (typeof v === "object" && "#text" in (v as object)) {
    return String((v as Record<string, unknown>)["#text"]).trim();
  }
  return undefined;
}

/** Pull moduleId, family/variant properties, title, version and layer images from an fzp. */
export function parseFzpInfo(fzp: string): FzpInfo {
  const doc = parser.parse(fzp) as Record<string, unknown>;
  const mod = doc.module as Record<string, unknown> | undefined;
  const moduleId = mod?.["@_moduleId"];
  if (!mod || typeof moduleId !== "string" || moduleId === "") {
    throw new Error("fzp has no <module moduleId=...>");
  }
  const info: FzpInfo = { moduleId, images: {} };
  const props = (mod.properties as Record<string, unknown> | undefined)?.property;
  for (const p of (props as Record<string, unknown>[] | undefined) ?? []) {
    const name = String(p["@_name"] ?? "").toLowerCase();
    const value = text(p);
    if (name === "family" && value !== undefined) info.family = value;
    if (name === "variant" && value !== undefined) info.variant = value;
  }
  const title = text(mod.title);
  if (title !== undefined) info.title = title;
  const version = text(mod.version);
  if (version !== undefined) info.version = version;
  const views = mod.views as Record<string, unknown> | undefined;
  for (const view of VIEWS) {
    const v = views?.[`${view}View`] as Record<string, unknown> | undefined;
    const layers = v?.layers as Record<string, unknown>[] | undefined;
    const image = layers?.[0]?.["@_image"];
    if (typeof image === "string") info.images[view] = image;
  }
  return info;
}

/** Read a .fzpz from disk: entries in archive order plus the parsed fzp. */
export async function readFzpz(path: string): Promise<FzpzContents> {
  const bytes = new Uint8Array(await readFile(path));
  try {
    return parseFzpzBytes(bytes);
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** Same as readFzpz, from bytes. */
export function parseFzpzBytes(bytes: Uint8Array): FzpzContents {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`not a .fzpz: the file is not a readable zip archive (${why})`, { cause: e });
  }
  const entries = Object.entries(files)
    .filter(([name]) => !name.endsWith("/"))
    .map(([name, data]) => ({ name, data }));
  const fzpEntries = entries.filter((e) => /\.fzp$/i.test(e.name));
  if (fzpEntries.length !== 1) {
    throw new Error(`.fzpz must hold exactly one .fzp, found ${fzpEntries.length}`);
  }
  const fzpEntry = fzpEntries[0] as FzpzEntry;
  const fzp = new TextDecoder().decode(fzpEntry.data);
  return { ...parseFzpInfo(fzp), entries, fzpEntry: fzpEntry.name, fzp };
}
