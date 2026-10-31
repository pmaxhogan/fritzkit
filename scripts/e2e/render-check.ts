/**
 * Programmatic acceptance check (spec section 1 item 3): render a part-only sketch with
 * `Fritzing.exe -svg <folder>` and measure the part's bounds in the breadboard SVG.
 *
 * Because the sketch holds ONLY the part, the drawn content IS the part. Fritzing adds a
 * `<g id="watermark">` (its logo) below the content; that group is excluded. Output is
 * 1000 units per inch (root width/height carry `in` units), so 1 unit = 1 mil.
 *
 * Local only (CI never installs Fritzing). Needs a desktop session: Fritzing ships only
 * the windows platform plugin. A watchdog kills the process after `timeoutMs` so a modal
 * dialog cannot hang the run.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompiledPart } from "../../src/core/compile/types.js";
import { fritzingPaths } from "../../src/core/fritzing.js";
import { buildPartOnlySketchFzz } from "./sketch.js";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RenderMeasurement {
  svgPath: string;
  /** Root width/height in mm, from the `in` units Fritzing writes. */
  rootWMm: number;
  rootHMm: number;
  /** Part content bounds (watermark excluded), in mm. */
  partWMm: number;
  partHMm: number;
  bounds: Bounds;
  /** connectorNpin ids found in the render. */
  connectorIds: string[];
  elementsMeasured: number;
}

const MM_PER_IN = 25.4;

/** Run `Fritzing.exe -svg folder` with a timeout; resolves with exit code and whether it timed out. */
export function runFritzingSvg(
  folder: string,
  opts: { exe?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  const exe = opts.exe ?? fritzingPaths().exe;
  if (!exe) throw new Error("Fritzing.exe not found (set FRITZKIT_FRITZING_EXE)");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise((resolve) => {
    const child = spawn(exe, ["-svg", folder], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: false,
    });
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stderr });
    });
  });
}

/** Strip the watermark group (balanced <g ...>...</g> starting at id="watermark"). */
export function stripWatermark(svg: string): string {
  const start = svg.search(/<g\b[^>]*\bid="watermark"/);
  if (start < 0) return svg;
  let depth = 0;
  const re = /<g\b[^>]*?(\/?)>|<\/g\s*>/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (m[0].startsWith("</g")) {
      depth--;
      if (depth === 0) return svg.slice(0, start) + svg.slice(m.index + m[0].length);
    } else if (m[1] !== "/") {
      depth++;
    }
  }
  return svg.slice(0, start);
}

function attr(tag: string, name: string): number | undefined {
  // Preceded by whitespace so "width" never matches inside "stroke-width".
  const m = new RegExp(`(?<=\\s)${name}="([^"]*)"`).exec(tag);
  if (!m) return undefined;
  const v = parseFloat(m[1]!);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Axis-aligned bounds of the drawn elements (rect, circle, ellipse, image, line,
 * polygon/polyline points, path numbers) in viewBox units. Text is ignored (its extent is
 * font dependent); transforms are ignored, which is fine for Fritzing's flat -svg output.
 */
export function measureBounds(svg: string): { bounds: Bounds; count: number } {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let count = 0;
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    b.minX = Math.min(b.minX, x1, x2);
    b.minY = Math.min(b.minY, y1, y2);
    b.maxX = Math.max(b.maxX, x1, x2);
    b.maxY = Math.max(b.maxY, y1, y2);
    count++;
  };
  const tagRe = /<(rect|circle|ellipse|image|line|polygon|polyline|path)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg))) {
    const tag = m[0];
    const sw = attr(tag, "stroke-width") ?? 0;
    const half = /stroke="none"/.test(tag) ? 0 : sw / 2;
    switch (m[1]) {
      case "rect":
      case "image": {
        const x = attr(tag, "x") ?? 0;
        const y = attr(tag, "y") ?? 0;
        const w = attr(tag, "width") ?? 0;
        const h = attr(tag, "height") ?? 0;
        grow(x - half, y - half, x + w + half, y + h + half);
        break;
      }
      case "circle": {
        const cx = attr(tag, "cx") ?? 0;
        const cy = attr(tag, "cy") ?? 0;
        const r = (attr(tag, "r") ?? 0) + half;
        grow(cx - r, cy - r, cx + r, cy + r);
        break;
      }
      case "ellipse": {
        const cx = attr(tag, "cx") ?? 0;
        const cy = attr(tag, "cy") ?? 0;
        const rx = (attr(tag, "rx") ?? 0) + half;
        const ry = (attr(tag, "ry") ?? 0) + half;
        grow(cx - rx, cy - ry, cx + rx, cy + ry);
        break;
      }
      case "line": {
        grow(
          (attr(tag, "x1") ?? 0) - half,
          (attr(tag, "y1") ?? 0) - half,
          (attr(tag, "x2") ?? 0) + half,
          (attr(tag, "y2") ?? 0) + half,
        );
        break;
      }
      case "polygon":
      case "polyline": {
        const pts = /points="([^"]*)"/.exec(tag)?.[1] ?? "";
        const nums = pts
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2)
          grow(nums[i]!, nums[i + 1]!, nums[i]!, nums[i + 1]!);
        break;
      }
      case "path": {
        // Rough: every absolute coordinate pair in the path. Good enough for bounds of
        // outlines; relative commands would under-measure, so only use for sanity.
        const d = /\bd="([^"]*)"/.exec(tag)?.[1] ?? "";
        const nums = d
          .replace(/[A-Za-z]/g, " ")
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2)
          grow(nums[i]!, nums[i + 1]!, nums[i]!, nums[i + 1]!);
        break;
      }
    }
  }
  return { bounds: b, count };
}

