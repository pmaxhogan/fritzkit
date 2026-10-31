/**
 * Small HTTP helpers for the fritzkit ui server (plain node:http, no framework): JSON
 * responses, bounded body reading, an error type that carries a status code, and the
 * loopback-only Host/Origin guard.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** An error the API turns into `{ error, ...extra }` with this HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Write a JSON response (2-space, trailing newline, no caching). */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Write a text/binary response. */
export function sendBody(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
  cache = "no-store",
  extra: Record<string, string> = {},
): void {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  res.writeHead(status, {
    ...extra,
    "content-type": contentType,
    "cache-control": cache,
    "content-length": buf.length,
  });
  res.end(buf);
}

/** Read the whole request body; 413 past `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, `request body is larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new HttpError(413, `request body is larger than ${limit} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Read and parse a JSON body; 400 on bad JSON. An empty body parses as `{}`. */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const buf = await readBody(req, limit);
  const text = buf.toString("utf8").replace(/^\uFEFF/u, "");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new HttpError(400, `body is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Headers for content derived from user files or user-controlled spec strings (assets,
 * compiled SVG previews): no MIME sniffing, and a sandboxed CSP so an SVG or HTML opened
 * directly cannot run script on the app's origin.
 */
export const UNTRUSTED_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Hostname of a Host header or Origin URL ("127.0.0.1:5173" -> "127.0.0.1"). */
export function hostnameOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.includes("://")) {
    try {
      return new URL(v).hostname;
    } catch {
      return v;
    }
  }
  if (v.startsWith("[")) return v.slice(0, v.indexOf("]") + 1);
  const colon = v.lastIndexOf(":");
  return colon >= 0 ? v.slice(0, colon) : v;
}

/**
 * Loopback guard against DNS rebinding and cross-site requests: the Host header must
 * name a loopback host and, when the browser sends an Origin, so must the Origin.
 */
export function isLoopbackRequest(headers: IncomingMessage["headers"]): boolean {
  const host = headers.host;
  if (host === undefined || !LOOPBACK.has(hostnameOf(host))) return false;
  const origin = headers.origin;
  if (origin !== undefined && !LOOPBACK.has(hostnameOf(origin))) {
    return false;
  }
  return true;
}
