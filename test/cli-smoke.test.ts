import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("fritzkit bin (spawned)", () => {
  it("--help lists every verb", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", "--help"], {
      encoding: "utf8",
    });
    for (const verb of [
      "init",
      "new",
      "list",
      "validate",
      "render",
      "export",
      "install",
      "prune",
      "doctor",
      "schema",
      "import-kicad",
      "mcp",
      "ui",
    ]) {
      expect(out).toMatch(new RegExp(`^  ${verb}\\b`, "m"));
    }
    expect(out).toContain("--workspace <dir>");
    expect(out).toContain("--json");
  }, 30_000);
});
