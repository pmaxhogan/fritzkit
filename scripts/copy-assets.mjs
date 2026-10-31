// Copies non-TS assets (JSON Schema) into dist/ after tsc.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const pairs = [["src/core/schema/part.schema.json", "dist/core/schema/part.schema.json"]];
for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  mkdirSync(to.substring(0, to.lastIndexOf("/")), { recursive: true });
  cpSync(from, to);
}
