/**
 * fritzkit MCP server (decision D3): the same verbs as the CLI, as tools, over one core.
 * Every tool takes an optional `workspace`; every failure comes back as an isError result
 * carrying the human message, never as an exception that would kill the server.
 *
 * stdio rule: nothing in here (or in the CLI command code it calls) writes to stdout;
 * stdout belongs to JSON-RPC.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VIEWS, type View } from "../core/compile/types.js";
import { resolvePart, ResolveError } from "../core/resolve.js";
import { parsePartSpec, type PartSpecInput } from "../core/schema/part.js";
import { formatIssues, validateCompiled, validateSpecJson } from "../core/validate/index.js";
import { ASSETS_DIR, partDir, readPartJson, writePart } from "../core/workspace.js";
import {
  CliError,
  cliVersion,
  describeError,
  resolveTarget,
  SCHEMA_HINT,
  workspaceOf,
  type CommandContext,
  type CommandResult,
} from "../cli/context.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { exportCommand, installCommand } from "../cli/commands/export.js";
import { importKicadCommand } from "../cli/commands/kicad.js";
import { initCommand, listCommand, newCommand } from "../cli/commands/parts.js";
import { pruneCommand } from "../cli/commands/prune.js";
import { loadSvgs } from "../cli/commands/render.js";
import { schemaCommand } from "../cli/commands/schema.js";
import { compileDir, validateCommand, warningIssues } from "../cli/commands/validate.js";
import { svgToPng } from "../cli/raster.js";
import { applyPatch, type PatchOp } from "./jsonpatch.js";

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function fromCommand(r: CommandResult, json = false): CallToolResult {
  const body = json ? JSON.stringify(r.data, null, 2) : r.text;
  return text(body, r.exitCode !== 0);
}

/** Run a handler; any throw becomes an isError result with the human message. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return text(describeError(e).message, true);
  }
}

function withWs(ctx: CommandContext, workspace: string | undefined): CommandContext {
  return workspace === undefined ? ctx : { ...ctx, workspace };
}

/** Resolve <part> to a part folder (a .fzpz is refused: it cannot be edited). */
async function folderOf(part: string, ctx: CommandContext): Promise<string> {
  const t = await resolveTarget(part, ctx);
  if (t.kind !== "dir") throw new CliError(`${t.path} is a .fzpz; edit tools need a part folder`);
  return t.dir;
}

/** Summary of the connectors the compiler will emit (ids include not-yet-persisted keys). */
export function connectorSummary(raw: PartSpecInput) {
  const resolved = resolvePart(parsePartSpec(raw));
  return {
    connectors: resolved.connectors.map((c) => ({
      key: c.key,
      id: c.fzpId,
      name: c.name,
      role: c.role,
      type: c.type,
      source: c.source,
      xMm: c.xMm,
      yMm: c.yMm,
      tht: c.tht,
    })),
    newPinKeys: resolved.newPinKeys,
  };
}

/**
 * Validate a whole spec, write it, then compile for structural issues. Rejected (nothing
 * written) on schema or resolve errors. pinIds on disk survive a body that omits them.
 */
export async function saveSpec(
  dir: string,
  raw: PartSpecInput,
  ctx: CommandContext,
): Promise<CallToolResult> {
  const schemaIssues = validateSpecJson(raw);
  if (schemaIssues.length > 0) {
    return text(`not saved:\n${formatIssues(schemaIssues)}\n${SCHEMA_HINT}`, true);
  }
  let body: PartSpecInput = raw;
  if (raw.pinIds === undefined && existsSync(join(dir, "part.json"))) {
    const old = await readPartJson(dir).catch(() => undefined);
    if (old?.pinIds) body = { ...raw, pinIds: old.pinIds };
  }
  try {
    resolvePart(parsePartSpec(body));
  } catch (e) {
    if (e instanceof ResolveError) return text(`not saved: ${e.path}: ${e.message}`, true);
    throw e;
  }
  const file = await writePart(dir, body);
  if (!existsSync(join(dir, ASSETS_DIR))) {
    await mkdir(join(dir, ASSETS_DIR), { recursive: true });
    await writeFile(join(dir, ASSETS_DIR, ".gitkeep"), "");
  }
  try {
    const compiled = await compileDir(dir, ctx);
    const issues = [...validateCompiled(compiled), ...warningIssues(compiled.warnings)];
    return text(`saved ${file} (${compiled.identity.moduleId})\n${formatIssues(issues)}`);
  } catch (e) {
    return text(`saved ${file}, but it does not compile: ${describeError(e).message}`, true);
  }
}

const ws = z.string().optional().describe("workspace folder (default ~/fritzkit/parts)");
const partArg = z.string().describe("part slug in the workspace, a part folder, or a .fzpz path");
const viewArg = z.enum(VIEWS as unknown as [View, ...View[]]);

const patchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);

