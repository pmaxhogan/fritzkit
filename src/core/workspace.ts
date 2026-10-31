/**
 * Workspace = a folder of part folders (decision D11):
 *
 *   <workspace>/<slug>/part.json      the spec as written by the user or agent
 *   <workspace>/<slug>/assets/...     photos and other files the spec references
 *   <workspace>/<slug>/build/...      render output (never read back)
 *   <workspace>/<slug>/<moduleId>.fzpz export output (never read back)
 *
 * Only part.json and assets/ feed the compiler, so build output never changes a moduleId.
 * This is the one core module (besides export/ and image/) that touches the filesystem.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { compilePart } from "./compile/index.js";
import type { CompiledPart } from "./compile/types.js";
import { writeFileAtomic } from "./export/bin.js";
import { allocatePinIds } from "./resolve.js";
import { parsePartSpec, SLUG_RE, type PartSpec, type PartSpecInput } from "./schema/part.js";
import type { PrepareOptions } from "./image/prepare.js";

export const PART_FILE = "part.json";
export const ASSETS_DIR = "assets";
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/pmaxhogan/fritzkit/main/src/core/schema/part.schema.json";

/** env.FRITZKIT_WORKSPACE, else ~/fritzkit/parts. */
export function defaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRITZKIT_WORKSPACE) return resolve(env.FRITZKIT_WORKSPACE);
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return join(home, "fritzkit", "parts");
}

/** The --workspace flag wins over the environment and the default. Always absolute. */
export function resolveWorkspace(cliFlag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(cliFlag ?? defaultWorkspace(env));
}

/** Folder of one part. Throws on a slug that is not a safe single path segment. */
export function partDir(workspace: string, slug: string): string {
  if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 60) {
    throw new Error(
      `invalid slug "${slug}": use 3-60 lowercase letters, digits and "-" (e.g. sensor-breakout)`,
    );
  }
  return join(resolve(workspace), slug);
}

export class PartJsonError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "PartJsonError";
  }
}

