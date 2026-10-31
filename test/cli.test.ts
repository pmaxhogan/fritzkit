import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorCommand } from "../src/cli/commands/doctor.js";
import { exportCommand, installCommand } from "../src/cli/commands/export.js";
import { importKicadCommand } from "../src/cli/commands/kicad.js";
import { initCommand, listCommand, newCommand } from "../src/cli/commands/parts.js";
import { familyFor, pruneCommand } from "../src/cli/commands/prune.js";
import { parseView, renderCommand } from "../src/cli/commands/render.js";
import { schemaCommand, schemaPath } from "../src/cli/commands/schema.js";
import { uiCommand } from "../src/cli/commands/ui.js";
import { validateCommand, warningIssues } from "../src/cli/commands/validate.js";
import {
  CliError,
  cliVersion,
  dateOf,
  describeError,
  formatZodIssues,
  fritzingPathsFor,
  isRunningOf,
  isZodError,
  NotImplementedError,
  resolveTarget,
  workspaceOf,
  type CommandContext,
} from "../src/cli/context.js";
import { runCli } from "../src/cli/program.js";
import { readFzpz } from "../src/core/export/fzpz.js";
import { FritzingRunningError } from "../src/core/export/install.js";
import { listInstalledParts } from "../src/core/export/prune.js";
import { isFritzingRunning } from "../src/core/fritzing.js";
import type { CheckerResult } from "../src/core/validate/index.js";
import { readPartJson, writePart } from "../src/core/workspace.js";
import { tempEnv, type TempEnv } from "./cli-helpers.js";

let t: TempEnv;
let ctx: CommandContext;

beforeEach(() => {
  t = tempEnv();
  ctx = t.ctx;
});
afterEach(() => t.cleanup());

const SLUG = "sensor-breakout";

async function newPart(slug = SLUG, title = "Sensor breakout"): Promise<string> {
  const r = await newCommand(slug, { title }, ctx);
  return r.data.dir;
}

/** Run the CLI in-process and capture stdout/stderr. */
async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(
    argv,
    { out: (s) => (out += s), err: (s) => (err += s) },
    ctx,
    async () => {
      out += "mcp started\n";
    },
  );
  return { code, out, err };
}

const checker =
  (over: Partial<CheckerResult>): CommandContext["runChecker"] =>
  async () => ({
    available: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    errors: [],
    warnings: [],
    ...over,
  });

describe("context helpers", () => {
  it("fritzingPathsFor applies the env overrides", () => {
    const p = fritzingPathsFor(ctx.env);
    expect(p.userPartsDir).toBe(t.userParts);
    expect(p.binsDir).toBe(t.bins);
    expect(p.myPartsBin).toBe(join(t.bins, "my_parts.fzb"));
    const plain = fritzingPathsFor({ USERPROFILE: t.root });
    expect(plain.userPartsDir).not.toBe(t.userParts);
    expect(plain.myPartsBin).toBe(join(plain.binsDir, "my_parts.fzb"));
  });

  it("workspaceOf / dateOf / isRunningOf fall back to defaults", () => {
    expect(workspaceOf(ctx)).toBe(t.ws);
    expect(workspaceOf({ env: { FRITZKIT_WORKSPACE: t.root } })).toBe(t.root);
    expect(dateOf(ctx)).toBe("2026-01-01");
    expect(dateOf({ env: {} })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isRunningOf({ env: {} })).toBe(isFritzingRunning);
  });

  it("describeError maps errors to exit codes", () => {
    expect(describeError(new CliError("x", 3))).toEqual({ exitCode: 3, message: "x" });
    expect(describeError(new NotImplementedError("later")).exitCode).toBe(2);
    expect(describeError(new FritzingRunningError()).exitCode).toBe(3);
    expect(describeError(new FritzingRunningError()).message).toMatch(/Close Fritzing/);
    expect(describeError(new Error("boom"))).toEqual({ exitCode: 1, message: "boom" });
    expect(describeError("plain")).toEqual({ exitCode: 1, message: "plain" });
    const zod = Object.assign(new Error("z"), {
      name: "ZodError",
      issues: [
        { path: ["pins", 0, "xMm"], message: "Expected number" },
        { path: [], message: "Bad root" },
      ],
    });
    expect(isZodError(zod)).toBe(true);
    expect(isZodError(new Error("x"))).toBe(false);
    const msg = describeError(zod).message;
    expect(msg).toContain("  pins.0.xMm: Expected number");
    expect(msg).toContain("  (root): Bad root");
    expect(msg).toContain("run `fritzkit schema` for the format");
    expect(formatZodIssues([])).toContain("fritzkit schema");
  });

  it("cliVersion reads package.json and survives a missing file", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(cliVersion(new URL("file:///no/such/package.json"))).toBe("0.0.0");
    const noVersion = join(t.root, "package.json");
    writeFileSync(noVersion, "{}");
    expect(cliVersion(noVersion)).toBe("0.0.0");
  });
});

