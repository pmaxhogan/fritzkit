/**
 * The commander program behind `fritzkit`. buildProgram wires each verb to its handler in
 * commands/*.ts; runCli parses argv, prints the result (text, or JSON with --json) and
 * returns the exit code: 0 ok, 1 validation/usage error, 2 not implemented, 3 Fritzing
 * running. Nothing here calls process.exit, so tests can drive it in-process.
 */
import { Command, CommanderError, Option } from "commander";
import {
  cliVersion,
  describeError,
  EXIT_ERROR,
  type CommandContext,
  type CommandResult,
} from "./context.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand, installCommand } from "./commands/export.js";
import { importKicadCommand } from "./commands/kicad.js";
import { initCommand, listCommand, newCommand } from "./commands/parts.js";
import { pruneCommand } from "./commands/prune.js";
import { renderCommand } from "./commands/render.js";
import { schemaCommand } from "./commands/schema.js";
import { uiCommand } from "./commands/ui.js";
import { validateCommand } from "./commands/validate.js";

export interface CliIo {
  /** stdout sink (receives whole chunks, newline included). */
  out: (s: string) => void;
  /** stderr sink. */
  err: (s: string) => void;
}

interface GlobalOpts {
  workspace?: string;
  json?: boolean;
}

/** Hook the `mcp` verb uses to start the stdio server (overridable in tests). */
export type McpStarter = (ctx: CommandContext) => Promise<void>;

const defaultMcpStarter: McpStarter = async (ctx) => {
  const { startStdioServer } = await import("../mcp/server.js");
  await startStdioServer(ctx);
};

function wrap(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { data };
}

export function buildProgram(
  io: CliIo,
  base: CommandContext,
  state: { exitCode: number },
  startMcp: McpStarter = defaultMcpStarter,
): Command {
  const program = new Command();
  program
    .name("fritzkit")
    .description("Compile a JSON part spec (part.json) into a Fritzing part (.fzpz)")
    .version(cliVersion(), "-V, --version")
    .option(
      "--workspace <dir>",
      "parts workspace (default: $FRITZKIT_WORKSPACE or ~/fritzkit/parts)",
    )
    .option("--json", "machine-readable JSON output")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  // Every verb's action: build the context, run the handler, print, record the exit code.
  const run =
    <A extends unknown[]>(fn: (ctx: CommandContext, ...args: A) => Promise<CommandResult>) =>
    async (...args: unknown[]): Promise<void> => {
      const cmd = args[args.length - 1] as Command;
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const ctx: CommandContext = { ...base };
      if (g.workspace !== undefined) ctx.workspace = g.workspace;
      try {
        const r = await fn(ctx, ...(args.slice(0, -1) as A));
        if (g.json) {
          io.out(JSON.stringify({ exitCode: r.exitCode, ...wrap(r.data) }, null, 2) + "\n");
        } else if (r.text) {
          io.out(r.text + "\n");
        }
        state.exitCode = r.exitCode;
      } catch (e) {
        const { exitCode, message } = describeError(e);
        if (g.json) io.out(JSON.stringify({ exitCode, error: message }, null, 2) + "\n");
        else io.err(`${message.startsWith("fritzkit") ? "" : "fritzkit: "}${message}\n`);
        state.exitCode = exitCode;
      }
    };

  program
    .command("init")
    .description("create the workspace folder and print its path")
    .action(run((ctx) => initCommand(ctx)));

  program
    .command("new <slug>")
    .description("create <workspace>/<slug>/part.json from the template")
    .option("--title <title>", "part title (default: the slug)")
    .action(run((ctx, slug: string, o: { title?: string }) => newCommand(slug, o, ctx)));

  program
    .command("list")
    .description("list the parts in the workspace")
    .action(run((ctx) => listCommand(ctx)));

  program
    .command("validate <part>")
    .description("check a part (slug, part folder or .fzpz): schema, compile, structure")
    .option("--checker", "also run Fritzing's fzp checker (needs uv)")
    .action(run((ctx, part: string, o: { checker?: boolean }) => validateCommand(part, o, ctx)));

  program
    .command("render <part>")
    .description("write the view SVGs (default <partdir>/build/)")
    .addOption(
      new Option("--view <view>", "view to render")
        .choices(["breadboard", "schematic", "pcb", "icon", "all"])
        .default("all"),
    )
    .option("--out <dir>", "output folder")
    .option("--png", "also rasterise each SVG to PNG at 300 dpi")
    .action(
      run((ctx, part: string, o: { view?: string; out?: string; png?: boolean }) =>
        renderCommand(part, o, ctx),
      ),
    );

  program
    .command("export <part>")
    .description("compile and write <partdir>/<moduleId>.fzpz")
    .option("--out <file>", "output .fzpz path")
    .option("--install", "also install into Fritzing's user parts folder")
    .option("--force", "export even when the validator reports errors")
    .action(
      run((ctx, part: string, o: { out?: string; install?: boolean; force?: boolean }) =>
        exportCommand(part, o, ctx),
      ),
    );

  program
    .command("install <part>")
    .description("export and install into Fritzing (same as export --install)")
    .option("--out <file>", "output .fzpz path")
    .option("--force", "install even when the validator reports errors")
    .action(
      run((ctx, part: string, o: { out?: string; force?: boolean }) =>
        installCommand(part, o, ctx),
      ),
    );

  program
    .command("prune <family-or-slug>")
    .description("remove older installed versions of a part (dry run unless --yes)")
    .option("--keep <moduleId>", "version to keep (default: the newest)")
    .option("--yes", "actually delete")
    .action(
      run((ctx, arg: string, o: { keep?: string; yes?: boolean }) => pruneCommand(arg, o, ctx)),
    );

  program
    .command("doctor")
    .description("check Node, Fritzing, uv, the fzp checker and sharp")
    .action(run((ctx) => doctorCommand(ctx)));

  program
    .command("schema")
    .description("print the part.json JSON Schema")
    .option("--out <file>", "write it to a file instead")
    .action(run((ctx, o: { out?: string }) => schemaCommand(o, ctx)));

  program
    .command("import-kicad <file>")
    .description("create a part folder from a KiCad .kicad_mod footprint")
    .requiredOption("--slug <slug>", "slug of the new part")
    .option("--title <title>", "part title (default: the footprint name)")
    .action(
      run((ctx, file: string, o: { slug: string; title?: string }) =>
        importKicadCommand(file, o, ctx),
      ),
    );

  program
    .command("mcp")
    .description("start the fritzkit MCP server on stdio")
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      await startMcp(g.workspace !== undefined ? { ...base, workspace: g.workspace } : base);
    });

  program
    .command("ui [part]")
    .description("open the part editor in the browser (local server on 127.0.0.1)")
    .option("--port <n>", "port to listen on (default 5173, or the next free one)")
    .option("--no-open", "print the URL instead of opening the browser")
    .action(
      run((ctx, part: string | undefined, o: { port?: string; open?: boolean }) =>
        uiCommand(part, o, ctx),
      ),
    );

  return program;
}

/** Parse user args (argv without node and the script) and run; resolves to the exit code. */
export async function runCli(
  argv: string[],
  io: CliIo,
  base: CommandContext = { env: process.env },
  startMcp?: McpStarter,
): Promise<number> {
  const state = { exitCode: 0 };
  const program = buildProgram(io, base, state, startMcp);
  if (argv.length === 0) {
    program.outputHelp();
    return EXIT_ERROR;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : EXIT_ERROR;
    throw e;
  }
  return state.exitCode;
}