/** Read and JSON-parse <dir>/part.json without schema validation. */
export async function readPartJson(dir: string): Promise<PartSpecInput> {
  const file = join(dir, PART_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PartJsonError(`no ${PART_FILE} in ${dir}`, file);
    }
    throw e;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as PartSpecInput;
  } catch (e) {
    throw new PartJsonError(
      `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      file,
    );
  }
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const here = join(root, rel);
  for (const d of await readdir(here, { withFileTypes: true })) {
    // Dotfiles (.gitkeep, .DS_Store) are never assets: they would only perturb the hash.
    if (d.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) await walk(root, childRel, out);
    else if (d.isFile()) out.push(childRel);
  }
}

/** Every non-dot file under <dir>/assets, keyed "assets/<path>" (forward slashes), sorted. */
export async function readAssets(dir: string): Promise<Map<string, Uint8Array>> {
  const root = join(dir, ASSETS_DIR);
  const assets = new Map<string, Uint8Array>();
  if (!existsSync(root) || !(await stat(root)).isDirectory()) return assets;
  const files: string[] = [];
  await walk(root, "", files);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of files) {
    assets.set(`${ASSETS_DIR}/${f}`, new Uint8Array(await readFile(join(root, f))));
  }
  return assets;
}

export interface LoadedPart {
  dir: string;
  /** Parsed with defaults applied. */
  spec: PartSpec;
  /** As written on disk. */
  raw: PartSpecInput;
  assets: Map<string, Uint8Array>;
}

/** Read a part folder. Throws PartJsonError (missing/bad JSON) or ZodError (bad spec). */
export async function readPart(dir: string): Promise<LoadedPart> {
  const abs = resolve(dir);
  const raw = await readPartJson(abs);
  const spec = parsePartSpec(raw);
  return { dir: abs, spec, raw, assets: await readAssets(abs) };
}

/** The exact bytes writePart writes: 2-space JSON, LF, trailing newline, key order kept. */
export function serializePart(raw: PartSpecInput): string {
  return JSON.stringify(raw, null, 2) + "\n";
}

/** Write <dir>/part.json atomically (creates dir). */
export async function writePart(dir: string, raw: PartSpecInput): Promise<string> {
  const file = join(resolve(dir), PART_FILE);
  await writeFileAtomic(file, serializePart(raw));
  return file;
}

/**
 * Merge connector numbers into part.json on disk (D12a). Existing entries are never
 * changed, other keys keep their order, a missing pinIds key is appended at the end.
 * Returns the keys that were added (empty = nothing written).
 */
export async function persistPinIds(
  dir: string,
  pinIds: Record<string, number>,
): Promise<string[]> {
  const raw = await readPartJson(dir);
  const existing: Record<string, number> = { ...(raw.pinIds ?? {}) };
  const added: string[] = [];
  for (const [k, v] of Object.entries(pinIds)) {
    if (existing[k] === undefined) {
      existing[k] = v;
      added.push(k);
    }
  }
  if (added.length === 0) return added;
  await writePart(dir, { ...raw, pinIds: existing });
  return added;
}

/** A minimal valid spec: a generic sensor breakout with one example pin. */
export function newPartTemplate(slug: string, title: string): PartSpecInput {
  return {
    $schema: SCHEMA_URL,
    slug,
    title,
    version: 1,
    description: "Generic sensor breakout. Replace this with what the part is.",
    tags: ["sensor", "breakout"],
    outline: { widthMm: 20, heightMm: 15 },
    pins: [
      {
        key: "VCC",
        name: "VCC",
        description: "Supply voltage",
        role: "power",
        type: "female",
        xMm: 3.81,
        yMm: 7.62,
      },
    ],
  };
}

export interface PartListing {
  slug: string;
  dir: string;
  title: string;
}

/** Folders in the workspace that hold a part.json, sorted by slug. Unreadable titles fall back to the slug. */
export async function listParts(workspace: string): Promise<PartListing[]> {
  const root = resolve(workspace);
  if (!existsSync(root)) return [];
  const out: PartListing[] = [];
  const dirents = await readdir(root, { withFileTypes: true });
  for (const d of dirents.filter((x) => x.isDirectory())) {
    const dir = join(root, d.name);
    if (!existsSync(join(dir, PART_FILE))) continue;
    let title = d.name;
    try {
      const raw = await readPartJson(dir);
      if (typeof raw.title === "string" && raw.title) title = raw.title;
    } catch {
      // keep the folder name
    }
    out.push({ slug: d.name, dir, title });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Create the workspace folder (no-op when it exists); returns its absolute path. */
export async function initWorkspace(workspace: string): Promise<string> {
  const abs = resolve(workspace);
  await mkdir(abs, { recursive: true });
  return abs;
}

export interface CompileFromDirOptions {
  date?: string;
  generator?: string;
  /** Options for the photo preparer (background removal method, max width). */
  photo?: PrepareOptions;
  /** Write newly allocated pinIds back to part.json (default true). */
  persist?: boolean;
}

export interface CompileFromDirResult extends CompiledPart {
  /** Pin keys whose connector numbers were newly written to part.json. */
  persistedPinKeys: string[];
}

/**
 * readPart + compilePart. New pin keys get their connector numbers allocated and written
 * to part.json BEFORE compiling, so the moduleId hash covers the durable pinIds and an
 * unchanged part re-exports with the same moduleId.
 */
export async function compileFromDir(
  dir: string,
  opts: CompileFromDirOptions = {},
): Promise<CompileFromDirResult> {
  const loaded = await readPart(dir);
  let spec = loaded.spec;
  let persistedPinKeys: string[] = [];
  const { pinIds, added } = allocatePinIds(spec);
  if (added.length > 0) {
    if (opts.persist !== false) persistedPinKeys = await persistPinIds(loaded.dir, pinIds);
    spec = { ...spec, pinIds };
  }
  const { preparePhoto } = await import("./image/prepare.js");
  const compiled = await compilePart(spec, {
    assets: loaded.assets,
    ...(opts.date !== undefined ? { date: opts.date } : {}),
    ...(opts.generator !== undefined ? { generator: opts.generator } : {}),
    preparePhoto: (data, s) => preparePhoto(data, s, opts.photo),
  });
  if (compiled.resolved.newPinKeys.length > 0 && opts.persist !== false) {
    persistedPinKeys.push(...(await persistPinIds(loaded.dir, compiled.resolved.pinIds)));
  }
  return { ...compiled, persistedPinKeys };
}
