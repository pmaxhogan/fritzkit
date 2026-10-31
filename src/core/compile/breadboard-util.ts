/**
 * Small pure helpers for the breadboard renderer: an SVG path number scaler (part
 * outlines are written in mm, the SVG is in mil) and a hex colour darkener.
 */
import { fmt } from "../units.js";

/** Number of parameters each path command takes (per repetition). */
const PARAM_COUNT: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

export class PathParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathParseError";
  }
}

/**
 * Scale every length in an SVG path by `factor` (e.g. mm -> mil). Works for absolute
 * and relative M/L/H/V/C/S/Q/T/A/Z commands, including implicit repetitions and the
 * compact arc-flag form ("a1 1 0 01 5 5"). Arc rotation and flags are not scaled.
 * Output is normalised: one command letter per segment, numbers formatted with fmt.
 */
export function scalePath(d: string, factor: number): string {
  let i = 0;
  const n = d.length;
  const skipSep = () => {
    while (i < n && /[\s,]/.test(d[i]!)) i++;
  };
  const readNumber = (): number => {
    skipSep();
    const m = NUMBER_RE.exec(d.slice(i));
    if (!m) throw new PathParseError(`expected a number at offset ${i} in path "${d}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const readFlag = (): string => {
    skipSep();
    const ch = d[i];
    if (ch !== "0" && ch !== "1") {
      throw new PathParseError(`expected an arc flag (0 or 1) at offset ${i} in path "${d}"`);
    }
    i++;
    return ch;
  };
  const startsNumber = (): boolean => {
    skipSep();
    return i < n && /[-+.\d]/.test(d[i]!);
  };

  const out: string[] = [];
  skipSep();
  while (i < n) {
    const cmd = d[i]!;
    const lower = cmd.toLowerCase();
    const count = PARAM_COUNT[lower];
    if (count === undefined) {
      throw new PathParseError(`unknown path command "${cmd}" at offset ${i} in path "${d}"`);
    }
    i++;
    if (count === 0) {
      out.push(cmd);
      skipSep();
      continue;
    }
    let first = true;
    do {
      const params: string[] = [];
      for (let k = 0; k < count; k++) {
        if (lower === "a" && (k === 3 || k === 4)) params.push(readFlag());
        else if (lower === "a" && k === 2) params.push(fmt(readNumber()));
        else params.push(fmt(readNumber() * factor));
      }
      // Implicit repetitions after M/m are line-tos; keep the explicit letter each time.
      const letter = first ? cmd : lower === "m" ? (cmd === "M" ? "L" : "l") : cmd;
      out.push(letter + params.join(" "));
      first = false;
    } while (startsNumber());
    skipSep();
  }
  return out.join(" ");
}

/** Darken a #RRGGBB colour by multiplying each channel by (1 - amount). */
export function darkenHex(hex: string, amount = 0.3): string {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!m) throw new Error(`darkenHex: not a #RRGGBB colour: ${hex}`);
  const v = parseInt(m[1]!, 16);
  const ch = (shift: number) => {
    const c = Math.round(((v >> shift) & 0xff) * (1 - amount));
    return Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0").toUpperCase();
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
