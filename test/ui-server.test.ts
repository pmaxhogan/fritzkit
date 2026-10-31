import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { request, createServer as createNetServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCommand } from "../src/cli/commands/parts.js";
import { parsePort, uiCommand } from "../src/cli/commands/ui.js";
import type { CheckerResult } from "../src/core/validate/index.js";
import { readPartJson } from "../src/core/workspace.js";
import {
  appUrl,
  assetMimeOf,
  assetPath,
  classifyChange,
  createServer,
  defaultUiDir,
  hasBuiltUi,
  isSafeAssetName,
  listenFrom,
  mimeOf,
  openCommand,
  preparePut,
  sseFrame,
  stopAll,
  textHash,
  type UiServer,
} from "../src/server/index.js";
import { hostnameOf, isLoopbackRequest } from "../src/server/http.js";
import { tempEnv, type TempEnv } from "./cli-helpers.js";

const SLUG = "sensor-breakout";

let t: TempEnv;
let ui: UiServer;
let port: number;
let uiDir: string;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
  json: () => Record<string, unknown>;
}

function call(
  method: string,
  path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          ok({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text,
            json: () => JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const json = (method: string, path: string, body: unknown) =>
  call(method, path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const checkerOk = async (): Promise<CheckerResult> => ({
  available: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  errors: [],
  warnings: ["a checker warning"],
});

beforeEach(async () => {
  t = tempEnv("fritzkit-ui-");
  t.ctx.runChecker = checkerOk;
  uiDir = join(t.root, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1);");
  await newCommand(SLUG, { title: "Sensor breakout" }, t.ctx);
  ui = await createServer({ ctx: t.ctx, uiDir, debounceMs: 50 });
  port = await ui.listen(0);
});

afterEach(async () => {
  await ui.close();
  await stopAll();
  t.cleanup();
});

/** A light background with a green board at (40,30) 120x60 px. */
async function boardPng(): Promise<Buffer> {
  const w = 200;
  const h = 120;
  const data = Buffer.alloc(w * h * 3, 250);
  for (let y = 30; y < 90; y++) {
    for (let x = 40; x < 160; x++) {
      const i = (y * w + x) * 3;
      data[i] = 20;
      data[i + 1] = 120;
      data[i + 2] = 50;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

describe("static app", () => {
  it("serves index.html, assets, the SPA fallback and 404s", async () => {
    const root = await call("GET", "/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.text).toContain("<title>app</title>");
    const js = await call("GET", "/assets/app.js");
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await call("GET", "/some/route")).text).toContain("<title>app</title>");
    expect((await call("GET", "/missing.js")).status).toBe(404);
    // URL parsing folds "%2e%2e" segments away, so this never leaves the app folder.
    expect((await call("GET", "/%2e%2e/%2e%2e/package.json")).status).toBe(404);
    expect((await call("GET", "/%E0%A4%A")).status).toBe(400);
    const back = await call("GET", "/..%5c..%5cpackage.json");
    expect([403, 404]).toContain(back.status);
    expect(back.text).not.toContain('"name": "fritzkit"');
    expect((await call("GET", "/a%00b")).status).toBe(400);
    expect((await call("POST", "/")).status).toBe(405);
  });

  it("refuses non-loopback Host and Origin headers", async () => {
    expect((await call("GET", "/api/parts", { headers: { host: "evil.example" } })).status).toBe(
      403,
    );
    const cross = await call("GET", "/api/parts", {
      headers: { origin: "http://evil.example" },
    });
    expect(cross.status).toBe(403);
    const same = await call("GET", "/api/parts", {
      headers: { origin: `http://localhost:${port}` },
    });
    expect(same.status).toBe(200);
    // Another program on another loopback port must not reach the write routes with a
    // "simple" (no preflight) text/plain POST.
    const otherPort = await call("POST", `/api/parts/${SLUG}/export`, {
      body: "{}",
      headers: { origin: `http://127.0.0.1:${port + 1}`, "content-type": "text/plain" },
    });
    expect(otherPort.status).toBe(403);
    expect(readdirSync(join(t.ws, SLUG)).filter((f) => f.endsWith(".fzpz"))).toEqual([]);
    const wrongHostPort = await call("GET", "/api/parts", {
      headers: { host: `127.0.0.1:${port + 1}` },
    });
    expect(wrongHostPort.status).toBe(403);
    const https = await call("GET", "/api/parts", {
      headers: { origin: `https://127.0.0.1:${port}` },
    });
    expect(https.status).toBe(403);
  });

  it("reports a missing build", async () => {
    const bare = await createServer({ ctx: t.ctx, uiDir: join(t.root, "nothing") });
    const p = await bare.listen(0);
    const saved = port;
    port = p;
    try {
      const r = await call("GET", "/");
      expect(r.status).toBe(404);
      expect(r.json().error).toContain("npm run ui:build");
    } finally {
      port = saved;
      await bare.close();
    }
  });
});

describe("parts API", () => {
  it("lists the workspace", async () => {
    const r = await call("GET", "/api/parts");
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({
      workspace: t.ws,
      parts: [{ slug: SLUG, title: "Sensor breakout" }],
    });
  });

  it("gets a part with resolved connectors, frame and assets", async () => {
    const r = await call("GET", `/api/parts/${SLUG}`);
    expect(r.status).toBe(200);
    const p = r.json();
    expect(p.valid).toBe(true);
    expect(p.connectors).toMatchObject([{ key: "VCC", id: 0, fzpId: "connector0" }]);
    expect(p.frame).toMatchObject({ widthMm: expect.any(Number) });
    expect(p.assets).toEqual([]);
    expect(p.hash).toBe(textHash(p.text as string));
    expect(p.pinIds).toEqual({ VCC: 0 });
  });

  it("returns an invalid part as text with issues instead of failing", async () => {
    const file = join(t.ws, SLUG, "part.json");
    writeFileSync(file, "{ not json");
    const bad = (await call("GET", `/api/parts/${SLUG}`)).json();
    expect(bad).toMatchObject({ valid: false, raw: null, text: "{ not json" });
    expect((bad.issues as { code: string }[])[0]!.code).toBe("spec-json");
    writeFileSync(file, JSON.stringify({ slug: SLUG, title: "x" }));
    const zod = (await call("GET", `/api/parts/${SLUG}`)).json();
    expect(zod.valid).toBe(false);
    expect(JSON.stringify(zod.issues)).toContain("outline");
    expect((zod.issues as { explain: string }[])[0]!.explain).toContain("Error [spec-schema]");
  });

  it("404s an unknown slug and 400s a bad one", async () => {
    expect((await call("GET", "/api/parts/no-such-part")).status).toBe(404);
    expect((await call("GET", "/api/parts/Bad..Slug")).status).toBe(400);
    expect((await call("GET", "/api/parts/%E0%A4%A")).status).toBe(400);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    const m = await call("DELETE", `/api/parts/${SLUG}`);
    expect(m.status).toBe(405);
    expect(m.headers.allow).toContain("PUT");
  });

  it("PUT validates, writes atomically and allocates connector numbers", async () => {
    const raw = await readPartJson(join(t.ws, SLUG));
    const next = {
      ...raw,
      pins: [
        ...(raw.pins ?? []),
        { key: "GND", name: "GND", role: "gnd", type: "female", xMm: 6.35, yMm: 7.62 },
      ],
    };
    const r = await json("PUT", `/api/parts/${SLUG}`, next);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, valid: true, pinIds: { VCC: 0, GND: 1 } });
    const disk = await readPartJson(join(t.ws, SLUG));
    expect(disk.pinIds).toEqual({ VCC: 0, GND: 1 });
    expect(readFileSync(join(t.ws, SLUG, "part.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  it("PUT rejects a bad spec with 422 and issues, and keeps the file", async () => {
    const before = readFileSync(join(t.ws, SLUG, "part.json"), "utf8");
    const bad = await json("PUT", `/api/parts/${SLUG}`, {
      slug: SLUG,
      title: "x",
      outline: { widthMm: -1, heightMm: 5 },
    });
    expect(bad.status).toBe(422);
    const issues = bad.json().issues as { code: string; where?: string; explain: string }[];
    expect(issues.some((i) => i.where === "outline.widthMm")).toBe(true);
    expect(issues[0]!.explain).toContain("spec-schema");
    const dup = await json("PUT", `/api/parts/${SLUG}`, {
      slug: SLUG,
      title: "x",
      outline: { widthMm: 10, heightMm: 5 },
      pins: [
        { key: "A", name: "A", xMm: 1, yMm: 1 },
        { key: "A", name: "B", xMm: 2, yMm: 1 },
      ],
    });
    expect(dup.status).toBe(422);
    expect(dup.text).toContain("duplicate pin key");
    const slug = await json("PUT", `/api/parts/${SLUG}`, { slug: "other-part" });
    expect(slug.status).toBe(422);
    expect(slug.text).toContain("slug must stay");
    expect((await json("PUT", `/api/parts/${SLUG}`, [1])).status).toBe(422);
    const notJson = await call("PUT", `/api/parts/${SLUG}`, { body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(readFileSync(join(t.ws, SLUG, "part.json"), "utf8")).toBe(before);
  });

  it("renders each view as SVG and 422s a part that does not compile", async () => {
    for (const v of ["breadboard", "schematic", "pcb", "icon"]) {
      const r = await call("GET", `/api/parts/${SLUG}/render/${v}.svg`);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("image/svg+xml");
      expect(r.text).toContain("<svg");
      expect(r.headers["x-fritzkit-module-id"]).toMatch(/^fritzkit-sensor-breakout-/);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toContain("sandbox");
      expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    }
    expect((await call("GET", `/api/parts/${SLUG}/render/side.svg`)).status).toBe(404);
    writeFileSync(join(t.ws, SLUG, "part.json"), JSON.stringify({ slug: SLUG }));
    const bad = await call("GET", `/api/parts/${SLUG}/render/pcb.svg`);
    expect(bad.status).toBe(422);
    expect(bad.json().error).toContain("does not compile");
  });

  it("render reports compile warnings in a header", async () => {
    const raw = await readPartJson(join(t.ws, SLUG));
    await json("PUT", `/api/parts/${SLUG}`, {
      ...raw,
      artwork: { style: "photo", photo: { src: "assets/missing.png" } },
    });
    const r = await call("GET", `/api/parts/${SLUG}/render/breadboard.svg`);
    expect(decodeURIComponent(String(r.headers["x-fritzkit-warnings"]))).toContain("missing.png");
  });

  it("validates (structural, and the checker with ?checker=1)", async () => {
    const r = (await call("GET", `/api/parts/${SLUG}/validate`)).json();
    expect(r).toMatchObject({ ok: true });
    expect(r.checker).toBeUndefined();
    const c = (await call("GET", `/api/parts/${SLUG}/validate?checker=1`)).json();
    expect(c.checker).toMatchObject({ available: true });
    const issues = c.issues as { message: string; explain: string }[];
    expect(issues[0]!.message).toBe("a checker warning");
    expect(issues[0]!.explain).toContain("Warning [fzp-checker]");
    writeFileSync(join(t.ws, SLUG, "part.json"), "{");
    const bad = await call("GET", `/api/parts/${SLUG}/validate`);
    expect(bad.status).toBe(422);
  });

  it("exports a .fzpz and returns its path and moduleId", async () => {
    const r = await json("POST", `/api/parts/${SLUG}/export`, {});
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body.moduleId).toMatch(/^fritzkit-sensor-breakout-[0-9a-f]{8}$/);
    expect(existsSync(body.path as string)).toBe(true);
    expect(body.path).toBe(join(t.ws, SLUG, `${body.moduleId}.fzpz`));
  });

  it("install refuses with 409 while Fritzing is running, installs otherwise", async () => {
    t.running.value = true;
    const busy = await json("POST", `/api/parts/${SLUG}/install`, {});
    expect(busy.status).toBe(409);
    expect(busy.json()).toMatchObject({ reason: "fritzing-running" });
    expect(String(busy.json().error)).toContain("Fritzing is running");
    // The refusal has no side effects: no .fzpz in the part folder, nothing installed.
    expect(readdirSync(join(t.ws, SLUG)).filter((f) => f.endsWith(".fzpz"))).toEqual([]);
    expect(readdirSync(t.userParts)).toEqual([]);
    t.running.value = false;
    const ok = await json("POST", `/api/parts/${SLUG}/install`, {});
    expect(ok.status).toBe(200);
    const body = ok.json() as { installed: { installedDir: string }; moduleId: string };
    expect(body.installed.installedDir.startsWith(t.userParts)).toBe(true);
  });

  it("doctor reports the checks and whether Fritzing is running", async () => {
    t.running.value = true;
    const r = await call("GET", "/api/doctor");
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ fritzingRunning: true, checks: expect.any(Array) });
  }, 30_000);
});

describe("assets", () => {
  it("uploads raw bodies, lists and serves them, and rejects unsafe names", async () => {
    const png = await boardPng();
    const up = await call("POST", `/api/parts/${SLUG}/assets?name=top.png`, { body: png });
    expect(up.status).toBe(201);
    expect(up.json()).toMatchObject({ name: "assets/top.png", size: png.length });
    expect(readFileSync(join(t.ws, SLUG, "assets", "top.png")).equals(png)).toBe(true);
    const list = (await call("GET", `/api/parts/${SLUG}/assets`)).json();
    expect(list.assets).toEqual([{ name: "assets/top.png", size: png.length }]);
    const got = await call("GET", `/api/parts/${SLUG}/assets/top.png`);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toContain("sandbox");
    expect(got.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(got.headers["content-disposition"]).toBeUndefined();
    expect(got.body.equals(png)).toBe(true);
    expect((await call("GET", `/api/parts/${SLUG}/assets/assets/top.png`)).status).toBe(200);
    expect((await call("GET", `/api/parts/${SLUG}/assets/nope.png`)).status).toBe(404);
    for (const name of [
      "../x.png",
      "a/b.png",
      "..",
      ".hidden.png",
      "a\\b.png",
      "",
      "evil.html",
      "evil.svg",
      "evil.js",
      "notes.txt",
      "noext",
    ]) {
      const r = await call("POST", `/api/parts/${SLUG}/assets?name=${encodeURIComponent(name)}`, {
        body: "x",
      });
      expect(r.status, name).toBe(400);
    }
    expect((await call("POST", `/api/parts/${SLUG}/assets?name=empty.png`)).status).toBe(400);
    expect((await call("GET", `/api/parts/${SLUG}/assets/..%2Fpart.json`)).status).toBe(400);
    const dots = await call("GET", `/api/parts/${SLUG}/assets/%2e%2e/part.json`);
    expect(dots.status).toBe(404);
    expect(dots.text).not.toContain("Sensor breakout");
    expect(existsSync(join(t.ws, SLUG, "x"))).toBe(false);
    expect(existsSync(join(t.ws, SLUG, "assets", "evil.html"))).toBe(false);
    expect(existsSync(join(t.ws, SLUG, "assets", "evil.svg"))).toBe(false);
  });

  it("serves non-raster files already in assets/ only as sandboxed downloads", async () => {
    mkdirSync(join(t.ws, SLUG, "assets"), { recursive: true });
    for (const name of ["page.html", "pic.svg"]) {
      writeFileSync(join(t.ws, SLUG, "assets", name), "<script>alert(1)</script>");
      const r = await call("GET", `/api/parts/${SLUG}/assets/${name}`);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toBe("application/octet-stream");
      expect(r.headers["content-disposition"]).toBe("attachment");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toContain("sandbox");
    }
  });

  it("calibrates: detects the board bbox and px/mm for the outline", async () => {
    await call("POST", `/api/parts/${SLUG}/assets?name=top.png`, { body: await boardPng() });
    const r = await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "assets/top.png" });
    expect(r.status).toBe(200);
    const body = r.json() as {
      bbox: { x: number; y: number; w: number; h: number };
      crop: number[];
      pxPerMm: { x: number; y: number };
      widthPx: number;
    };
    expect(body.bbox).toEqual({ x: 40, y: 30, w: 120, h: 60 });
    expect(body.crop).toEqual([40, 30, 120, 60]);
    expect(body.widthPx).toBe(200);
    // template outline is 20 x 15 mm
    expect(body.pxPerMm.x).toBeCloseTo(6);
    expect(body.pxPerMm.y).toBeCloseTo(4);
    const rot = (
      await json("POST", `/api/parts/${SLUG}/calibrate`, {
        asset: "top.png",
        rotate: 90,
      })
    ).json() as { pxPerMm: { x: number; y: number }; rotate: number };
    expect(rot.rotate).toBe(90);
    expect(rot.pxPerMm.x).toBeCloseTo(120 / 15);
    expect((await json("POST", `/api/parts/${SLUG}/calibrate`, {})).status).toBe(400);
    expect((await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "../x" })).status).toBe(
      400,
    );
    expect((await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "no.png" })).status).toBe(
      404,
    );
    await call("POST", `/api/parts/${SLUG}/assets?name=junk.png`, { body: "not an image" });
    expect((await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "junk.png" })).status).toBe(
      422,
    );
    const blank = await sharp({
      create: { width: 50, height: 50, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    await call("POST", `/api/parts/${SLUG}/assets?name=blank.png`, { body: blank });
    const none = await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "blank.png" });
    expect(none.status).toBe(422);
    expect(none.json().error).toContain("no board found");
    writeFileSync(join(t.ws, SLUG, "part.json"), JSON.stringify({ slug: SLUG }));
    expect((await json("POST", `/api/parts/${SLUG}/calibrate`, { asset: "top.png" })).status).toBe(
      422,
    );
  });
});

