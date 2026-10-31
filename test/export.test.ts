import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFzpzBytes,
  fzpzMtime,
  parseFzpInfo,
  parseFzpzBytes,
  readFzpz,
  writeFzpz,
} from "../src/core/export/index.js";
import { REPO_ROOT, swapV2, tempFritzing, vectorPart } from "./export-helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
function tmp() {
  const t = tempFritzing();
  cleanups.push(t.cleanup);
  return t.root;
}

describe("buildFzpzBytes", () => {
  it("is byte-deterministic across builds", () => {
    const a = buildFzpzBytes(vectorPart().entries);
    const b = buildFzpzBytes(vectorPart().entries);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("writes a flat zip with the entries in order and a fixed local mtime", () => {
    const part = vectorPart();
    const bytes = buildFzpzBytes(part.entries);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(part.entries.map((e) => e.name));
    expect(Object.keys(files).every((n) => !n.includes("/"))).toBe(true);
    // Local file header: DOS time at offset 10, date at offset 12.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const dosTime = view.getUint16(10, true);
    const dosDate = view.getUint16(12, true);
    expect(dosTime).toBe(0);
    expect(dosDate).toBe(((2026 - 1980) << 9) | (1 << 5) | 1);
    expect(fzpzMtime().getFullYear()).toBe(2026);
  });

  it("writes the same bytes whatever the local time zone", () => {
    const saved = process.env.TZ;
    try {
      const hashes = new Set<string>();
      for (const tz of ["UTC", "America/Chicago", "Asia/Tokyo", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        hashes.add(Buffer.from(buildFzpzBytes(vectorPart().entries)).toString("base64"));
      }
      expect(hashes.size).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("rejects nested, empty and duplicate names", () => {
    const d = new Uint8Array([1]);
    expect(() => buildFzpzBytes([{ name: "a/b.svg", data: d }])).toThrow(/flat/);
    expect(() => buildFzpzBytes([{ name: "a\\b.svg", data: d }])).toThrow(/flat/);
    expect(() => buildFzpzBytes([{ name: "", data: d }])).toThrow(/invalid/);
    expect(() =>
      buildFzpzBytes([
        { name: "x.svg", data: d },
        { name: "x.svg", data: d },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("writeFzpz / readFzpz", () => {
  it("round-trips entries and parses the fzp", async () => {
    const part = vectorPart();
    const out = await writeFzpz(part, join(tmp(), "out", "spike.fzpz"));
    expect(existsSync(out)).toBe(true);
    const r = await readFzpz(out);
    expect(r.entries.map((e) => e.name)).toEqual(part.entries.map((e) => e.name));
    r.entries.forEach((e, i) =>
      expect(Buffer.from(e.data)).toEqual(Buffer.from(part.entries[i]!.data)),
    );
    expect(r.moduleId).toBe("fritzkit-spike-vector-00000001");
    expect(r.family).toBe("fritzkit-spike");
    expect(r.variant).toBe("vector");
    expect(r.fzp).toBe(part.fzp);
    expect(r.fzpEntry).toBe("part.fritzkit-spike-vector-00000001.fzp");
    expect(r.images).toEqual({
      breadboard: "breadboard/fritzkit-spike-vector-00000001_breadboard.svg",
      schematic: "schematic/fritzkit-spike-vector-00000001_schematic.svg",
      pcb: "pcb/fritzkit-spike-vector-00000001_pcb.svg",
      icon: "icon/fritzkit-spike-vector-00000001_icon.svg",
    });
    // Same bytes on disk as an in-memory build.
    expect(Buffer.from(readFileSync(out)).equals(Buffer.from(buildFzpzBytes(part.entries)))).toBe(
      true,
    );
  });

  it("names the file and says 'not a zip' for garbage input", async () => {
    const bad = join(tmp(), "bad.fzpz");
    writeFileSync(bad, "<module moduleId='x'/>");
    const err = (await readFzpz(bad).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(bad);
    expect(err.message).toMatch(/not a readable zip/);
    expect(() => parseFzpzBytes(new Uint8Array(0))).toThrow(/not a \.fzpz/);
  });

  it("rejects an archive without exactly one fzp", () => {
    const svg = { name: "svg.icon.x_icon.svg", data: new Uint8Array([60]) };
    expect(() => parseFzpzBytes(buildFzpzBytes([svg]))).toThrow(/exactly one/);
  });
});

describe("parseFzpInfo", () => {
  it("reads title, version and single-quoted attributes", () => {
    const info = parseFzpInfo(
      "<?xml version='1.0'?><module moduleId='abcdefgh_1'><version>3</version>" +
        "<title>Thing</title><properties><property name='Family'>fam</property></properties>" +
        "<views><iconView><layers image='breadboard/x_breadboard.svg'><layer layerId='icon'/>" +
        "</layers></iconView></views></module>",
    );
    expect(info).toEqual({
      moduleId: "abcdefgh_1",
      family: "fam",
      title: "Thing",
      version: "3",
      images: { icon: "breadboard/x_breadboard.svg" },
    });
  });

  it("throws without a moduleId", () => {
    expect(() => parseFzpInfo("<module><title>x</title></module>")).toThrow(/moduleId/);
    expect(() => parseFzpInfo("<other/>")).toThrow(/moduleId/);
  });
});

const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

describe("fzp checker", () => {
  it.skipIf(!uvAvailable)(
    "accepts the written .fzpz",
    async () => {
      const dir = tmp();
      for (const part of [vectorPart(), swapV2()]) {
        const out = await writeFzpz(part, join(dir, `${part.identity.moduleId}.fzpz`));
        const r = spawnSync("uv", ["run", "--project", "tools/fzp-checker", "check-fzp", out], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1" },
        });
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      }
    },
    180_000,
  );
});