const pinInput = z
  .looseObject({
    key: z.string(),
    name: z.string(),
    xMm: z.number(),
    yMm: z.number(),
  })
  .describe("a part.json pins[] entry (role, type, label, description, pad optional)");

/** Build the server with every fritzkit tool registered. */
export function createServer(base: CommandContext = { env: process.env }): McpServer {
  const server = new McpServer({ name: "fritzkit", version: cliVersion() });

  server.registerTool(
    "fritzkit_init_workspace",
    {
      description: "Create the parts workspace folder; returns its path.",
      inputSchema: { workspace: ws },
    },
    ({ workspace }) => guard(async () => fromCommand(await initCommand(withWs(base, workspace)))),
  );

  server.registerTool(
    "fritzkit_list_parts",
    {
      description: "List parts in the workspace (slug, title, folder).",
      inputSchema: { workspace: ws },
    },
    ({ workspace }) =>
      guard(async () => fromCommand(await listCommand(withWs(base, workspace)), true)),
  );

  server.registerTool(
    "fritzkit_new_part",
    {
      description: "Create <workspace>/<slug>/part.json from the minimal template.",
      inputSchema: {
        slug: z.string().describe("new part slug: 3-60 chars, lowercase letters, digits, -"),
        title: z.string().optional().describe("part title (default: the slug)"),
        workspace: ws,
      },
    },
    ({ slug, title, workspace }) =>
      guard(async () =>
        fromCommand(
          await newCommand(slug, title === undefined ? {} : { title }, withWs(base, workspace)),
        ),
      ),
  );

  server.registerTool(
    "fritzkit_get_part",
    {
      description:
        "Return part.json as written plus the resolved connectors (key, connector id, name, role, position).",
      inputSchema: { part: partArg, workspace: ws },
    },
    ({ part, workspace }) =>
      guard(async () => {
        const ctx = withWs(base, workspace);
        const dir = await folderOf(part, ctx);
        const raw = await readPartJson(dir);
        const issues = validateSpecJson(raw);
        const out: Record<string, unknown> = { dir, part: raw };
        if (issues.length > 0) out.issues = issues;
        else {
          try {
            Object.assign(out, connectorSummary(raw));
          } catch (e) {
            out.issues = [{ level: "error", code: "resolve", message: describeError(e).message }];
          }
        }
        return text(JSON.stringify(out, null, 2));
      }),
  );

  server.registerTool(
    "fritzkit_set_part",
    {
      description:
        "Replace part.json with a whole spec (validated first; nothing is written if invalid). Creates the part if missing. Returns issues.",
      inputSchema: {
        part: z.string().describe("part slug in the workspace, or a part folder"),
        json: z.record(z.string(), z.unknown()).describe("the complete part.json object"),
        workspace: ws,
      },
    },
    ({ part, json, workspace }) =>
      guard(async () => {
        const ctx = withWs(base, workspace);
        let dir: string;
        try {
          dir = await folderOf(part, ctx);
        } catch (e) {
          if (/[/\\]/.test(part) || /\.fzpz$/i.test(part)) throw e;
          dir = partDir(workspaceOf(ctx), part);
        }
        const inWorkspace = resolve(dirname(dir)) === workspaceOf(ctx);
        const slug = (json as { slug?: unknown }).slug;
        if (inWorkspace && slug !== undefined && slug !== dir.split(/[/\\]/).pop()) {
          return text(
            `not saved: json.slug "${String(slug)}" does not match the part folder; create a new part to rename`,
            true,
          );
        }
        return saveSpec(dir, json as PartSpecInput, ctx);
      }),
  );

  server.registerTool(
    "fritzkit_patch_part",
    {
      description:
        "Apply an RFC 6902 JSON Patch (add/remove/replace/test, JSON pointer paths) to part.json; validated before writing.",
      inputSchema: {
        part: partArg,
        patch: z
          .array(patchOp)
          .describe(
            "RFC 6902 ops applied in order; paths are JSON pointers like /pins/0/xMm or /tags/-",
          ),
        workspace: ws,
      },
    },
    ({ part, patch, workspace }) =>
      guard(async () => {
        const ctx = withWs(base, workspace);
        const dir = await folderOf(part, ctx);
        const raw = await readPartJson(dir);
        const next = applyPatch(raw, patch as PatchOp[]);
        return saveSpec(dir, next, ctx);
      }),
  );

  server.registerTool(
    "fritzkit_add_pins",
    {
      description:
        "Append free pins (key, name, xMm, yMm in the part frame: origin top-left, y down) to part.json.",
      inputSchema: {
        part: partArg,
        pins: z.array(pinInput).min(1).describe("pins to append to part.json pins[]"),
        workspace: ws,
      },
    },
    ({ part, pins, workspace }) =>
      guard(async () => {
        const ctx = withWs(base, workspace);
        const dir = await folderOf(part, ctx);
        const raw = await readPartJson(dir);
        const next = { ...raw, pins: [...(raw.pins ?? []), ...pins] } as PartSpecInput;
        return saveSpec(dir, next, ctx);
      }),
  );

  server.registerTool(
    "fritzkit_validate",
    {
      description:
        "Validate a part: schema, compile, structural checks; checker:true also runs Fritzing's fzp checker.",
      inputSchema: {
        part: partArg,
        checker: z.boolean().optional().describe("also run Fritzing's fzp checker (needs uv)"),
        workspace: ws,
      },
    },
    ({ part, checker, workspace }) =>
      guard(async () => {
        const r = await validateCommand(
          part,
          { checker: checker === true },
          withWs(base, workspace),
        );
        return text(r.text);
      }),
  );

  server.registerTool(
    "fritzkit_render",
    {
      description:
        "Render one view. Returns the SVG text, or with png:true a PNG image you can look at.",
      inputSchema: {
        part: partArg,
        view: viewArg.default("breadboard").describe("view to render (default breadboard)"),
        png: z.boolean().optional().describe("return a PNG image instead of SVG text"),
        dpi: z.number().int().min(30).max(600).optional().describe("PNG resolution (default 300)"),
        workspace: ws,
      },
    },
    ({ part, view, png, dpi, workspace }) =>
      guard(async () => {
        const loaded = await loadSvgs(part, withWs(base, workspace));
        const svg = loaded.svgs[view];
        if (svg === undefined) throw new CliError(`the part has no ${view} view`);
        const notes = loaded.warnings.map((w) => `warning: ${w}`);
        if (!png) return text([...notes, svg].join("\n"));
        const bytes = await svgToPng(svg, dpi ?? 300);
        return {
          content: [
            {
              type: "text",
              text: [`${loaded.moduleId} ${view} view`, ...notes].join("\n"),
            },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
          ],
        };
      }),
  );

  server.registerTool(
    "fritzkit_export",
    {
      description:
        "Compile and write <partdir>/<moduleId>.fzpz (validator errors block unless force).",
      inputSchema: {
        part: partArg,
        out: z.string().optional().describe("output .fzpz path"),
        force: z.boolean().optional().describe("export even when the validator reports errors"),
        workspace: ws,
      },
    },
    ({ part, out, force, workspace }) =>
      guard(async () =>
        fromCommand(
          await exportCommand(
            part,
            { ...(out ? { out } : {}), force: force === true },
            withWs(base, workspace),
          ),
        ),
      ),
  );

  server.registerTool(
    "fritzkit_install",
    {
      description:
        "Export and install the part into Fritzing's user parts folder. Refuses while Fritzing runs.",
      inputSchema: {
        part: partArg,
        force: z.boolean().optional().describe("install even when the validator reports errors"),
        workspace: ws,
      },
    },
    ({ part, force, workspace }) =>
      guard(async () =>
        fromCommand(await installCommand(part, { force: force === true }, withWs(base, workspace))),
      ),
  );

  server.registerTool(
    "fritzkit_prune",
    {
      description:
        "Remove older installed versions of a part family. Dry run (prints the plan) unless yes:true.",
      inputSchema: {
        family: z.string().describe("family name, or a workspace slug (uses its family)"),
        keep: z.string().optional().describe("moduleId to keep (default: newest)"),
        yes: z.boolean().optional().describe("actually delete (default: dry run)"),
        workspace: ws,
      },
    },
    ({ family, keep, yes, workspace }) =>
      guard(async () =>
        fromCommand(
          await pruneCommand(
            family,
            { ...(keep ? { keep } : {}), yes: yes === true },
            withWs(base, workspace),
          ),
        ),
      ),
  );

  server.registerTool(
    "fritzkit_import_kicad",
    {
      description:
        "Create a new part folder from a KiCad .kicad_mod footprint (exact pad geometry).",
      inputSchema: {
        file: z.string().describe("path to the .kicad_mod file"),
        slug: z.string().describe("slug of the new part"),
        title: z.string().optional().describe("part title (default: the footprint name)"),
        workspace: ws,
      },
    },
    ({ file, slug, title, workspace }) =>
      guard(async () =>
        fromCommand(
          await importKicadCommand(
            file,
            { slug, ...(title ? { title } : {}) },
            withWs(base, workspace),
          ),
        ),
      ),
  );

  server.registerTool(
    "fritzkit_schema",
    { description: "Return the part.json JSON Schema.", inputSchema: { workspace: ws } },
    () => guard(async () => fromCommand(await schemaCommand({}, base))),
  );

  server.registerTool(
    "fritzkit_doctor",
    {
      description: "Check Node, Fritzing, its folders, uv + the fzp checker and sharp.",
      inputSchema: { workspace: ws },
    },
    () => guard(async () => text((await doctorCommand(base)).text)),
  );

  return server;
}

/** Serve on stdio until stdin closes (logs, if any, go to stderr). */
export async function startStdioServer(base: CommandContext = { env: process.env }): Promise<void> {
  const server = createServer(base);
  await server.connect(new StdioServerTransport());
}
