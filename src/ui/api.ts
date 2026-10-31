/** Typed fetch wrappers for the fritzkit ui server (/api, same origin). */
import type { Frame, ResolvedBus, ResolvedConnector } from "../core/resolve.js";
import type { PartSpec, PartSpecInput } from "../core/schema/part.js";

export interface Issue {
  level: "error" | "warning";
  code: string;
  message: string;
  where?: string;
  fix?: string;
  explain?: string;
}

export interface AssetInfo {
  name: string;
  size: number;
}

export interface PartPayload {
  slug: string;
  dir: string;
  text: string;
  hash: string;
  raw: PartSpecInput | null;
  valid: boolean;
  issues: Issue[];
  spec: PartSpec | null;
  connectors: ResolvedConnector[];
  buses: ResolvedBus[];
  frame: Frame | null;
  pinIds: Record<string, number>;
  assets: AssetInfo[];
}

export interface PartListing {
  slug: string;
  dir: string;
  title: string;
}

export interface DoctorPayload {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string; optional?: boolean }[];
  fritzingRunning: boolean;
}

export interface ValidatePayload {
  ok: boolean;
  moduleId?: string;
  issues: Issue[];
  checker?: { available: boolean; exitCode: number; errors: string[]; warnings: string[] };
}

export interface CalibratePayload {
  asset: string;
  rotate: number;
  bbox: { x: number; y: number; w: number; h: number };
  widthPx: number;
  heightPx: number;
  crop: [number, number, number, number];
  pxPerMm: { x: number; y: number };
}

/** A non-2xx answer: the server's `{ error, issues? }` body. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues: Issue[] = [],
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (type) headers["content-type"] = type;
  let res: Response;
  try {
    res = await fetch(path, { method, body, headers });
  } catch (e) {
    throw new ApiError(0, `the fritzkit ui server is not reachable (${String(e)})`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const b = (data ?? {}) as { error?: string; issues?: Issue[] };
    throw new ApiError(
      res.status,
      b.error ?? `${method} ${path}: HTTP ${res.status}`,
      b.issues ?? [],
      (data ?? {}) as Record<string, unknown>,
    );
  }
  return data as T;
}

const p = (slug: string) => `/api/parts/${encodeURIComponent(slug)}`;

export const api = {
  parts: () => req<{ workspace: string; parts: PartListing[] }>("GET", "/api/parts"),
  get: (slug: string) => req<PartPayload>("GET", p(slug)),
  put: (slug: string, raw: unknown) =>
    req<PartPayload & { ok: true }>("PUT", p(slug), JSON.stringify(raw), "application/json"),
  validate: (slug: string, checker = false) =>
    req<ValidatePayload>("GET", `${p(slug)}/validate${checker ? "?checker=1" : ""}`),
  exportPart: (slug: string, force = false) =>
    req<{ path: string; moduleId: string; issues: Issue[] }>(
      "POST",
      `${p(slug)}/export`,
      JSON.stringify({ force }),
      "application/json",
    ),
  install: (slug: string, force = false) =>
    req<{ path: string; moduleId: string; installed?: { installedDir: string } }>(
      "POST",
      `${p(slug)}/install`,
      JSON.stringify({ force }),
      "application/json",
    ),
  doctor: () => req<DoctorPayload>("GET", "/api/doctor"),
  upload: (slug: string, name: string, file: Blob) =>
    req<{ name: string; size: number; assets: AssetInfo[] }>(
      "POST",
      `${p(slug)}/assets?name=${encodeURIComponent(name)}`,
      file,
      "application/octet-stream",
    ),
  calibrate: (slug: string, asset: string, rotate: number) =>
    req<CalibratePayload>(
      "POST",
      `${p(slug)}/calibrate`,
      JSON.stringify({ asset, rotate }),
      "application/json",
    ),
  /** Fetch one compiled view; a compile error comes back as ApiError (422). */
  render: async (slug: string, view: string): Promise<string> => {
    const res = await fetch(`${p(slug)}/render/${view}.svg`);
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        // keep the status
      }
      throw new ApiError(res.status, msg);
    }
    return text;
  },
  assetUrl: (slug: string, name: string) =>
    `${p(slug)}/assets/${name
      .replace(/^assets\//, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  eventsUrl: (slug: string) => `${p(slug)}/events`,
};

/** "My Photo (1).JPG" -> "My_Photo_1_.JPG": a name the upload route accepts. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload";
  let s = base.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/\.{2,}/g, ".");
  s = s.replace(/^[^A-Za-z0-9_]+/, "");
  return (s || "upload").slice(0, 120);
}
