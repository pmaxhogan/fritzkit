import { describe, expect, it } from "vitest";
import {
  find,
  findAll,
  head,
  KicadParseError,
  lineOf,
  num,
  parseSExpr,
  str,
  type SExpr,
} from "../src/core/kicad/sexpr.js";

function parseError(text: string): KicadParseError {
  try {
    parseSExpr(text);
  } catch (e) {
    expect(e).toBeInstanceOf(KicadParseError);
    return e as KicadParseError;
  }
  throw new Error("expected a KicadParseError");
}

describe("parseSExpr", () => {
  it("parses atoms, numbers, quoted strings and nested lists", () => {
    const t = parseSExpr('(pad "1" thru_hole rect (at -1.5 2e1 90) (layers *.Cu "F.Mask") REF**)');
    expect(t).toEqual([
      "pad",
      "1",
      "thru_hole",
      "rect",
      ["at", -1.5, 20, 90],
      ["layers", "*.Cu", "F.Mask"],
      "REF**",
    ]);
  });

  it("keeps quoted numbers as strings and number-like atoms that are not numbers as strings", () => {
    const t = parseSExpr('(x "1" 1 +2 .5 1. 5A02FE0E 1-2 ${REFERENCE} -)');
    expect(t).toEqual(["x", "1", 1, 2, 0.5, 1, "5A02FE0E", "1-2", "${REFERENCE}", "-"]);
  });

  it("decodes backslash escapes in quoted strings", () => {
    const t = parseSExpr('(descr "a \\"b\\" c\\\\d\\ne\\tf\\rg\\q" "")');
    expect(t).toEqual(["descr", 'a "b" c\\d\ne\tf\rgq', ""]);
  });

  it("skips a UTF-8 BOM, passes non-ASCII through and keeps empty lists", () => {
    const t = parseSExpr('\uFEFF(descr "\u00B5C \u2126" () (()) \u00E9t\u00E9)');
    expect(t).toEqual(["descr", "\u00B5C \u2126", [], [[]], "\u00E9t\u00E9"]);
  });

  it("records 1-based line numbers per list, counting LF only (CRLF safe)", () => {
    const t = parseSExpr('(a\r\n  (b 1)\r\n  (c "x\ny")\r\n  (d))');
    expect(lineOf(t)).toBe(1);
    expect(lineOf(find(t, "b")!)).toBe(2);
    expect(lineOf(find(t, "c")!)).toBe(3);
    expect(lineOf(find(t, "d")!)).toBe(5);
    expect(lineOf(["hand", "made"])).toBe(1);
  });

  it("throws KicadParseError with the line of the problem", () => {
    const unclosed = parseError('(footprint "x"\n  (pad "1" smd rect (at 0 0) (size 1 1)\n');
    expect(unclosed.message).toMatch(/unbalanced '\('/);
    expect(unclosed.line).toBe(2);
    expect(parseError("(a)\n)").line).toBe(2);
    expect(parseError("(a)\n)").message).toMatch(/unbalanced '\)'/);
    expect(parseError('(a\n "abc\n').line).toBe(2);
    expect(parseError('(a\n "abc\n').message).toMatch(/unterminated string/);
    expect(parseError("(a) (b)").message).toMatch(/after the top-level list/);
    expect(parseError('(a) "s"').message).toMatch(/after the top-level list/);
    expect(parseError("(a) b").message).toMatch(/after the top-level list/);
    expect(parseError("abc (a)").message).toMatch(/outside of any list/);
    expect(parseError("  \n ").message).toMatch(/empty document/);
    expect(parseError("x").message).toMatch(/^line 1: /);
  });
});

describe("helpers", () => {
  const t = parseSExpr('(fp (layer "F.Cu") (pad 1) (pad "2") (at 1.5 x) ("q" 1))') as SExpr[];

  it("head returns the head atom of a list", () => {
    expect(head(t)).toBe("fp");
    expect(head("fp")).toBeUndefined();
    expect(head([[1]])).toBeUndefined();
  });

  it("find returns the first direct child with that head", () => {
    expect(find(t, "pad")).toEqual(["pad", 1]);
    expect(find(t, "nope")).toBeUndefined();
    expect(find(t, "q")).toEqual(["q", 1]);
  });

  it("findAll returns every direct child with that head", () => {
    expect(findAll(t, "pad")).toEqual([
      ["pad", 1],
      ["pad", "2"],
    ]);
    expect(findAll(t, "nope")).toEqual([]);
  });

  it("num reads numbers only", () => {
    const at = find(t, "at")!;
    expect(num(at, 1)).toBe(1.5);
    expect(num(at, 2)).toBeUndefined();
    expect(num(at, 9)).toBeUndefined();
    expect(num(undefined, 1)).toBeUndefined();
  });

  it("str reads strings and stringifies numbers", () => {
    expect(str(find(t, "layer"), 1)).toBe("F.Cu");
    expect(str(find(t, "pad"), 1)).toBe("1");
    expect(str(t, 1)).toBeUndefined();
    expect(str(undefined, 0)).toBeUndefined();
  });
});
