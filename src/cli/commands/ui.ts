/**
 * `fritzkit ui [part] [--port <n>] [--no-open]`: start the local part editor (spec D15/D16).
 * The server lives in src/server; this verb only parses options, checks the app is
 * built, starts it and prints the URL. The listening socket keeps the process alive until
 * Ctrl+C (main.ts sets process.exitCode and never calls process.exit).
 */
import { dirname, resolve } from "node:path";
import {
  appUrl,
  defaultUiDir,
  DEFAULT_PORT,
  hasBuiltUi,
  openBrowser,
  startUi,
} from "../../server/index.js";
import {
  CliError,
  EXIT_NOT_IMPLEMENTED,
  resolveTarget,
  workspaceOf,
  type CommandContext,
  type CommandResult,
} from "../context.js";

export interface UiData {
  url: string;
  port: number;
  workspace: string;
  slug?: string;
  uiDir: string;
}

/** Parse --port: an integer 0-65535 (0 = any free port). */
export function parsePort(port: string | undefined): number | undefined {
  if (port === undefined) return undefined;
  const n = Number(port);
  if (!/^\d+$/.test(port.trim()) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new CliError(`--port must be an integer from 0 to 65535 (got "${port}")`);
  }
  return n;
}

export async function uiCommand(
  part: string | undefined,
  opts: { port?: string; open?: boolean },
  ctx: CommandContext,
  launch: (url: string) => void = openBrowser,
): Promise<CommandResult<UiData | Record<string, never>>> {
  const port = parsePort(opts.port);
  const uiDir = resolve(ctx.env.FRITZKIT_UI_DIST ?? defaultUiDir());
  if (!hasBuiltUi(uiDir)) {
    return {
      exitCode: EXIT_NOT_IMPLEMENTED,
      text: [
        `fritzkit ui: the editor app is not built (no index.html in ${uiDir}).`,
        "From a fritzkit checkout run `npm run ui:build` (or `npm run build`) and try again,",
        "or run `npm run ui:dev` for the hot-reloading dev server (it serves the API too;",
        "set FRITZKIT_WORKSPACE to choose the workspace).",
      ].join("\n"),
      data: {},
    };
  }
  let workspace = workspaceOf(ctx);
  let slug: string | undefined;
  if (part !== undefined) {
    const t = await resolveTarget(part, ctx);
    if (t.kind === "fzpz") {
      throw new CliError(`${t.path} is a .fzpz; fritzkit ui edits part folders (part.json)`);
    }
    slug = t.slug;
    if (resolve(dirname(t.dir)) !== resolve(workspace)) workspace = dirname(t.dir);
  }
  const ui = await startUi({
    ctx,
    workspace,
    uiDir,
    port: port ?? DEFAULT_PORT,
    strictPort: port !== undefined,
  });
  const url = appUrl(ui.port, slug);
  const lines = [`fritzkit ui: editing ${workspace}`, `  ${url}`];
  if (opts.open === false) {
    lines.push("open that URL in your browser; press Ctrl+C to stop");
  } else {
    launch(url);
    lines.push("opened in your browser; press Ctrl+C to stop");
  }
  const data: UiData = { url, port: ui.port, workspace, uiDir };
  if (slug !== undefined) data.slug = slug;
  return { exitCode: 0, text: lines.join("\n"), data };
}
