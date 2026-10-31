/**
 * The /api routes of the fritzkit ui server. Every handler reuses the CLI command code
 * (validate, export, install, doctor) or core directly, so the UI, the CLI and the MCP
 * server behave the same. Handlers never throw to the client: every failure becomes a
 * JSON `{ error, ... }` with a status code.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { VIEWS, type View } from "../core/compile/types.js";
import { writeFileAtomic } from "../core/export/bin.js";
import { pxPerMm } from "../core/image/bbox.js";
import { detectBoardBbox } from "../core/image/key.js";
import { allocatePinIds, resolvePart, ResolveError } from "../core/resolve.js";
import { parsePartSpec, type PartSpecInput } from "../core/schema/part.js";
import { explain, validateSpecJson, type Issue } from "../core/validate/index.js";
import {
  ASSETS_DIR,
  compileFromDir,
  listParts,
  PART_FILE,
  PartJsonError,
  partDir,
  writePart,
} from "../core/workspace.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { exportCommand, installCommand } from "../cli/commands/export.js";
import { validateCommand } from "../cli/commands/validate.js";
import {
  CliError,
  dateOf,
  describeError,
  EXIT_FRITZING_RUNNING,
  fritzingRunningMessage,
  isRunningOf,
  isZodError,
  type CommandContext,
} from "../cli/context.js";
import { EventHub, textHash } from "./events.js";
import { HttpError, readBody, readJson, sendBody, sendJson, UNTRUSTED_HEADERS } from "./http.js";

export const JSON_LIMIT = 5 * 1024 * 1024;
export const ASSET_LIMIT = 25 * 1024 * 1024;

const ASSET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;
/** Uploads are raster images only (the photo artwork style and calibration read them). */
const ASSET_EXT_RE = /\.(png|jpe?g|webp|gif|avif|tiff?)$/i;

