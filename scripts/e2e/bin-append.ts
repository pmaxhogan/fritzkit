// Dev helper: append an installed part to Fritzing's My Parts bin (my_parts.fzb).
// Usage: node --import tsx scripts/e2e/bin-append.ts <moduleId> [bare|abs]
import { sep } from "node:path";
import { readBin, addBinInstance, writeBin } from "../../src/core/export/bin.js";
import { fritzingPaths } from "../../src/core/fritzing.js";

const id = process.argv[2];
const mode = process.argv[3] ?? "abs";
if (!id) throw new Error("usage: bin-append <moduleId> [bare|abs]");
const p = fritzingPaths();
const b = await readBin(p.myPartsBin);
const abs = [p.userPartsDir, id, `${id}.fzp`].join(sep).split(sep).join("/");
const path = mode === "bare" ? `${id}.fzp` : abs;
const xml = addBinInstance(b.xml, { moduleIdRef: id, path });
await writeBin(p.myPartsBin, xml);
console.log(xml);
