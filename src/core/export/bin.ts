/**
 * Fritzing bin files (.fzb), in particular the My Parts bin (my_parts.fzb).
 *
 * The edits are textual on purpose: Fritzing writes the bin with CRLF line endings, a
 * 4-space indent and an odd `icon="Mine.png" >` root tag, and we keep every byte we do
 * not need to touch. Instance shape (as Fritzing writes it in search.fzb):
 *
 *     <instance moduleIdRef="<moduleId>" modelIndex="<int>" path="<fzp path>">
 *         <views/>
 *     </instance>
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface BinInstance {
  moduleIdRef: string;
  modelIndex: number;
  path: string;
}

export interface BinDocument {
  xml: string;
  instances: BinInstance[];
}

/**
 * The minimal My Parts bin, byte for byte what Fritzing 1.0.7 ships on a fresh profile
 * (CRLF, no BOM, note the space before `>` in the module tag).
 */
export const EMPTY_MY_PARTS_BIN =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<module fritzingVersion="0.4.3b.0.0" icon="Mine.png" >\r\n' +
  "    <title>My Parts</title>\r\n" +
  "    <instances></instances>\r\n" +
  "</module>\r\n";

/** Lowest modelIndex handed out when the bin has no instances yet. */
export const FIRST_MODEL_INDEX = 100000;

/** How many `<bin>.bak-*` files to keep next to the bin. */
export const MAX_BIN_BACKUPS = 10;

const INSTANCE_SRC = String.raw`<instance\b[^>]*?(?:\/>|>[\s\S]*?<\/instance\s*>)`;
const ATTR_RE = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function instanceFromXml(instanceXml: string): BinInstance {
  const open = /^<instance\b([^>]*?)\/?>/.exec(instanceXml)?.[1] ?? "";
  const a: Record<string, string> = {};
  for (const m of open.matchAll(ATTR_RE)) {
    a[m[1] as string] = unescapeXml(m[2] ?? m[3] ?? "");
  }
  return {
    moduleIdRef: a.moduleIdRef ?? "",
    modelIndex: Number.parseInt(a.modelIndex ?? "", 10),
    path: a.path ?? "",
  };
}

/** Parse the `<instance>` elements of a bin document (in file order). */
export function parseBinInstances(xml: string): BinInstance[] {
  return [...xml.matchAll(new RegExp(INSTANCE_SRC, "g"))].map((m) => instanceFromXml(m[0]));
}

/** Read a bin file; a missing or empty file yields the minimal My Parts document. */
export async function readBin(path: string): Promise<BinDocument> {
  let xml = "";
  if (existsSync(path)) xml = await readFile(path, "utf8");
  if (xml.trim() === "") xml = EMPTY_MY_PARTS_BIN;
  return { xml, instances: parseBinInstances(xml) };
}

function eolOf(xml: string): string {
  return xml.includes("\r\n") ? "\r\n" : "\n";
}

/** Indent unit of the file: the leading whitespace of the first indented element line. */
function indentUnitOf(xml: string): string {
  return /\n([ \t]+)</.exec(xml)?.[1] ?? "    ";
}

/** Next modelIndex: greater than every existing one, FIRST_MODEL_INDEX at minimum. */
export function nextModelIndex(xml: string): number {
  let max = FIRST_MODEL_INDEX - 1;
  for (const i of parseBinInstances(xml)) {
    if (Number.isFinite(i.modelIndex) && i.modelIndex > max) max = i.modelIndex;
  }
  return max + 1;
}

/**
 * The exact XML of one instance. The first line carries no indent (the caller places
 * it); the following lines are indented with baseIndent (+ indentUnit for `<views/>`).
 */
export function binInstanceXml(
  inst: BinInstance,
  indentUnit = "    ",
  baseIndent = "",
  eol = "\r\n",
): string {
  return (
    `<instance moduleIdRef="${escapeXml(inst.moduleIdRef)}" modelIndex="${inst.modelIndex}" ` +
    `path="${escapeXml(inst.path)}">${eol}` +
    `${baseIndent}${indentUnit}<views/>${eol}` +
    `${baseIndent}</instance>`
  );
}

/**
 * Append an instance just before `</instances>`, keeping the file's line endings and
 * indentation. Returns the xml unchanged when moduleIdRef is already present. A missing
 * modelIndex becomes nextModelIndex(xml).
 */