describe("events (SSE)", () => {
  it("emits changed when part.json or assets change on disk", async () => {
    const events: string[] = [];
    let resolveHello!: () => void;
    const hello = new Promise<void>((ok) => (resolveHello = ok));
    let waiters: (() => void)[] = [];
    const req = request({
      host: "127.0.0.1",
      port,
      path: `/api/parts/${SLUG}/events`,
      headers: { host: `127.0.0.1:${port}` },
    });
    req.on("response", (res) => {
      expect(res.headers["content-type"]).toContain("text/event-stream");
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const frame of chunk.split("\n\n").filter(Boolean)) {
          if (frame.startsWith("event: hello")) resolveHello();
          if (frame.startsWith("event: changed")) {
            events.push(frame);
            const w = waiters;
            waiters = [];
            for (const f of w) f();
          }
        }
      });
    });
    req.on("error", () => undefined);
    req.end();
    await hello;
    const next = (pred: (f: string) => boolean) =>
      new Promise<string>((ok) => {
        const check = () => {
          const f = events.find(pred);
          if (f) ok(f);
          else waiters.push(check);
        };
        check();
      });

    const file = join(t.ws, SLUG, "part.json");
    const text = readFileSync(file, "utf8").replace("Sensor breakout", "Sensor breakout 2");
    writeFileSync(file, text);
    const part = await next((f) => f.includes('"kind":"part"'));
    expect(part).toContain(textHash(text));

    mkdirSync(join(t.ws, SLUG, "assets"), { recursive: true });
    writeFileSync(join(t.ws, SLUG, "assets", "note.txt"), "hello");
    await next((f) => f.includes('"kind":"assets"'));
    req.destroy();
  }, 20_000);
});