describe("resolveTarget", () => {
  it("resolves slugs, folders, part.json files and .fzpz files", async () => {
    const dir = await newPart();
    expect(await resolveTarget(SLUG, ctx)).toEqual({ kind: "dir", dir, slug: SLUG });
    expect(await resolveTarget(dir, ctx)).toMatchObject({ kind: "dir", dir });
    expect(await resolveTarget(join(dir, "part.json"), ctx)).toMatchObject({ kind: "dir", dir });
    const fz = join(t.root, "x.fzpz");
    writeFileSync(fz, "");
    expect(await resolveTarget("x.fzpz", ctx)).toEqual({ kind: "fzpz", path: fz, dir: t.root });
  });

  it("explains what is wrong with a bad target", async () => {
    await expect(resolveTarget("nope", ctx)).rejects.toThrow(/no parts yet/);
    await newPart();
    await expect(resolveTarget("nope", ctx)).rejects.toThrow(/Parts in .*: sensor-breakout/);
    await expect(resolveTarget("missing.fzpz", ctx)).rejects.toThrow(/no such file/);
    mkdirSync(join(t.root, "empty"));
    await expect(resolveTarget("empty", ctx)).rejects.toThrow(/without a part.json/);
    writeFileSync(join(t.root, "notes.txt"), "");
    await expect(resolveTarget("notes.txt", ctx)).rejects.toThrow(/neither/);
  });
});

describe("init / new / list", () => {
  it("creates the workspace and a part folder from the template", async () => {
    expect((await initCommand(ctx)).text).toBe(t.ws);
    expect(existsSync(t.ws)).toBe(true);
    const r = await newCommand(SLUG, {}, ctx);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.ws, SLUG, "assets", ".gitkeep"))).toBe(true);
    expect((await readPartJson(join(t.ws, SLUG))).title).toBe(SLUG);
    await expect(newCommand(SLUG, {}, ctx)).rejects.toThrow(/already exists/);
    await expect(newCommand("Bad Slug", {}, ctx)).rejects.toThrow(/invalid slug/);
  });

  it("lists parts, or says how to create one", async () => {
    expect((await listCommand(ctx)).text).toMatch(/no parts in/);
    await newPart();
    await newPart("relay-module", "Relay module");
    const r = await listCommand(ctx);
    expect(r.text).toBe("relay-module     Relay module\nsensor-breakout  Sensor breakout");
    expect(r.data.parts).toHaveLength(2);
  });
});