/** Raster types an asset may be served as; anything else is a download. */
const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Content type for serving an asset: a raster image type, or undefined (send as attachment). */
export function assetMimeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? ASSET_MIME[name.slice(dot).toLowerCase()] : undefined;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Content type by file extension (application/octet-stream when unknown). */
export function mimeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && MIME[name.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/**
 * An upload name is one safe path segment (no separators, no "..", no leading dot) with a
 * raster image extension (png, jpg/jpeg, webp, gif, avif, tif/tiff).
 */
export function isSafeAssetName(name: string): boolean {
  return ASSET_NAME_RE.test(name) && !name.includes("..") && ASSET_EXT_RE.test(name);
}

/** "assets/a/b.png" or "a/b.png" -> absolute path inside <dir>/assets, or undefined if unsafe. */
export function assetPath(dir: string, name: string): string | undefined {
  let rel = name.replace(/\\/g, "/");
  if (rel.startsWith(`${ASSETS_DIR}/`)) rel = rel.slice(ASSETS_DIR.length + 1);
  const segs = rel.split("/");
  if (rel === "" || segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
    return undefined;
  }
  if (/^[A-Za-z]:/.test(rel)) return undefined;
  const root = resolve(dir, ASSETS_DIR);
  const abs = resolve(root, ...segs);
  return abs.startsWith(root + sep) ? abs : undefined;
}

export interface AssetInfo {
  /** Spec-relative path, e.g. "assets/top.png". */
  name: string;
  size: number;
}

/** Files under <dir>/assets (dotfiles skipped), sorted, with sizes. */
export async function listAssets(dir: string): Promise<AssetInfo[]> {
  const root = join(dir, ASSETS_DIR);
  if (!existsSync(root)) return [];
  const out: AssetInfo[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(r);
      else if (d.isFile() && !/\.tmp-\d+$/.test(d.name)) {
        out.push({ name: `${ASSETS_DIR}/${r}`, size: (await stat(join(root, r))).size });
      }
    }
  };
  await walk("");
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Issues with the human explanation attached (the validator panel shows it as is). */
export function withExplain(issues: readonly Issue[]): (Issue & { explain: string })[] {
  return issues.map((i) => ({ ...i, explain: explain(i) }));
}

function specIssues(e: unknown): Issue[] {
  if (isZodError(e)) {
    return e.issues.map((zi) => {
      const path = zi.path.map(String).join(".");
      return {
        level: "error",
        code: "spec-schema",
        message: path ? `${path}: ${zi.message}` : zi.message,
        ...(path ? { where: path } : {}),
      };
    });
  }
  if (e instanceof ResolveError) {
    return [{ level: "error", code: "spec-resolve", message: e.message, where: e.path }];
  }
  return [{ level: "error", code: "compile", message: describeError(e).message }];
}

/** What GET /api/parts/:slug returns. `valid: false` still carries the text for the Raw tab. */
export interface PartPayload {
  slug: string;
  dir: string;
  /** part.json exactly as on disk. */
  text: string;
  hash: string;
  /** Parsed JSON (null when the file is not JSON). */
  raw: unknown;
  valid: boolean;
  issues: (Issue & { explain: string })[];
  /** With defaults applied (null when invalid). */
  spec: unknown;
  connectors: unknown[];
  buses: unknown[];
  frame: unknown;
  /** pinIds after allocation (new keys included). */
  pinIds: Record<string, number>;
  assets: AssetInfo[];
}

/** Read a part folder into the payload the app works from. Never throws for a bad spec. */
export async function partPayload(slug: string, dir: string): Promise<PartPayload> {
  const text = await readFile(join(dir, PART_FILE), "utf8");
  const base = {
    slug,
    dir,
    text,
    hash: textHash(text),
    assets: await listAssets(dir),
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    const message = `${PART_FILE} is not valid JSON: ${e instanceof Error ? e.message : e}`;
    return {
      ...base,
      raw: null,
      valid: false,
      issues: withExplain([{ level: "error", code: "spec-json", message }]),
      spec: null,
      connectors: [],
      buses: [],
      frame: null,
      pinIds: {},
    };
  }
  try {
    const spec = parsePartSpec(raw);
    const resolved = resolvePart(spec);
    return {
      ...base,
      raw,
      valid: true,
      issues: [],
      spec,
      connectors: resolved.connectors,
      buses: resolved.buses,
      frame: resolved.frame,
      pinIds: resolved.pinIds,
    };
  } catch (e) {
    return {
      ...base,
      raw,
      valid: false,
      issues: withExplain(specIssues(e)),
      spec: null,
      connectors: [],
      buses: [],
      frame: null,
      pinIds: {},
    };
  }
}

/**
 * Validate a part.json body for PUT. Returns the raw object to write (with connector
 * numbers for new keys merged into pinIds, D12a) or the issues.
 */
export function preparePut(
  slug: string,
  body: unknown,
): { raw: PartSpecInput; issues: [] } | { raw?: undefined; issues: Issue[] } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      issues: [{ level: "error", code: "spec-json", message: "part.json must be a JSON object" }],
    };
  }
  const obj = body as Record<string, unknown>;
  if (obj.slug !== slug) {
    return {
      issues: [
        {
          level: "error",
          code: "spec-slug",
          message: `slug must stay "${slug}" (got ${JSON.stringify(obj.slug)}); rename the folder with the CLI instead`,
          where: "slug",
        },
      ],
    };
  }
  const schema = validateSpecJson(obj);
  if (schema.length > 0) return { issues: schema };
  try {
    const spec = parsePartSpec(obj);
    const { pinIds, added } = allocatePinIds(spec);
    resolvePart({ ...spec, pinIds });
    const raw = obj as PartSpecInput;
    if (added.length === 0) return { raw, issues: [] };
    const merged: Record<string, number> = { ...(raw.pinIds ?? {}) };
    for (const k of added) merged[k] = pinIds[k]!;
    return { raw: { ...raw, pinIds: merged }, issues: [] };
  } catch (e) {
    return { issues: specIssues(e) };
  }
}

export interface ApiOptions {
  workspace: string;
  ctx: CommandContext;
  hub: EventHub;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: { slug?: string; rest?: string; query: URLSearchParams },
) => Promise<void>;

