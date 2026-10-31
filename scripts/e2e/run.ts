/**
 * npm run e2e [-- --part <dir>] [--out <dir>] [--skip-gui] [--skip-render] [--keep-open]
 *
 * Local acceptance harness (never in CI; needs a desktop session, Fritzing 1.0.7 and
 * AutoHotkey v2). Runs the programmatic -svg render check and the GUI wiring demo for
 * one part folder, writes e2e-out/<name>/report.json and prints a summary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compilePart } from "../../src/core/compile/index.js";
import { fritzingPaths, fritzingRunState } from "../../src/core/fritzing.js";
import { parsePartSpec } from "../../src/core/schema/part.js";
import { guiDemo } from "./gui-demo.js";
import { renderCheck } from "./render-check.js";
import { ahkAvailable } from "./screen.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const partDir = resolve(arg("--part") ?? "test/fixtures/hw391");
const name = basename(partDir);
const outDir = resolve(arg("--out") ?? join("e2e-out", name));
mkdirSync(outDir, { recursive: true });

const spec = parsePartSpec(JSON.parse(readFileSync(join(partDir, "part.json"), "utf8")));
const compiled = await compilePart(spec, { date: new Date().toISOString().slice(0, 10) });
const paths = fritzingPaths();
console.log(`part: ${spec.title} (${compiled.identity.moduleId})`);
console.log(
  `Fritzing: ${paths.exe ?? "NOT FOUND"}; state: ${await fritzingRunState()}; AHK: ${ahkAvailable()}`,
);

const report: Record<string, unknown> = {
  part: partDir,
  moduleId: compiled.identity.moduleId,
  date: new Date().toISOString(),
};
let ok = true;

if (!flag("--skip-render")) {
  const r = await renderCheck(compiled, join(outDir, "render"), { name: `${name}-render` });
  report.render = r;
  ok &&= r.ok;
  console.log(`render-check: ${r.ok ? "PASS" : "FAIL"} - ${r.messages.join("; ")}`);
}

if (!flag("--skip-gui")) {
  if (!ahkAvailable()) {
    console.log("gui-demo: SKIPPED (AutoHotkey v2 not found; set FRITZKIT_AHK)");
    report.gui = { skipped: "no AutoHotkey" };
  } else {
    const g = await guiDemo(partDir, join(outDir, "gui"), {
      name: `${name}-demo`,
      keepOpen: flag("--keep-open"),
    });
    report.gui = g;
    ok &&= g.ok;
    console.log(`gui-demo: ${g.ok ? "PASS" : "FAIL"} - ${g.messages.join("; ")}`);
    console.log(`screenshots: ${g.screenshots.length} in ${join(outDir, "gui")}`);
  }
}

writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`report: ${join(outDir, "report.json")}`);
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
