/**
 * Shared plumbing for the CLI verbs and the MCP tools: the injectable context, error
 * classes with exit codes, error formatting, Fritzing path overrides and the
 * <part> argument resolver (slug, part folder or .fzpz).
 *
 * Command code never writes to process.stdout directly: everything goes through the
 * returned CommandResult (or ctx.out), so the MCP server's stdout stays pure JSON-RPC.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { FritzingRunningError } from "../core/export/install.js";
import { fritzingPaths, isFritzingRunning, type FritzingPaths } from "../core/fritzing.js";
import { SLUG_RE } from "../core/schema/part.js";
import type { CheckerOptions, CheckerResult, DoctorOptions } from "../core/validate/index.js";
import { listParts, PART_FILE, PartJsonError, resolveWorkspace } from "../core/workspace.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_FRITZING_RUNNING = 3;

export const SCHEMA_HINT = "run `fritzkit schema` for the format";

export interface CommandContext {
  env: NodeJS.ProcessEnv;
  /** Base for relative paths (default process.cwd()). */
  cwd?: string;
  /** --workspace flag (wins over FRITZKIT_WORKSPACE). */
  workspace?: string;
  /** ISO date written into the fzp; default today. Fixed in tests. */
  date?: string;
  /** Injected for tests; defaults to isFritzingRunning. */
  isRunning?: () => Promise<boolean>;
  /** Injected for tests (e.g. skipLxml, a bogus uvPath). */
  doctorOptions?: Omit<DoctorOptions, "env">;
  /** Injected for tests; defaults to runFzpChecker. */
  runChecker?: (fzpzPath: string, opts?: CheckerOptions) => Promise<CheckerResult>;
}

export interface CommandResult<T = unknown> {
  exitCode: number;
  /** Human-readable output (no trailing newline). */
  text: string;
  /** Machine-readable output for --json and the MCP server. */
  data: T;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_ERROR,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class NotImplementedError extends CliError {
  constructor(message: string) {
    super(message, EXIT_NOT_IMPLEMENTED);
    this.name = "NotImplementedError";
  }
}

interface ZodLikeIssue {
  path: PropertyKey[];
  message: string;
}

/** Duck-typed ZodError check (works across zod copies). */
export function isZodError(e: unknown): e is Error & { issues: ZodLikeIssue[] } {
  return (
    e instanceof Error &&
    e.name === "ZodError" &&
    Array.isArray((e as unknown as { issues?: unknown }).issues)
  );
}

/** One line per zod issue ("  path: message") plus the schema hint. */
export function formatZodIssues(issues: readonly ZodLikeIssue[]): string {
  const lines = issues.map((i) => {
    const path = i.path.map(String).join(".");
    return `  ${path || "(root)"}: ${i.message}`;
  });
  return ["part.json does not match the fritzkit part schema:", ...lines, SCHEMA_HINT].join("\n");
}

/** Map any thrown value to an exit code and a human message. */
export function describeError(e: unknown): { exitCode: number; message: string } {
  if (e instanceof CliError) return { exitCode: e.exitCode, message: e.message };
  if (e instanceof FritzingRunningError) {
    return { exitCode: EXIT_FRITZING_RUNNING, message: fritzingRunningMessage() };
  }
  if (isZodError(e)) return { exitCode: EXIT_ERROR, message: formatZodIssues(e.issues) };
  if (e instanceof PartJsonError) return { exitCode: EXIT_ERROR, message: e.message };
  if (e instanceof Error) return { exitCode: EXIT_ERROR, message: e.message };
  return { exitCode: EXIT_ERROR, message: String(e) };
}

export function fritzingRunningMessage(action = "install"): string {
  return (
    `Fritzing is running, so fritzkit will not ${action}. Fritzing scans its user parts ` +
    `folder only at startup and would not see the change until it restarts. Close ` +
    `Fritzing (File > Quit) and run the command again.`
  );
}

export function cwdOf(ctx: CommandContext): string {
  return ctx.cwd ?? process.cwd();
}

export function workspaceOf(ctx: CommandContext): string {
  return resolveWorkspace(
    ctx.workspace === undefined ? undefined : resolve(cwdOf(ctx), ctx.workspace),
    ctx.env,
  );
}

export function isRunningOf(ctx: CommandContext): () => Promise<boolean> {
  return ctx.isRunning ?? isFritzingRunning;
}

/**
 * fritzingPaths(env) with test/CI overrides: FRITZKIT_FRITZING_USER_PARTS replaces the
 * user parts folder, FRITZKIT_FRITZING_BINS the bins folder (my_parts.fzb inside it).
 */
export function fritzingPathsFor(env: NodeJS.ProcessEnv): FritzingPaths {
  const base = fritzingPaths(env);
  const userPartsDir = env.FRITZKIT_FRITZING_USER_PARTS
    ? resolve(env.FRITZKIT_FRITZING_USER_PARTS)
    : base.userPartsDir;
  const binsDir = env.FRITZKIT_FRITZING_BINS ? resolve(env.FRITZKIT_FRITZING_BINS) : base.binsDir;
  return { ...base, userPartsDir, binsDir, myPartsBin: join(binsDir, "my_parts.fzb") };
}

export type Target =
  { kind: "dir"; dir: string; slug: string } | { kind: "fzpz"; path: string; dir: string };

/** "Unknown part" error that lists what the workspace holds. */
export async function unknownPart(part: string, workspace: string): Promise<CliError> {
  const parts = await listParts(workspace);
  const have =
    parts.length > 0
      ? `Parts in ${workspace}: ${parts.map((p) => p.slug).join(", ")}`
      : `The workspace ${workspace} has no parts yet; create one with: fritzkit new <slug>`;
  return new CliError(`unknown part "${part}". ${have}`);
}

/**
 * Resolve a <part> argument: a slug in the workspace, a part folder (or its part.json),
 * or a .fzpz file. Slugs win over same-named folders in the current directory.
 */
export async function resolveTarget(part: string, ctx: CommandContext): Promise<Target> {
  const workspace = workspaceOf(ctx);
  if (SLUG_RE.test(part) && existsSync(join(workspace, part, PART_FILE))) {
    return { kind: "dir", dir: join(workspace, part), slug: part };
  }
  const abs = resolve(cwdOf(ctx), part);
  if (existsSync(abs)) {
    const st = statSync(abs);
    if (st.isFile() && /\.fzpz$/i.test(abs)) return { kind: "fzpz", path: abs, dir: dirname(abs) };
    if (st.isFile() && basename(abs) === PART_FILE) {
      return { kind: "dir", dir: dirname(abs), slug: basename(dirname(abs)) };
    }
    if (st.isDirectory() && existsSync(join(abs, PART_FILE))) {
      return { kind: "dir", dir: abs, slug: basename(abs) };
    }
    if (st.isDirectory()) throw new CliError(`${abs} is a folder without a ${PART_FILE}`);
    throw new CliError(`${abs} is neither a part folder, a ${PART_FILE} nor a .fzpz`);
  }
  if (/\.fzpz$/i.test(part)) throw new CliError(`no such file: ${abs}`);
  throw await unknownPart(part, workspace);
}

/** Today's date (YYYY-MM-DD) unless the context fixes one. */
export function dateOf(ctx: CommandContext): string {
  return ctx.date ?? new Date().toISOString().slice(0, 10);
}

/** package.json version (same relative path from src/cli and dist/cli). */
export function cliVersion(url: string | URL = new URL("../../package.json", import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