describe("helpers", () => {
  it("classifies watcher filenames", () => {
    expect(classifyChange("part.json")).toBe("part");
    expect(classifyChange(null)).toBe("part");
    expect(classifyChange("assets\\top.png")).toBe("assets");
    expect(classifyChange("assets")).toBe("assets");
    expect(classifyChange("assets/top.png.tmp-123")).toBeUndefined();
    expect(classifyChange("build/pcb.svg")).toBeUndefined();
    expect(classifyChange("part.json.tmp-9")).toBeUndefined();
    expect(sseFrame("changed", { kind: "part" })).toBe('event: changed\ndata: {"kind":"part"}\n\n');
  });

  it("checks asset names and paths", () => {
    expect(isSafeAssetName("top.png")).toBe(true);
    expect(isSafeAssetName("my_photo-2.JPG")).toBe(true);
    for (const ok of ["a.jpeg", "a.webp", "a.gif", "a.avif", "a.tif", "a.TIFF"]) {
      expect(isSafeAssetName(ok), ok).toBe(true);
    }
    for (const n of [
      "../x.png",
      "a/b.png",
      "a\\b.png",
      ".x.png",
      "",
      "a..b.png",
      `${"x".repeat(200)}.png`,
      "x.html",
      "x.svg",
      "x.js",
      "x.png.html",
      "x",
      "con.png",
      "NUL.jpg",
      "com1.png",
      "lpt9.tif",
    ]) {
      expect(isSafeAssetName(n), n).toBe(false);
    }
    const dir = join(t.root, "p");
    expect(assetPath(dir, "assets/a/b.png")).toBe(join(dir, "assets", "a", "b.png"));
    expect(assetPath(dir, "b.png")).toBe(join(dir, "assets", "b.png"));
    for (const n of ["../x", "a/../../x", "", "C:/x", "a//b", "./a", "a/.git"]) {
      expect(assetPath(dir, n), n).toBeUndefined();
    }
    expect(mimeOf("a.PNG")).toBe("image/png");
    expect(assetMimeOf("a.JPG")).toBe("image/jpeg");
    expect(assetMimeOf("a.svg")).toBeUndefined();
    expect(assetMimeOf("a.html")).toBeUndefined();
    expect(assetMimeOf("noext")).toBeUndefined();
    expect(mimeOf("a.bin")).toBe("application/octet-stream");
    expect(mimeOf("noext")).toBe("application/octet-stream");
  });

  it("guards the Host and Origin headers", () => {
    expect(hostnameOf("127.0.0.1:5173")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:5173")).toBe("[::1]");
    expect(hostnameOf("http://localhost:5173")).toBe("localhost");
    expect(hostnameOf("localhost")).toBe("localhost");
    expect(hostnameOf("http://[bad")).toBe("http://[bad");
    expect(isLoopbackRequest({ host: "localhost:1" })).toBe(true);
    expect(isLoopbackRequest({})).toBe(false);
    expect(isLoopbackRequest({ host: "localhost:1", origin: "null" })).toBe(false);
    expect(isLoopbackRequest({ host: "a.b:1" })).toBe(false);
    expect(isLoopbackRequest({ host: "127.0.0.1:5173" }, 5173)).toBe(true);
    expect(isLoopbackRequest({ host: "127.0.0.1:5174" }, 5173)).toBe(false);
    expect(isLoopbackRequest({ host: "localhost" }, 5173)).toBe(false);
    const h = { host: "127.0.0.1:5173" };
    expect(isLoopbackRequest({ ...h, origin: "http://localhost:5173" }, 5173)).toBe(true);
    expect(isLoopbackRequest({ ...h, origin: "http://localhost:3000" }, 5173)).toBe(false);
    expect(isLoopbackRequest({ ...h, origin: "http://localhost" }, 5173)).toBe(false);
    expect(isLoopbackRequest({ ...h, origin: "https://127.0.0.1:5173" }, 5173)).toBe(false);
    expect(isLoopbackRequest({ ...h, origin: "http://127.0.0.1.evil.example:5173" }, 5173)).toBe(
      false,
    );
  });

  it("validates PUT bodies", () => {
    expect(preparePut(SLUG, null).issues[0]!.code).toBe("spec-json");
    const ok = preparePut(SLUG, {
      slug: SLUG,
      title: "x",
      outline: { widthMm: 10, heightMm: 5 },
      pinIds: { A: 3 },
      pins: [
        { key: "A", name: "A", xMm: 1, yMm: 1 },
        { key: "B", name: "B", xMm: 2, yMm: 1 },
      ],
    });
    expect(ok.raw?.pinIds).toEqual({ A: 3, B: 4 });
    const same = preparePut(SLUG, { slug: SLUG, title: "x", outline: { widthMm: 1, heightMm: 1 } });
    expect(same.raw).toBeDefined();
    const dupIds = preparePut(SLUG, {
      slug: SLUG,
      title: "x",
      outline: { widthMm: 1, heightMm: 1 },
      pinIds: { A: 1, B: 1 },
    });
    expect(dupIds.issues[0]!.code).toBe("spec-resolve");
  });

  it("builds open commands and URLs", () => {
    expect(openCommand("http://x/", "win32")).toEqual({
      cmd: "rundll32",
      args: ["url.dll,FileProtocolHandler", "http://x/"],
    });
    expect(openCommand("http://x/", "darwin").cmd).toBe("open");
    expect(openCommand("http://x/", "linux").cmd).toBe("xdg-open");
    expect(appUrl(5173)).toBe("http://127.0.0.1:5173/");
    expect(appUrl(5173, SLUG)).toBe(`http://127.0.0.1:5173/#/${SLUG}`);
    expect(defaultUiDir()).toMatch(/dist[\\/]ui$/);
    expect(hasBuiltUi(uiDir)).toBe(true);
    expect(hasBuiltUi(t.root)).toBe(false);
  });

  it("listenFrom scans to the next free port unless strict", async () => {
    const blocker = createNetServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", () => ok()));
    const taken = (blocker.address() as AddressInfo).port;
    const a = await createServer({ ctx: t.ctx, uiDir });
    const b = await createServer({ ctx: t.ctx, uiDir });
    try {
      await expect(listenFrom(a, taken, true)).rejects.toMatchObject({ code: "EADDRINUSE" });
      const got = await listenFrom(b, taken, false);
      expect(got).toBeGreaterThan(taken);
    } finally {
      await a.close();
      await b.close();
      await new Promise<void>((ok) => blocker.close(() => ok()));
    }
  });
});

describe("fritzkit ui command", () => {
  it("parses --port", () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort("0")).toBe(0);
    expect(parsePort("8080")).toBe(8080);
    for (const p of ["-1", "65536", "abc", "1.5", ""]) expect(() => parsePort(p), p).toThrow();
  });

  it("starts the server, prints the URL and opens the browser unless --no-open", async () => {
    const env = { ...t.ctx.env, FRITZKIT_UI_DIST: uiDir };
    const ctx = { ...t.ctx, env };
    const opened: string[] = [];
    const r = await uiCommand(SLUG, { port: "0", open: true }, ctx, (u) => opened.push(u));
    expect(r.exitCode).toBe(0);
    const data = r.data as { url: string; port: number; slug: string; workspace: string };
    expect(data.slug).toBe(SLUG);
    expect(data.workspace).toBe(t.ws);
    expect(opened).toEqual([data.url]);
    expect(data.url).toBe(`http://127.0.0.1:${data.port}/#/${SLUG}`);
    expect(r.text).toContain(data.url);
    expect(r.text).toContain("Ctrl+C");
    const saved = port;
    port = data.port;
    expect((await call("GET", "/api/parts")).status).toBe(200);
    port = saved;

    const quiet = await uiCommand(undefined, { port: "0", open: false }, ctx, () => {
      throw new Error("must not open");
    });
    expect(quiet.text).toContain("open that URL in your browser");
    // A part folder outside the workspace: its parent becomes the workspace.
    const other = join(t.root, "elsewhere");
    await newCommand("relay-module", {}, { ...ctx, workspace: other });
    const out = await uiCommand(join(other, "relay-module"), { port: "0", open: false }, ctx);
    expect((out.data as { workspace: string }).workspace).toBe(other);
    await expect(
      uiCommand(join(t.root, "x.fzpz"), { port: "0", open: false }, ctx),
    ).rejects.toThrow();
    writeFileSync(join(t.root, "y.fzpz"), "");
    await expect(uiCommand("y.fzpz", { port: "0", open: false }, ctx)).rejects.toThrow(
      /edits part folders/,
    );
    await stopAll();
  });
});
