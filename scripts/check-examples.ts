// Validates every example part under examples/ and runs Fritzing's part checker on each.
// Run: node --import tsx scripts/check-examples.ts [--no-checker] [dir]
// Exit 0 when every part is clean; 1 on any error, a missing checker (unless
// --no-checker), or pinIds that are not committed (part.json is never rewritten).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFzpz } from "../src/core/export/fzpz.js";
import { allocatePinIds } from "../src/core/resolve.js";
import { parsePartSpec } from "../src/core/schema/part.js";
import { runFzpChecker, type CheckerResult } from "../src/core/validate/checker.js";
import {
  formatIssues,
  validateCompiled,
  validateSpecJson,
  type Issue,
} from "../src/core/validate/index.js";
import { compileFromDir } from "../src/core/workspace.js";

export interface ExampleReport {
  slug: string;
  moduleId?: string;
  issues: Issue[];
}

/** Part folders (those holding a part.json) directly under `dir`, sorted. */
export function listExampleDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "part.json")))
    .map((d) => d.name)
    .sort();
}

function checkerIssues(r: CheckerResult): Issue[] {
  if (!r.available) {
    return [
      {
        level: "error",
        code: "fzp-checker-unavailable",
        message: r.errors[0] ?? "the fzp checker is not available",
      },
    ];
  }
  const issues: Issue[] = [
    ...r.errors.map((message): Issue => ({ level: "error", code: "fzp-checker", message })),
    ...r.warnings.map((message): Issue => ({ level: "warning", code: "fzp-checker", message })),
  ];
  if (r.exitCode !== 0 && r.errors.length === 0) {
    issues.push({
      level: "error",
      code: "fzp-checker",
      message: `checker exited with ${String(r.exitCode)}`,
    });
  }
  return issues;
}

/** Validate one example folder; never writes into it. */
export async function checkExample(
  dir: string,
  opts: { checker: boolean; tmp: string; repoRoot: string },
): Promise<ExampleReport> {
  const slug = dir.split(/[\\/]/).pop() ?? dir;
  const raw = JSON.parse(readFileSync(join(dir, "part.json"), "utf8")) as unknown;
  const specIssues = validateSpecJson(raw);
  if (specIssues.length > 0) return { slug, issues: specIssues };

  const compiled = await compileFromDir(dir, { date: "2026-01-01", persist: false });
  const issues: Issue[] = [...validateCompiled(compiled)];
  for (const message of compiled.warnings)
    issues.push({ level: "error", code: "compile", message });
  const missing = allocatePinIds(parsePartSpec(raw)).added;
  if (missing.length > 0) {
    issues.push({
      level: "error",
      code: "pin-ids",
      message: `pinIds missing for ${missing.join(", ")}; run \`fritzkit validate\` on the part and commit part.json`,
    });
  }
  if (opts.checker) {
    const file = join(opts.tmp, `${compiled.identity.moduleId}.fzpz`);
    await writeFzpz(compiled, file);
    issues.push(...checkerIssues(await runFzpChecker(file, { repoRoot: opts.repoRoot })));
  }
  return { slug, moduleId: compiled.identity.moduleId, issues };
}

export async function main(argv: string[]): Promise<number> {
  const checker = !argv.includes("--no-checker");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const repoRoot = resolve(import.meta.dirname, "..");
  const dir = resolve(positional[0] ?? join(repoRoot, "examples"));
  const slugs = listExampleDirs(dir);
  if (slugs.length === 0) {
    console.log(`no example parts under ${dir}`);
    return 1;
  }
  const tmp = mkdtempSync(join(tmpdir(), "fritzkit-check-examples-"));
  let failed = 0;
  try {
    for (const slug of slugs) {
      const r = await checkExample(join(dir, slug), { checker, tmp, repoRoot });
      const bad = r.issues.some((i) => i.level === "error");
      if (bad) failed++;
      console.log(`${bad ? "FAIL" : "ok  "} ${slug}${r.moduleId ? ` (${r.moduleId})` : ""}`);
      if (r.issues.length > 0) console.log(formatIssues(r.issues));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(
    `${slugs.length - failed}/${slugs.length} example parts clean${checker ? " (with the fzp checker)" : ""}`,
  );
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && /check-examples/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    },
  );
}