export function measureRenderedBreadboard(svgPath: string): RenderMeasurement {
  const raw = readFileSync(svgPath, "utf8");
  const root = /<svg\b[^>]*>/.exec(raw)?.[0] ?? "";
  const wIn = /\bwidth="([\d.]+)in"/.exec(root)?.[1];
  const hIn = /\bheight="([\d.]+)in"/.exec(root)?.[1];
  const vb = /viewBox="([^"]*)"/.exec(root)?.[1]?.split(/\s+/).map(Number) ?? [];
  if (!wIn || !hIn || vb.length !== 4) throw new Error(`unexpected svg root: ${root}`);
  const unitsPerIn = vb[2]! / parseFloat(wIn);
  const svg = stripWatermark(raw);
  const { bounds, count } = measureBounds(svg);
  const toMm = (u: number) => (u / unitsPerIn) * MM_PER_IN;
  const ids = [...svg.matchAll(/id="(connector\d+pin)"/g)].map((m) => m[1]!);
  return {
    svgPath,
    rootWMm: parseFloat(wIn) * MM_PER_IN,
    rootHMm: parseFloat(hIn) * MM_PER_IN,
    partWMm: toMm(bounds.maxX - bounds.minX),
    partHMm: toMm(bounds.maxY - bounds.minY),
    bounds,
    connectorIds: [...new Set(ids)],
    elementsMeasured: count,
  };
}

export interface RenderCheckResult {
  ok: boolean;
  measurement?: RenderMeasurement;
  expectedWMm: number;
  expectedHMm: number;
  toleranceMm: number;
  fzzPath: string;
  svgPath: string;
  fritzing: { code: number | null; timedOut: boolean; stderr: string };
  messages: string[];
}

/**
 * Write a part-only sketch into outDir, render it with Fritzing and compare the measured
 * part size with the outline (+- toleranceMm).
 */
export async function renderCheck(
  compiled: CompiledPart,
  outDir: string,
  opts: { toleranceMm?: number; exe?: string; timeoutMs?: number; name?: string } = {},
): Promise<RenderCheckResult> {
  const name = opts.name ?? "render-check";
  mkdirSync(outDir, { recursive: true });
  const fzzPath = join(outDir, `${name}.fzz`);
  writeFileSync(fzzPath, buildPartOnlySketchFzz(compiled, name));
  const svgPath = join(outDir, `${name}_breadboard.svg`);
  const fritzing = await runFritzingSvg(outDir, { exe: opts.exe, timeoutMs: opts.timeoutMs });
  const expectedWMm = compiled.resolved.spec.outline.widthMm;
  const expectedHMm = compiled.resolved.spec.outline.heightMm;
  const toleranceMm = opts.toleranceMm ?? 1;
  const messages: string[] = [];
  const base = { expectedWMm, expectedHMm, toleranceMm, fzzPath, svgPath, fritzing, messages };
  if (fritzing.timedOut) {
    messages.push(`Fritzing -svg timed out after ${opts.timeoutMs ?? 90000} ms (modal dialog?)`);
    return { ok: false, ...base };
  }
  if (!existsSync(svgPath)) {
    messages.push(`Fritzing exited with code ${fritzing.code} but wrote no ${svgPath}`);
    return { ok: false, ...base };
  }
  const measurement = measureRenderedBreadboard(svgPath);
  const dw = Math.abs(measurement.partWMm - expectedWMm);
  const dh = Math.abs(measurement.partHMm - expectedHMm);
  messages.push(
    `rendered part ${measurement.partWMm.toFixed(2)} x ${measurement.partHMm.toFixed(2)} mm (expected ${expectedWMm} x ${expectedHMm}, tolerance ${toleranceMm})`,
  );
  const expectedIds = compiled.resolved.connectors.map((c) => c.svgId);
  const missing = expectedIds.filter((id) => !measurement.connectorIds.includes(id));
  if (missing.length) messages.push(`connector ids missing from the render: ${missing.join(", ")}`);
  const ok = dw <= toleranceMm && dh <= toleranceMm && missing.length === 0;
  return { ok, measurement, ...base };
}