/** Build the /api request handler. Resolves once the response is written. */
export function apiHandler(opts: ApiOptions) {
  const { workspace, hub } = opts;
  const ctx: CommandContext = { ...opts.ctx, workspace };

  const dirOf = (slug: string): string => {
    let dir: string;
    try {
      dir = partDir(workspace, slug);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    if (!existsSync(join(dir, PART_FILE))) {
      throw new HttpError(404, `unknown part "${slug}" in ${workspace}`);
    }
    return dir;
  };

  const routes: { method: string; re: RegExp; fn: Handler }[] = [];
  const route = (method: string, re: RegExp, fn: Handler) => routes.push({ method, re, fn });

  route("GET", /^\/api\/parts$/, async (_req, res) => {
    const parts = await listParts(workspace);
    sendJson(res, 200, { workspace, parts });
  });

  route("GET", /^\/api\/doctor$/, async (_req, res) => {
    const r = await doctorCommand(ctx);
    let fritzingRunning: boolean;
    try {
      fritzingRunning = await isRunningOf(ctx)();
    } catch {
      fritzingRunning = false;
    }
    sendJson(res, 200, { ...r.data, fritzingRunning, text: r.text });
  });

  route("GET", /^\/api\/parts\/([^/]+)$/, async (_req, res, { slug }) => {
    const dir = dirOf(slug!);
    sendJson(res, 200, await partPayload(slug!, dir));
  });

  route("PUT", /^\/api\/parts\/([^/]+)$/, async (req, res, { slug }) => {
    const dir = dirOf(slug!);
    const body = await readJson(req, JSON_LIMIT);
    const r = preparePut(slug!, body);
    if (r.raw === undefined) {
      sendJson(res, 422, { error: "part.json was not saved", issues: withExplain(r.issues) });
      return;
    }
    await writePart(dir, r.raw);
    const payload = await partPayload(slug!, dir);
    sendJson(res, 200, { ok: true, ...payload });
  });

  route("GET", /^\/api\/parts\/([^/]+)\/render\/([a-z]+)\.svg$/, async (_req, res, p) => {
    const dir = dirOf(p.slug!);
    const view = p.rest as View;
    if (!(VIEWS as readonly string[]).includes(view)) {
      throw new HttpError(404, `unknown view "${view}"; use one of ${VIEWS.join(", ")}`);
    }
    let svg: string;
    try {
      const compiled = await compileFromDir(dir, { date: dateOf(ctx), persist: false });
      svg = compiled.svgs[view];
      res.setHeader("x-fritzkit-module-id", compiled.identity.moduleId);
      if (compiled.warnings.length > 0) {
        res.setHeader("x-fritzkit-warnings", encodeURIComponent(compiled.warnings.join("\n")));
      }
    } catch (e) {
      sendJson(res, 422, {
        error: `the part does not compile: ${describeError(e).message}`,
        issues: withExplain(specIssues(e)),
      });
      return;
    }
    sendBody(res, 200, "image/svg+xml; charset=utf-8", svg, "no-store", UNTRUSTED_HEADERS);
  });

  route("GET", /^\/api\/parts\/([^/]+)\/validate$/, async (_req, res, { slug, query }) => {
    dirOf(slug!);
    const checker = query.get("checker") === "1" || query.get("checker") === "true";
    const r = await validateCommand(slug!, { checker }, ctx);
    sendJson(res, 200, { ...r.data, issues: withExplain(r.data.issues), text: r.text });
  });

  route("POST", /^\/api\/parts\/([^/]+)\/export$/, async (req, res, { slug }) => {
    dirOf(slug!);
    const body = (await readJson(req, JSON_LIMIT)) as { force?: unknown };
    const r = await exportCommand(slug!, { force: body.force === true }, ctx);
    const issues = withExplain(r.data.issues);
    if (r.exitCode !== 0) {
      sendJson(res, 422, { error: "not exported: the validator reports errors", issues });
      return;
    }
    sendJson(res, 200, { path: r.data.fzpz, moduleId: r.data.moduleId, issues, text: r.text });
  });

  route("POST", /^\/api\/parts\/([^/]+)\/install$/, async (req, res, { slug }) => {
    dirOf(slug!);
    const body = (await readJson(req, JSON_LIMIT)) as { force?: unknown };
    // Refuse before exporting, so a 409 has no side effects.
    if (await isRunningOf(ctx)()) {
      sendJson(res, 409, { error: fritzingRunningMessage("install"), reason: "fritzing-running" });
      return;
    }
    let r: Awaited<ReturnType<typeof installCommand>>;
    try {
      r = await installCommand(slug!, { force: body.force === true }, ctx);
    } catch (e) {
      if (e instanceof CliError && e.exitCode === EXIT_FRITZING_RUNNING) {
        sendJson(res, 409, { error: e.message, reason: "fritzing-running" });
        return;
      }
      throw e;
    }
    const issues = withExplain(r.data.issues);
    if (r.exitCode !== 0) {
      sendJson(res, 422, { error: "not installed: the validator reports errors", issues });
      return;
    }
    sendJson(res, 200, {
      path: r.data.fzpz,
      moduleId: r.data.moduleId,
      installed: r.data.installed,
      issues,
      text: r.text,
    });
  });

  route("GET", /^\/api\/parts\/([^/]+)\/assets$/, async (_req, res, { slug }) => {
    sendJson(res, 200, { assets: await listAssets(dirOf(slug!)) });
  });

  route("GET", /^\/api\/parts\/([^/]+)\/assets\/(.+)$/, async (_req, res, p) => {
    const dir = dirOf(p.slug!);
    const abs = assetPath(dir, p.rest!);
    if (!abs) throw new HttpError(400, `unsafe asset path "${p.rest}"`);
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch {
      throw new HttpError(404, `no asset ${p.rest}`);
    }
    const type = assetMimeOf(abs);
    if (type) {
      sendBody(res, 200, type, data, "no-store", UNTRUSTED_HEADERS);
    } else {
      sendBody(res, 200, "application/octet-stream", data, "no-store", {
        ...UNTRUSTED_HEADERS,
        "content-disposition": "attachment",
      });
    }
  });

  route("POST", /^\/api\/parts\/([^/]+)\/assets$/, async (req, res, { slug, query }) => {
    const dir = dirOf(slug!);
    const name = query.get("name") ?? "";
    if (!isSafeAssetName(name)) {
      throw new HttpError(
        400,
        `bad asset name "${name}": use one image file name (.png, .jpg, .jpeg, .webp, .gif, .avif, .tif, .tiff) of letters, digits, "_", "-" and "." (no folders, no "..")`,
      );
    }
    const data = await readBody(req, ASSET_LIMIT);
    if (data.length === 0) throw new HttpError(400, "empty upload");
    const abs = assetPath(dir, name)!;
    await writeFileAtomic(abs, data);
    sendJson(res, 201, {
      name: `${ASSETS_DIR}/${name}`,
      size: data.length,
      assets: await listAssets(dir),
    });
  });

  route("POST", /^\/api\/parts\/([^/]+)\/calibrate$/, async (req, res, { slug }) => {
    const dir = dirOf(slug!);
    const body = (await readJson(req, JSON_LIMIT)) as { asset?: unknown; rotate?: unknown };
    if (typeof body.asset !== "string") throw new HttpError(400, 'body must be {"asset": "..."}');
    const abs = assetPath(dir, body.asset);
    if (!abs) throw new HttpError(400, `unsafe asset path "${body.asset}"`);
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch {
      throw new HttpError(404, `no asset ${body.asset}`);
    }
    const payload = await partPayload(slug!, dir);
    const spec = payload.spec as { outline: { widthMm: number; heightMm: number } } | null;
    if (!spec) {
      sendJson(res, 422, { error: "fix part.json first", issues: payload.issues });
      return;
    }
    const rotate = [0, 90, 180, 270].includes(Number(body.rotate)) ? Number(body.rotate) : 0;
    let box: Awaited<ReturnType<typeof detectBoardBbox>>;
    try {
      box = await detectBoardBbox(new Uint8Array(data));
    } catch (e) {
      throw new HttpError(422, `cannot decode ${body.asset}: ${describeError(e).message}`);
    }
    if (box.w <= 0 || box.h <= 0) {
      throw new HttpError(422, "no board found: the whole image looks like background");
    }
    const { widthMm, heightMm } = spec.outline;
    // The crop is in source pixels before rotation, so a quarter turn swaps the axes.
    const quarter = rotate === 90 || rotate === 270;
    const outline = quarter ? { widthMm: heightMm, heightMm: widthMm } : { widthMm, heightMm };
    const ppm = pxPerMm(box, outline);
    const name = `${ASSETS_DIR}/${abs.slice(resolve(dir, ASSETS_DIR).length + 1).replace(/\\/g, "/")}`;
    sendJson(res, 200, {
      asset: name,
      rotate,
      bbox: { x: box.x, y: box.y, w: box.w, h: box.h },
      widthPx: box.widthPx,
      heightPx: box.heightPx,
      crop: [box.x, box.y, box.w, box.h],
      pxPerMm: ppm,
    });
  });

  route("GET", /^\/api\/parts\/([^/]+)\/events$/, async (_req, res, { slug }) => {
    hub.subscribe(slug!, dirOf(slug!), res);
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const method = req.method ?? "GET";
      let allowed: string[] = [];
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        if (r.method !== method && !(r.method === "GET" && method === "HEAD")) {
          allowed.push(r.method);
          continue;
        }
        allowed = [];
        let slug: string | undefined;
        let rest: string | undefined;
        try {
          slug = m[1] === undefined ? undefined : decodeURIComponent(m[1]);
          rest = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
        } catch {
          throw new HttpError(400, "bad percent-encoding in the path");
        }
        await r.fn(req, res, { slug, rest, query: url.searchParams });
        return;
      }
      if (allowed.length > 0) {
        res.setHeader("allow", [...new Set(allowed)].join(", "));
        throw new HttpError(405, `${method} is not allowed on ${path}`);
      }
      throw new HttpError(404, `no such API route: ${method} ${path}`);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...e.extra });
        return;
      }
      if (isZodError(e) || e instanceof ResolveError || e instanceof PartJsonError) {
        sendJson(res, 422, { error: describeError(e).message, issues: withExplain(specIssues(e)) });
        return;
      }
      const { exitCode, message } = describeError(e);
      const status = exitCode === EXIT_FRITZING_RUNNING ? 409 : e instanceof CliError ? 400 : 500;
      sendJson(res, status, { error: message });
    }
  };
}
