/**
 * The fritzkit ui server (spec D15/D16): a loopback-only node:http server that serves the
 * built app from dist/ui and the JSON API under /api (see api.ts and docs/ui.md).
 *
 * createServer({ workspace, ctx }) takes the same injectable CommandContext as the CLI,
 * so tests fix the date, fake `isRunning` and point the Fritzing folders at a temp dir.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceOf, type CommandContext } from "../cli/context.js";
import { apiHandler, mimeOf } from "./api.js";
import { EventHub } from "./events.js";
import { HttpError, isLoopbackRequest, sendBody, sendJson } from "./http.js";

export { HttpError } from "./http.js";
export { EventHub, classifyChange, sseFrame, textHash } from "./events.js";
export {
  apiHandler,
  assetMimeOf,
  assetPath,
  isSafeAssetName,
  listAssets,
  mimeOf,
  partPayload,
  preparePut,
  withExplain,
} from "./api.js";

export const DEFAULT_PORT = 5173;
export const HOST = "127.0.0.1";
/** How many ports after the default to try before giving up. */
export const PORT_SCAN = 50;

export interface ServerOptions {
  ctx: CommandContext;
  /** Workspace folder (default: workspaceOf(ctx)). */
  workspace?: string;
  /** Built app folder holding index.html (default: dist/ui next to this package). */
  uiDir?: string;
  /** SSE keep-alive interval (ms). */
  pingMs?: number;
  /** fs.watch debounce (ms). */
  debounceMs?: number;
}

export interface UiServer {
  workspace: string;
  uiDir: string;
  /** Handle one request (the Vite dev server mounts this for /api). */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** The node:http server (not listening until listen()). */
  server: Server;
  /** Listen on HOST:port; port 0 picks a free port. Resolves to the bound port. */
  listen: (port: number) => Promise<number>;
  /** Stop listening, end SSE streams, close watchers. */
  close: () => Promise<void>;
}

/** dist/ui of this package: "../../dist/ui" works from both src/server and dist/server. */
export function defaultUiDir(): string {
  return fileURLToPath(new URL("../../dist/ui", import.meta.url));
}

/** True when `dir` holds a built app. */
export function hasBuiltUi(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}

async function serveStatic(uiDir: string, pathname: string, res: ServerResponse): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "bad percent-encoding in the path");
  }
  if (rel.includes("\0")) throw new HttpError(400, "bad path");
  const root = resolve(uiDir);
  let abs = resolve(root, `.${rel}`);
  if (abs !== root && !abs.startsWith(root + sep)) throw new HttpError(403, "outside the app");
  let isFile: boolean;
  try {
    isFile = (await stat(abs)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Client-side routes fall back to the app; missing files with an extension are 404.
    if (/\.[A-Za-z0-9]+$/.test(rel)) throw new HttpError(404, `no such file ${rel}`);
    abs = join(root, "index.html");
  }
  let data: Buffer;
  try {
    data = await readFile(abs);
  } catch {
    throw new HttpError(404, `the app is not built in ${root}: run npm run ui:build`);
  }
  const immutable = abs.includes(`${sep}assets${sep}`);
  sendBody(
    res,
    200,
    mimeOf(abs),
    data,
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

/** Build the server (not yet listening). */
export async function createServer(opts: ServerOptions): Promise<UiServer> {
  const workspace = resolve(opts.workspace ?? workspaceOf(opts.ctx));
  const uiDir = resolve(opts.uiDir ?? defaultUiDir());
  const hub = new EventHub(opts.debounceMs ?? 200);
  const api = apiHandler({ workspace, ctx: opts.ctx, hub });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackRequest(req.headers, req.socket.localPort)) {
        throw new HttpError(403, "fritzkit ui only answers loopback requests from its own pages");
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await api(req, res);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, `${req.method} is not allowed on ${url.pathname}`);
      }
      await serveStatic(uiDir, url.pathname, res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const server = createHttpServer((req, res) => void handle(req, res));
  const ping = setInterval(() => hub.ping(), opts.pingMs ?? 25000);
  ping.unref();

  const listen = (port: number): Promise<number> =>
    new Promise((ok, fail) => {
      const onError = (e: Error) => {
        server.off("listening", onListening);
        fail(e);
      };
      const onListening = () => {
        server.off("error", onError);
        ok((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });

  const close = async (): Promise<void> => {
    clearInterval(ping);
    hub.close();
    if (!server.listening) return;
    await new Promise<void>((ok) => {
      server.close(() => ok());
      server.closeAllConnections();
    });
  };

  return { workspace, uiDir, handle, server, listen, close };
}

/**
 * Listen on `start`, or (unless strict) the next free port up to PORT_SCAN above it.
 * Throws the last error (EADDRINUSE) when none is free.
 */
export async function listenFrom(ui: UiServer, start: number, strict: boolean): Promise<number> {
  const last = strict || start === 0 ? start : Math.min(65535, start + PORT_SCAN);
  let err: unknown;
  for (let p = start; p <= last; p++) {
    try {
      return await ui.listen(p);
    } catch (e) {
      err = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw err;
}

/** The command that opens `url` in the default browser (no shell involved). */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Fire and forget: open the browser; failures are ignored (the URL is printed anyway). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { cmd, args } = openCommand(url, platform);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser launcher: the caller prints the URL
  }
}

/** App URL for the server, optionally deep-linked to a part. */
export function appUrl(port: number, slug?: string): string {
  return `http://${HOST}:${port}/${slug ? `#/${encodeURIComponent(slug)}` : ""}`;
}

const running = new Set<UiServer>();

export interface StartOptions extends ServerOptions {
  /** Port to try first (default 5173). */
  port?: number;
  /** Fail instead of trying the next port when `port` is taken. */
  strictPort?: boolean;
}

/** createServer + listen; the server is tracked so stopAll() can close it (tests). */
export async function startUi(opts: StartOptions): Promise<UiServer & { port: number }> {
  const ui = await createServer(opts);
  try {
    const port = await listenFrom(ui, opts.port ?? DEFAULT_PORT, opts.strictPort ?? false);
    running.add(ui);
    return { ...ui, port };
  } catch (e) {
    await ui.close();
    throw e;
  }
}

/** Close every server startUi started. */
export async function stopAll(): Promise<void> {
  const all = [...running];
  running.clear();
  await Promise.all(all.map((s) => s.close()));
}
