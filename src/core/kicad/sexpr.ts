/**
 * A small s-expression parser for KiCad files (.kicad_mod, KiCad 5 to 8).
 *
 * Grammar: a file is one top-level list. A list is `(` items `)`. An item is a list,
 * a quoted string ("..." with backslash escapes \" \ \n \t \r) or an unquoted atom
 * (any run of characters other than whitespace, parens and double quotes, e.g. REF**,
 * *.Cu, Edge.Cuts, ${REFERENCE}). An unquoted atom that is entirely a decimal number
 * becomes a JS number; everything else (including every quoted string, even "1")
 * stays a string. KiCad files have no comments.
 *
 * Line numbers (1-based, counting "\n" only so CRLF files work) are kept for every
 * list in a side table; use lineOf(list) to report errors against the source.
 */

export type SExpr = string | number | SExpr[];

export class KicadParseError extends Error {
  constructor(
    message: string,
    /** 1-based source line the error refers to. */
    public readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "KicadParseError";
  }
}

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

const lines = new WeakMap<SExpr[], number>();

/** Source line of a list produced by parseSExpr (1 for lists built by hand). */
export function lineOf(list: SExpr[]): number {
  return lines.get(list) ?? 1;
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/** Parse a KiCad s-expression document. Exactly one top-level list is allowed. */
export function parseSExpr(text: string): SExpr[] {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a UTF-8 BOM
  let line = 1;
  const n = text.length;
  const stack: SExpr[][] = [];
  let root: SExpr[] | undefined;

  const push = (item: SExpr) => {
    const top = stack[stack.length - 1];
    if (!top) throw new KicadParseError("atom outside of any list", line);
    top.push(item);
  };

  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      if (root && stack.length === 0) {
        throw new KicadParseError("unexpected content after the top-level list", line);
      }
      const list: SExpr[] = [];
      lines.set(list, line);
      if (stack.length) stack[stack.length - 1]!.push(list);
      else root = list;
      stack.push(list);
      i++;
      continue;
    }
    if (c === ")") {
      if (!stack.length) throw new KicadParseError("unbalanced ')'", line);
      stack.pop();
      i++;
      continue;
    }
    if (c === '"') {
      const startLine = line;
      let s = "";
      i++;
      for (;;) {
        if (i >= n) throw new KicadParseError("unterminated string", startLine);
        const d = text[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < n) {
          const e = text[i + 1]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          if (e === "\n") line++;
          i += 2;
          continue;
        }
        if (d === "\n") line++;
        s += d;
        i++;
      }
      if (root && stack.length === 0) {
        throw new KicadParseError("unexpected content after the top-level list", startLine);
      }
      push(s);
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text[j]!;
      if (isSpace(d) || d === "(" || d === ")" || d === '"') break;
      j++;
    }
    const tok = text.slice(i, j);
    i = j;
    if (root && stack.length === 0) {
      throw new KicadParseError("unexpected content after the top-level list", line);
    }
    push(NUMBER_RE.test(tok) ? Number(tok) : tok);
  }

  if (stack.length) {
    throw new KicadParseError(
      `unbalanced '(': ${stack.length} list(s) not closed (opened here)`,
      lineOf(stack[stack.length - 1]!),
    );
  }
  if (!root) throw new KicadParseError("empty document: no top-level list", 1);
  return root;
}

/** The head (first item) of a list if it is an atom/string, else undefined. */
export function head(list: SExpr): string | undefined {
  return Array.isArray(list) && typeof list[0] === "string" ? list[0] : undefined;
}

/** First direct child list whose head is `name`. */
export function find(list: SExpr[], name: string): SExpr[] | undefined {
  for (const item of list) if (Array.isArray(item) && item[0] === name) return item;
  return undefined;
}

/** Every direct child list whose head is `name`, in order. */
export function findAll(list: SExpr[], name: string): SExpr[][] {
  const out: SExpr[][] = [];
  for (const item of list) if (Array.isArray(item) && item[0] === name) out.push(item);
  return out;
}

/** The number at list[idx], or undefined when absent or not a number. */
export function num(list: SExpr[] | undefined, idx: number): number | undefined {
  const v = list?.[idx];
  return typeof v === "number" ? v : undefined;
}

/** The atom at list[idx] as a string (numbers are stringified), or undefined. */
export function str(list: SExpr[] | undefined, idx: number): string | undefined {
  const v = list?.[idx];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}
