// Generates src/core/schema/part.schema.json from the zod schema. Run: npm run gen-schema
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { PartSpec } from "../src/core/schema/part.js";

export function buildJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PartSpec, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/pmaxhogan/fritzkit/main/src/core/schema/part.schema.json",
    title: "fritzkit part.json",
    description:
      "A fritzkit part spec. All lengths are millimetres; origin is the top-left corner of the outline, y down.",
    ...schema,
  };
}

if (process.argv[1] && /gen-schema/.test(process.argv[1])) {
  writeFileSync(
    "src/core/schema/part.schema.json",
    JSON.stringify(buildJsonSchema(), null, 2) + "\n",
  );
  console.log("wrote src/core/schema/part.schema.json");
}