describe("validate", () => {
  it("passes the template and assigns its pinIds", async () => {
    const dir = await newPart();
    const r = await validateCommand(SLUG, {}, ctx);
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain("No issues found.");
    expect(r.data.moduleId).toMatch(/^fritzkit-sensor-breakout-[0-9a-f]{8}$/);
    expect((await readPartJson(dir)).pinIds).toEqual({ VCC: 0 });
  });

  it("reports schema errors with their path and the schema hint", async () => {
    const dir = await newPart();
    const raw = await readPartJson(dir);
    await writePart(dir, { ...raw, outline: { widthMm: -1, heightMm: 15 }, bogus: 1 } as never);
    const r = await validateCommand(SLUG, {}, ctx);
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("<outline.widthMm>");
    expect(r.text).toContain("run `fritzkit schema` for the format");
    expect(r.data.issues.every((i) => i.code === "spec-schema")).toBe(true);
  });

  it("runs the checker on a build .fzpz and folds its findings in", async () => {
    await newPart();
    const clean = await validateCommand(
      SLUG,
      { checker: true },
      { ...ctx, runChecker: checker({}) },
    );
    expect(clean.exitCode).toBe(0);
    expect(clean.data.checker?.available).toBe(true);
    expect(existsSync(join(t.ws, SLUG, "build", `${clean.data.moduleId}.fzpz`))).toBe(true);

    const bad = await validateCommand(
      SLUG,
      { checker: true },
      { ...ctx, runChecker: checker({ exitCode: 65, errors: ["bad thing"], warnings: ["meh"] }) },
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.text).toContain("ERROR [fzp-checker] bad thing");
    expect(bad.text).toContain("WARN  [fzp-checker] meh");

    const none = await validateCommand(
      SLUG,
      { checker: true },
      { ...ctx, runChecker: checker({ available: false, errors: ["uv missing"] }) },
    );
    expect(none.exitCode).toBe(0);
    expect(none.text).toContain("[fzp-checker-unavailable] uv missing");
    const silent = await validateCommand(
      SLUG,
      { checker: true },
      { ...ctx, runChecker: checker({ available: false }) },
    );
    expect(silent.text).toContain("not available");
  });

  it("validates a .fzpz directly", async () => {
    await newPart();
    const exp = await exportCommand(SLUG, {}, ctx);
    const r = await validateCommand(
      exp.data.fzpz,
      { checker: true },
      { ...ctx, runChecker: checker({}) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.data.moduleId).toBeUndefined();
  });

  it("maps compile warnings to warning issues", () => {
    expect(warningIssues(["w"])).toEqual([{ level: "warning", code: "compile", message: "w" }]);
  });
});

describe("render", () => {
  it("writes every view SVG (and PNGs) into <partdir>/build by default", async () => {
    const dir = await newPart();
    const r = await renderCommand(SLUG, { png: true }, ctx);
    expect(r.data.files).toHaveLength(8);
    const png = readFileSync(join(dir, "build", "breadboard.png"));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(readFileSync(join(dir, "build", "pcb.svg"), "utf8")).toContain('id="copper1"');
  });

  it("renders one view to --out, also from a .fzpz", async () => {
    await newPart();
    const r = await renderCommand(SLUG, { view: "schematic", out: "out" }, ctx);
    expect(r.data.files).toEqual([join(t.root, "out", "schematic.svg")]);
    const exp = await exportCommand(SLUG, {}, ctx);
    const z = await renderCommand(exp.data.fzpz, { view: "icon" }, ctx);
    expect(z.data.files).toEqual([join(t.ws, SLUG, "build", "icon.svg")]);
    expect(z.data.moduleId).toBe(exp.data.moduleId);
  });

  it("rejects unknown views and a .fzpz missing a view", async () => {
    expect(parseView(undefined)).toBe("all");
    expect(parseView("pcb")).toBe("pcb");
    expect(() => parseView("3d")).toThrow(/unknown view "3d"/);
    const exp = await exportCommand(await newPart().then(() => SLUG), {}, ctx);
    const fz = await readFzpz(exp.data.fzpz);
    const partial = join(t.root, "partial.fzpz");
    const files: Record<string, Uint8Array> = {};
    for (const e of fz.entries.filter((x) => !x.name.startsWith("svg.icon.")))
      files[e.name] = e.data;
    writeFileSync(partial, zipSync(files));
    await expect(renderCommand(partial, { view: "icon" }, ctx)).rejects.toThrow(/no icon view/);
  });
});

describe("export / install", () => {
  it("new -> validate -> export produces a .fzpz that round-trips", async () => {
    await newPart();
    expect((await validateCommand(SLUG, {}, ctx)).exitCode).toBe(0);
    const r = await exportCommand(SLUG, {}, ctx);
    expect(r.exitCode).toBe(0);
    expect(r.data.fzpz).toBe(join(t.ws, SLUG, `${r.data.moduleId}.fzpz`));
    const fz = await readFzpz(r.data.fzpz);
    expect(fz.moduleId).toBe(r.data.moduleId);
    expect(fz.family).toBe(SLUG);
    expect(fz.entries.map((e) => e.name)).toEqual([
      `part.${r.data.moduleId}.fzp`,
      `svg.breadboard.${r.data.moduleId}_breadboard.svg`,
      `svg.schematic.${r.data.moduleId}_schematic.svg`,
      `svg.pcb.${r.data.moduleId}_pcb.svg`,
      `svg.icon.${r.data.moduleId}_icon.svg`,
    ]);
    expect(r.text).toContain(`moduleId ${r.data.moduleId}`);
    // Re-exporting an unchanged part gives the same moduleId.
    expect((await exportCommand(SLUG, { out: "again.fzpz" }, ctx)).data).toMatchObject({
      moduleId: r.data.moduleId,
      fzpz: join(t.root, "again.fzpz"),
    });
    // --out never overwrites a non-.fzpz file (e.g. part.json itself).
    await expect(exportCommand(SLUG, { out: "part.json" }, ctx)).rejects.toThrow(
      /--out must name a .fzpz file/,
    );
  });

  it("--install writes into the overridden Fritzing user parts folder", async () => {
    await newPart();
    const r = await exportCommand(SLUG, { install: true }, ctx);
    expect(r.exitCode).toBe(0);
    const dir = join(t.userParts, r.data.moduleId);
    expect(r.data.installed?.installedDir).toBe(dir);
    expect(existsSync(join(dir, `${r.data.moduleId}.fzp`))).toBe(true);
    expect(existsSync(join(dir, "breadboard", `${r.data.moduleId}_breadboard.svg`))).toBe(true);
    expect(r.text).toContain("installed to");
    const again = await installCommand(SLUG, {}, ctx);
    expect(again.data.installed?.alreadyInstalled).toBe(true);
    expect(again.text).toContain("re-installed");
  });

  it("refuses to install while Fritzing runs (exit 3) but keeps the .fzpz", async () => {
    await newPart();
    t.running.value = true;
    const err = await exportCommand(SLUG, { install: true }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect((err as CliError).message).toMatch(/Fritzing is running.*\n.*\.fzpz is ready/s);
    const r = await cli("install", SLUG);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Fritzing is running");
  });

  it("installs a .fzpz as is, and refuses to re-export one", async () => {
    await newPart();
    const exp = await exportCommand(SLUG, {}, ctx);
    await expect(exportCommand(exp.data.fzpz, {}, ctx)).rejects.toThrow(/already a .fzpz/);
    const r = await installCommand(exp.data.fzpz, {}, ctx);
    expect(r.data.moduleId).toBe(exp.data.moduleId);
    expect(r.text).toContain(`moduleId ${exp.data.moduleId}`);
  });

  it("blocks on validator errors unless --force", async () => {
    await newPart();
    const exp = await exportCommand(SLUG, {}, ctx);
    const fz = await readFzpz(exp.data.fzpz);
    const files: Record<string, Uint8Array> = {};
    for (const e of fz.entries) {
      files[e.name] = e.name.startsWith("svg.pcb.")
        ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
        : e.data;
    }
    const broken = join(t.root, "broken.fzpz");
    writeFileSync(broken, zipSync(files));
    const r = await installCommand(broken, {}, ctx);
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("not exported: fix the errors above or pass --force");
    const forced = await installCommand(broken, { force: true }, ctx);
    expect(forced.exitCode).toBe(0);
    expect(forced.text).toContain("ERROR");
  });

  it("reports compile warnings (photo asset missing) without blocking", async () => {
    const dir = await newPart();
    const raw = await readPartJson(dir);
    await writePart(dir, { ...raw, artwork: { style: "photo", photo: { src: "assets/x.png" } } });
    const r = await exportCommand(SLUG, {}, ctx);
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain("WARN  [compile]");
  });
});

describe("prune", () => {
  async function installTwo(): Promise<[string, string]> {
    const dir = await newPart();
    const a = (await installCommand(SLUG, {}, ctx)).data.moduleId;
    const raw = await readPartJson(dir);
    await writePart(dir, { ...raw, version: 2, title: "Sensor breakout v2" });
    const b = (await installCommand(SLUG, {}, ctx)).data.moduleId;
    return [a, b];
  }

  it("dry-runs by default, deletes with --yes", async () => {
    const [a, b] = await installTwo();
    const dry = await pruneCommand(SLUG, {}, ctx);
    expect(dry.data).toMatchObject({ family: SLUG, dryRun: true, keep: [b], remove: [a] });
    expect(dry.text).toContain("pass --yes to delete");
    expect(existsSync(join(t.userParts, a))).toBe(true);
    const wet = await pruneCommand(SLUG, { yes: true }, ctx);
    expect(wet.data.removedDirs).toEqual([join(t.userParts, a)]);
    expect(existsSync(join(t.userParts, a))).toBe(false);
    expect(
      (await listInstalledParts({ userPartsDir: t.userParts })).map((p) => p.moduleId),
    ).toEqual([b]);
    expect((await pruneCommand(SLUG, {}, ctx)).text).toContain("nothing to prune");
  });

  it("honours --keep, a family name and a missing family", async () => {
    const [a, b] = await installTwo();
    const r = await pruneCommand(SLUG, { keep: a }, ctx);
    expect(r.data).toMatchObject({ keep: [a], remove: [b] });
    expect((await pruneCommand("other-family", {}, ctx)).text).toMatch(/no installed parts/);
  });

  it("refuses to delete while Fritzing runs", async () => {
    await installTwo();
    t.running.value = true;
    const r = await cli("prune", SLUG, "--yes");
    expect(r.code).toBe(3);
    expect(r.err).toContain("will not prune");
  });

  it("familyFor reads the spec family, else uses the argument", async () => {
    const dir = await newPart();
    expect(await familyFor(SLUG, ctx)).toBe(SLUG);
    await writePart(dir, { ...(await readPartJson(dir)), family: "sensors" });
    expect(await familyFor(SLUG, ctx)).toBe("sensors");
    writeFileSync(join(dir, "part.json"), "{");
    expect(await familyFor(SLUG, ctx)).toBe(SLUG);
    expect(await familyFor("Some Family", ctx)).toBe("Some Family");
  });
});

describe("doctor / schema / import-kicad / ui", () => {
  it("doctor formats the report and fails when something required is missing", async () => {
    const r = await doctorCommand(ctx);
    expect(r.text).toContain("uv on PATH");
    expect(r.exitCode).toBe(r.data.ok ? 0 : 1);
    expect(r.data.ok).toBe(false);
  }, 30_000);

  it("schema prints or writes the JSON Schema", async () => {
    const r = await schemaCommand({}, ctx);
    expect(JSON.parse(r.text)).toEqual(r.data);
    expect(schemaPath()).toMatch(/part\.schema\.json$/);
    const w = await schemaCommand({ out: "s.json" }, ctx);
    expect(w.text).toBe(`wrote ${join(t.root, "s.json")}`);
    expect(JSON.parse(readFileSync(join(t.root, "s.json"), "utf8"))).toEqual(r.data);
    expect(() => schemaPath(pathToFileURL(join(t.root, "a", "b", "c.js")))).toThrow(/not found/);
  });

  it("import-kicad creates a part folder that validates", async () => {
    const file = join(process.cwd(), "test", "fixtures", "kicad", "pin_header_2x03.kicad_mod");
    const r = await importKicadCommand(file, { slug: "header-2x3", title: "Header 2x3" }, ctx);
    expect(r.data.pins).toBe(6);
    expect((await readPartJson(r.data.dir)).title).toBe("Header 2x3");
    expect((await validateCommand("header-2x3", {}, ctx)).exitCode).toBe(0);
    await expect(importKicadCommand(file, { slug: "header-2x3" }, ctx)).rejects.toThrow(
      /already exists/,
    );
    const one = await importKicadCommand(file, { slug: "header-default" }, ctx);
    expect(one.text).toContain("6 pads");
  });

  it("ui exits 2 with build instructions when the app is not built", async () => {
    const env = { ...ctx.env, FRITZKIT_UI_DIST: join(t.root, "no-ui") };
    const r = await uiCommand(undefined, {}, { ...ctx, env });
    expect(r.exitCode).toBe(2);
    expect(r.text).toContain("npm run ui:build");
    expect(r.text).toContain("npm run ui:dev");
  });
});

describe("runCli", () => {
  it("prints text, --json, and the exit code", async () => {
    const init = await cli("init");
    expect(init).toMatchObject({ code: 0, out: `${t.ws}\n` });
    expect((await cli("new", SLUG, "--title", "Sensor")).code).toBe(0);
    const json = await cli("--json", "validate", SLUG);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ exitCode: 0, ok: true, issues: [] });
    const schema = await cli("--json", "schema");
    expect(JSON.parse(schema.out).exitCode).toBe(0);
    const list = await cli("list");
    expect(list.out).toBe(`${SLUG}  Sensor\n`);
  });

  it("formats errors on stderr (or as JSON) with the right exit codes", async () => {
    const unknown = await cli("validate", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^fritzkit: unknown part "nope"/);
    const j = await cli("--json", "validate", "nope");
    expect(JSON.parse(j.out)).toMatchObject({ exitCode: 1 });
    ctx.env.FRITZKIT_UI_DIST = join(t.root, "no-ui");
    const ui = await cli("ui", "--no-open");
    expect(ui.code).toBe(2);
    expect(ui.out).toContain("the editor app is not built");
  });

  it("prints zod errors by path with the schema hint", async () => {
    await cli("new", SLUG);
    const dir = join(t.ws, SLUG);
    await writePart(dir, {
      ...(await readPartJson(dir)),
      pins: [{ key: "A", name: "A" }],
    } as never);
    const r = await cli("export", SLUG);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pins.0.xMm:");
    expect(r.err).toContain("run `fritzkit schema` for the format");
  });

  it("handles help, version, usage errors and the --workspace flag", async () => {
    const help = await cli("--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("import-kicad");
    expect((await cli()).code).toBe(1);
    expect((await cli("--version")).code).toBe(0);
    expect((await cli("frobnicate")).code).toBe(1);
    expect((await cli("render", "x", "--view", "3d")).code).toBe(1);
    const other = join(t.root, "other-ws");
    const r = await cli("--workspace", other, "init");
    expect(r.out).toBe(`${other}\n`);
  });

  it("starts the MCP server through the injected starter", async () => {
    expect((await cli("mcp")).out).toBe("mcp started\n");
    expect((await cli("--workspace", "w2", "mcp")).out).toBe("mcp started\n");
  });

  it("reports a failing output sink as an error, and rethrows starter failures", async () => {
    let err = "";
    const code = await runCli(
      ["init"],
      {
        out: () => {
          throw new Error("stdout closed");
        },
        err: (s) => (err += s),
      },
      ctx,
    );
    expect(code).toBe(1);
    expect(err).toContain("stdout closed");
    await expect(
      runCli(["mcp"], { out: () => {}, err: () => {} }, ctx, async () => {
        throw new Error("transport failed");
      }),
    ).rejects.toThrow("transport failed");
  });
});
