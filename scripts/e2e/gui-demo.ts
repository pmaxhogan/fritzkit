/**
 * GUI acceptance demo (spec section 1 item 2), driven with AutoHotkey v2:
 *   1. install the part (folder + My Parts bin) with Fritzing closed
 *   2. launch Fritzing, open a new sketch (it comes with a breadboard), show MINE
 *   3. drag the part from the bin onto the canvas, move it above the breadboard, fit
 *   4. find the board on screen by its colour, derive every pad's screen position from
 *      the spec, find the breadboard hole grid by pixel analysis
 *   5. drag one wire from each pad to its own breadboard column
 *   6. Ctrl+S to a known path, parse the .fzz and count the wired connectors
 *   7. screenshots at every step, close Fritzing gracefully
 *
 * Assumptions (local only): Windows, a single maximized monitor, Fritzing 1.0.7b.
 * Pixel coordinates are physical (DPI aware). The MINE tab and the bin icon grid are
 * located relative to the screen's right edge (measured on 3440x1440); override with
 * FRITZKIT_E2E_MINE_TAB=x,y and FRITZKIT_E2E_BIN_ICON=x,y if your layout differs.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compilePart } from "../../src/core/compile/index.js";
import type { CompiledPart } from "../../src/core/compile/types.js";
import { buildFzpzBytes } from "../../src/core/export/fzpz.js";
import { installPart } from "../../src/core/export/install.js";
import { readBin } from "../../src/core/export/bin.js";
import { fritzingPaths, fritzingRunState } from "../../src/core/fritzing.js";
import { parsePartSpec } from "../../src/core/schema/part.js";
import { toCanvas } from "../../src/core/resolve.js";
import {
  ahk,
  findBreadboardByHoles,
  findBreadboardHoles,
  findColorBbox,
  hexToRgb,
  screenshot,
  type Bbox,
} from "./screen.js";
import { verifySketch, type SketchVerification } from "./verify-sketch.js";

export interface GuiDemoResult {
  ok: boolean;
  moduleId: string;
  sketchPath: string;
  screenshots: string[];
  verification?: SketchVerification;
  messages: string[];
}

function envPoint(name: string): [number, number] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const [x, y] = v.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? [x!, y!] : undefined;
}

async function screenSize(): Promise<{ w: number; h: number }> {
  const lines = await ahk(["win"]);
  // "hwnd|title|class|x,y,w,h" of the maximized main window: use w/h minus borders.
  const main = lines.find((l) => /Fritzing/.test(l));
  const m = /\|(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(main ?? "");
  if (!m) return { w: 3440, h: 1440 };
  return { w: Number(m[3]) + 2 * Number(m[1]), h: Number(m[4]) + 2 * Number(m[2]) };
}

export async function guiDemo(
  partDir: string,
  outDir: string,
  opts: { name?: string; date?: string; keepOpen?: boolean } = {},
): Promise<GuiDemoResult> {
  const name = opts.name ?? "gui-demo";
  mkdirSync(outDir, { recursive: true });
  const shots: string[] = [];
  const messages: string[] = [];
  const shot = async (label: string, region?: Bbox) => {
    const p = join(outDir, `${String(shots.length + 1).padStart(2, "0")}-${label}.png`);
    await screenshot(p, region);
    shots.push(p);
    return p;
  };
  const fail = async (
    moduleId: string,
    sketchPath: string,
    msg: string,
  ): Promise<GuiDemoResult> => {
    messages.push(msg);
    if (!opts.keepOpen && (await fritzingRunState()) === "running") {
      try {
        await shot("failure");
        await ahk([
          "close",
          "Untitled Sketch",
          ";",
          "sleep",
          "1500",
          ";",
          "close",
          "Untitled Sketch",
          ";",
          "sleep",
          "2500",
        ]);
      } catch {
        messages.push("warning: could not close Fritzing after the failure");
      }
    }
    return { ok: false, moduleId, sketchPath, screenshots: shots, messages };
  };

  // 1. compile + install with Fritzing closed
  const spec = parsePartSpec(JSON.parse(readFileSync(join(partDir, "part.json"), "utf8")));
  const compiled: CompiledPart = await compilePart(spec, { date: opts.date });
  const moduleId = compiled.identity.moduleId;
  const sketchPath = resolve(outDir, `${name}.fzz`);
  if ((await fritzingRunState()) !== "stopped") {
    return await fail(
      moduleId,
      sketchPath,
      "Fritzing is running; close it (save your sketch) and rerun",
    );
  }
  writeFileSync(join(outDir, `${moduleId}.fzpz`), buildFzpzBytes(compiled.entries));
  const paths = fritzingPaths();
  const inst = await installPart(compiled, { paths });
  messages.push(
    `installed ${inst.moduleId} into ${inst.installedDir} (bin updated: ${inst.binUpdated})`,
  );
  const binIndex = (await readBin(paths.myPartsBin)).instances.findIndex(
    (i) => i.moduleIdRef === moduleId,
  );
  if (binIndex < 0)
    return await fail(moduleId, sketchPath, "part missing from my_parts.fzb after install");
  if (existsSync(sketchPath)) rmSync(sketchPath);

  // 2. launch, new sketch, MINE
  if (!paths.exe) return await fail(moduleId, sketchPath, "Fritzing.exe not found");
  await ahk(
    ["launch", paths.exe, ";", "sleep", "1500", ";", "key", "^n", ";", "sleep", "6000"],
    120_000,
  );
  await ahk(["activatet", "Untitled Sketch 2", ";", "sleep", "1500"]);
  const { w: SW } = await screenSize();
  const mine = envPoint("FRITZKIT_E2E_MINE_TAB") ?? [SW - 305, 188];
  await ahk(["click", String(mine[0]), String(mine[1]), ";", "sleep", "1500"]);
  await shot("mine-bin", { x: SW - 330, y: 60, w: 330, h: 400 });

  // 3. drag the part icon (bin grid: 4 per row, 60 px cells, first cell at SW-252,160)
  const icon = envPoint("FRITZKIT_E2E_BIN_ICON") ?? [
    SW - 252 + (binIndex % 4) * 60,
    160 + Math.floor(binIndex / 4) * 60,
  ];
  await ahk([
    "drag",
    String(icon[0]),
    String(icon[1]),
    "1200",
    "400",
    "30",
    ";",
    "sleep",
    "1500",
    ";",
    "click",
    "600",
    "400",
    ";",
    "key",
    "^0",
    ";",
    "sleep",
    "1500",
  ]);
  const s1 = await shot("dropped");
  const boardRgb = hexToRgb(spec.artwork.boardColor);
  let board = await findColorBbox(s1, boardRgb, 12, { x: 0, y: 60, w: SW - 340, h: 1300 });
  if (!board)
    return await fail(
      moduleId,
      sketchPath,
      `board colour ${spec.artwork.boardColor} not found on screen after drop`,
    );
  // Move the board so it sits just above the breadboard, then fit again for a bigger view.
  const bbBody = await findBreadboardByHoles(
    s1,
    { x: 0, y: board.y + board.h + 5, w: SW - 340, h: 1300 - board.y - board.h },
    120,
  );
  if (!bbBody) return await fail(moduleId, sketchPath, "breadboard body not found on screen");
  const cx = board.x + board.w / 2;
  const cy = board.y + board.h / 2;
  const targetX = bbBody.x + bbBody.w / 2;
  const targetY = bbBody.y - board.h / 2 - 60;
  messages.push(
    `board at ${board.x},${board.y} ${board.w}x${board.h}; breadboard at ${bbBody.x},${bbBody.y} ${bbBody.w}x${bbBody.h}`,
  );
  await ahk([
    "drag",
    String(Math.round(cx)),
    String(Math.round(cy)),
    String(Math.round(targetX)),
    String(Math.round(targetY)),
    "30",
    ";",
    "sleep",
    "800",
    ";",
    "click",
    "600",
    "400",
    ";",
    "key",
    "^0",
    ";",
    "sleep",
    "1500",
  ]);
  const s2 = await shot("placed");
  board = await findColorBbox(s2, boardRgb, 12, { x: 0, y: 60, w: SW - 340, h: 1300 });
  if (!board) return await fail(moduleId, sketchPath, "board colour not found after placing");
  const aspect = board.w / board.h;
  const want = spec.outline.widthMm / spec.outline.heightMm;
  if (Math.abs(aspect - want) / want > 0.15) {
    messages.push(
      `warning: on-screen board aspect ${aspect.toFixed(2)} differs from outline ${want.toFixed(2)}; colour bbox may include other items`,
    );
  }

  // 4. pads -> screen, holes grid
  const frame = compiled.resolved.frame;
  const outlineOnCanvas = {
    x: frame.offsetXMm,
    y: frame.offsetYMm,
    w: spec.outline.widthMm,
    h: spec.outline.heightMm,
  };
  const pxPerMm = board.w / outlineOnCanvas.w;
  const pads = compiled.resolved.connectors.map((c) => {
    const p = toCanvas(frame, c.lead ? c.lead.fromXMm : c.xMm, c.lead ? c.lead.fromYMm : c.yMm);
    return {
      id: c.fzpId,
      name: c.name,
      sx: Math.round(board.x + (p.x - outlineOnCanvas.x) * pxPerMm),
      sy: Math.round(board.y + (p.y - outlineOnCanvas.y) * pxPerMm),
    };
  });
  const bb2 = await findBreadboardByHoles(s2, {
    x: 0,
    y: board.y + board.h + 5,
    w: SW - 340,
    h: 1300 - board.y - board.h,
  });
  if (!bb2) return await fail(moduleId, sketchPath, "breadboard body not found after placing");
  const grid = await findBreadboardHoles(s2, bb2);
  if (grid.cols.length < pads.length * 4)
    return await fail(moduleId, sketchPath, `only ${grid.cols.length} hole columns found`);
  const rowY = grid.rows[0]!;
  // Assign columns: pads sorted by x, each at least 4 columns apart, nearest to its x.
  const order = [...pads].sort((a, b) => a.sx - b.sx);
  let lastCol = -5;
  const targets = new Map<string, { x: number; y: number }>();
  for (const p of order) {
    let col = grid.cols.findIndex((x) => x >= p.sx);
    if (col < 0) col = grid.cols.length - 1;
    col = Math.max(col, lastCol + 4);
    if (col >= grid.cols.length) col = grid.cols.length - 1;
    lastCol = col;
    targets.set(p.id, { x: grid.cols[col]!, y: rowY });
  }

  // 5. wires
  for (const p of pads) {
    const t = targets.get(p.id)!;
    await ahk([
      "drag",
      String(p.sx),
      String(p.sy),
      String(t.x),
      String(t.y),
      "40",
      ";",
      "sleep",
      "900",
    ]);
    await shot(`wire-${p.id}`);
  }
  await ahk(["click", "600", "400", ";", "sleep", "500"]);
  await shot("wired");

  // 6. save + verify
  await ahk([
    "key",
    "^s",
    ";",
    "sleep",
    "2500",
    ";",
    "type",
    sketchPath,
    ";",
    "sleep",
    "500",
    ";",
    "key",
    "{Enter}",
    ";",
    "sleep",
    "4000",
  ]);
  if (!existsSync(sketchPath)) {
    await shot("save-failed");
    return await fail(
      moduleId,
      sketchPath,
      "sketch was not saved (dialog did not accept the path?)",
    );
  }
  await shot("saved");
  const verification = verifySketch(sketchPath, moduleId);
  const wired = verification.connectors.filter((c) => c.wires.length > 0).length;
  messages.push(
    `connectors with a wire: ${wired}/${compiled.resolved.connectors.length}; wires to breadboard: ${verification.wiresToBreadboard}`,
  );
  const ok =
    verification.instanceFound &&
    wired === compiled.resolved.connectors.length &&
    verification.wiresToBreadboard === compiled.resolved.connectors.length;

  // 7. close
  if (!opts.keepOpen) {
    await ahk([
      "close",
      name,
      ";",
      "sleep",
      "1500",
      ";",
      "close",
      "Untitled Sketch",
      ";",
      "sleep",
      "2500",
    ]);
    const state = await fritzingRunState();
    if (state !== "stopped")
      messages.push(`warning: Fritzing still ${state} after close; a dialog may be open`);
  }
  return { ok, moduleId, sketchPath, screenshots: shots, verification, messages };
}
