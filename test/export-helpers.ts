/** Shared fixtures for the export / install / prune tests (not a test file itself). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FritzingPaths } from "../src/core/fritzing.js";
import { fzpzEntryNames, type PartIdentity } from "../src/core/identity.js";
import type { View } from "../src/core/compile/types.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "export");
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface FixturePart {
  identity: PartIdentity;
  entries: { name: string; data: Uint8Array }[];
  fzp: string;
  svgs: Record<View, string>;
}

/** Build a CompiledPart-shaped object from one of the spike fixture folders. */
export function fixturePart(
  folder: "spike-vector" | "spike-swap-v1" | "spike-swap-v2",
  moduleId: string,
  family: string,
  variant: string,
): FixturePart {
  const identity: PartIdentity = {
    moduleId,
    family,
    variant,
    hash8: moduleId.slice(-8),
    baseName: moduleId,
  };
  const names = fzpzEntryNames(identity);
  const read = (name: string) => readFileSync(join(FIXTURES, folder, name), "utf8");
  const fzp = read(names.fzp);
  const svgs = {
    breadboard: read(names.breadboard),
    schematic: read(names.schematic),
    pcb: read(names.pcb),
    icon: read(names.icon),
  };
  const enc = new TextEncoder();
  const entries = [
    { name: names.fzp, data: enc.encode(fzp) },
    { name: names.breadboard, data: enc.encode(svgs.breadboard) },
    { name: names.schematic, data: enc.encode(svgs.schematic) },
    { name: names.pcb, data: enc.encode(svgs.pcb) },
    { name: names.icon, data: enc.encode(svgs.icon) },
  ];
  return { identity, entries, fzp, svgs };
}

export const vectorPart = () =>
  fixturePart("spike-vector", "fritzkit-spike-vector-00000001", "fritzkit-spike", "vector");
export const swapV1 = () =>
  fixturePart("spike-swap-v1", "fritzkit-spike-swap-v1-00000001", "fritzkit-spike-swap", "v1");
export const swapV2 = () =>
  fixturePart("spike-swap-v2", "fritzkit-spike-swap-v2-00000002", "fritzkit-spike-swap", "v2");

/** A throwaway fake Fritzing user area. Never the real %APPDATA%. */
export function tempFritzing(): { paths: FritzingPaths; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fritzkit-export-"));
  const userPartsDir = join(root, "AppData", "Fritzing", "Fritzing", "local_parts", "user");
  const binsDir = join(root, "Documents", "Fritzing", "bins");
  mkdirSync(userPartsDir, { recursive: true });
  mkdirSync(binsDir, { recursive: true });
  return {
    root,
    paths: { userPartsDir, binsDir, myPartsBin: join(binsDir, "my_parts.fzb") },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const FIXED_NOW = () => new Date(2026, 0, 2, 3, 4, 5);
export const notRunning = async () => false;
