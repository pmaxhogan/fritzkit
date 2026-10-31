import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      // The UI (src/ui) has no unit tests by design (spec D30); keep it out of the
      // denominator so the coverage ratchet measures the core, CLI and MCP only.
      include: ["src/core/**/*.ts", "src/cli/**/*.ts", "src/mcp/**/*.ts"],
      exclude: ["**/*.test.ts", "src/cli/main.ts", "src/mcp/main.ts"],
    },
  },
});