export function addBinInstance(
  xml: string,
  inst: { moduleIdRef: string; path: string; modelIndex?: number },
): string {
  if (xml.trim() === "") xml = EMPTY_MY_PARTS_BIN;
  if (parseBinInstances(xml).some((i) => i.moduleIdRef === inst.moduleIdRef)) return xml;
  const eol = eolOf(xml);
  const unit = indentUnitOf(xml);
  const full: BinInstance = {
    moduleIdRef: inst.moduleIdRef,
    path: inst.path,
    modelIndex: inst.modelIndex ?? nextModelIndex(xml),
  };

  const selfClosing = /([ \t]*)<instances\s*\/>/.exec(xml);
  if (selfClosing) {
    const outer = selfClosing[1] ?? "";
    const inner = outer + unit;
    const block =
      `${outer}<instances>${eol}${inner}${binInstanceXml(full, unit, inner, eol)}${eol}` +
      `${outer}</instances>`;
    return (
      xml.slice(0, selfClosing.index) + block + xml.slice(selfClosing.index + selfClosing[0].length)
    );
  }

  const close = /<\/instances\s*>/.exec(xml);
  if (!close) throw new Error("bin file has no <instances> element");
  const lineStart = xml.lastIndexOf("\n", close.index - 1) + 1;
  const before = xml.slice(lineStart, close.index);
  if (/^[ \t]*$/.test(before)) {
    // `</instances>` on its own line: insert a new line above it.
    const inner = before + unit;
    const line = `${inner}${binInstanceXml(full, unit, inner, eol)}${eol}`;
    return xml.slice(0, lineStart) + line + xml.slice(lineStart);
  }
  // Inline `<instances></instances>` (or content on the same line): break it open.
  const outer = /^[ \t]*/.exec(before)?.[0] ?? "";
  const inner = outer + unit;
  const head = xml.slice(0, close.index).replace(/[ \t]+$/, "");
  return (
    `${head}${eol}${inner}${binInstanceXml(full, unit, inner, eol)}${eol}${outer}` +
    xml.slice(close.index)
  );
}

/**
 * Remove every instance for which predicate is true, together with its indentation and
 * the line break before it. An instances element left holding only whitespace collapses
 * to `<instances></instances>` (the shape of a fresh bin).
 */
export function removeBinInstances(xml: string, predicate: (i: BinInstance) => boolean): string {
  let changed = false;
  const re = new RegExp(String.raw`(?:\r?\n)?[ \t]*(` + INSTANCE_SRC + ")", "g");
  const out = xml.replace(re, (whole: string, inst: string) => {
    if (!predicate(instanceFromXml(inst))) return whole;
    changed = true;
    return "";
  });
  if (!changed) return xml;
  return out.replace(/<instances>\s*<\/instances>/, "<instances></instances>");
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Order backup names by timestamp, then by numeric clash suffix. */
function compareBackupNames(a: string, b: string): number {
  const key = (s: string) => {
    const m = /\.bak-(\d{8}-\d{6})(?:-(\d+))?$/.exec(s);
    return [m?.[1] ?? "", Number(m?.[2] ?? 0)] as const;
  };
  const [ta, na] = key(a);
  const [tb, nb] = key(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return na - nb;
}

/**
 * Copy the bin to `<bin>.bak-YYYYMMDD-HHMMSS` (local time; `-N` suffix on a clash) and
 * delete all but the MAX_BIN_BACKUPS newest backups. Returns undefined when there is no
 * bin to back up yet.
 */
export async function backupBin(
  binPath: string,
  now: () => Date = () => new Date(),
): Promise<string | undefined> {
  if (!existsSync(binPath)) return undefined;
  const base = `${binPath}.bak-${stamp(now())}`;
  let target = base;
  for (let n = 1; existsSync(target); n++) target = `${base}-${n}`;
  await copyFile(binPath, target);

  const dir = dirname(binPath);
  const re = new RegExp(`^${escapeRe(basename(binPath))}\\.bak-\\d{8}-\\d{6}(-\\d+)?$`);
  const backups = (await readdir(dir))
    .filter((f) => re.test(f))
    .sort((a, b) => compareBackupNames(b, a));
  for (const old of backups.slice(MAX_BIN_BACKUPS)) await rm(join(dir, old), { force: true });
  return target;
}

/** Write a file atomically: write `<path>.tmp-<pid>` next to it, then rename over it. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Write new bin xml, backing the old file up first unless `backup` is false. Returns the
 * backup path (undefined when no backup was taken or there was no old file).
 */
export async function writeBin(
  binPath: string,
  xml: string,
  opts: { backup?: boolean; now?: () => Date } = {},
): Promise<string | undefined> {
  const bak = opts.backup === false ? undefined : await backupBin(binPath, opts.now);
  await writeFileAtomic(binPath, xml);
  return bak;
}
