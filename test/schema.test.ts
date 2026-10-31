import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJsonSchema } from "../scripts/gen-schema.js";
import { parsePartSpec } from "../src/core/schema/part.js";

describe("part schema", () => {
  it("published JSON Schema is in sync with the zod schema (npm run gen-schema)", () => {
    const onDisk = JSON.parse(readFileSync("src/core/schema/part.schema.json", "utf8"));
    expect(onDisk).toEqual(buildJsonSchema());
  });
  it("applies defaults", () => {
    const s = parsePartSpec({ slug: "abc", title: "x", outline: { widthMm: 1, heightMm: 1 } });
    expect(s.artwork.style).toBe("vector");
    expect(s.pcb.mode).toBe("auto");
    expect(s.label).toBe("A");
  });
  it("rejects unknown keys and bad slugs", () => {
    expect(() =>
      parsePartSpec({ slug: "Bad Slug", title: "x", outline: { widthMm: 1, heightMm: 1 } }),
    ).toThrow();
    expect(() =>
      parsePartSpec({ slug: "abc", title: "x", outline: { widthMm: 1, heightMm: 1 }, bogus: 1 }),
    ).toThrow();
  });
});
