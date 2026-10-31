import { describe, expect, it } from "vitest";
import {
  applyPatch,
  jsonEqual,
  JsonPatchError,
  parsePointer,
  type PatchOp,
} from "../src/mcp/jsonpatch.js";

describe("parsePointer", () => {
  it("splits and unescapes RFC 6901 pointers", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/a/b~1c/~0d/~01")).toEqual(["a", "b/c", "~d", "~1"]);
    expect(parsePointer("/")).toEqual([""]);
    expect(() => parsePointer("a")).toThrow(/must start with/);
  });
});

describe("jsonEqual", () => {
  it("compares structurally, ignoring key order", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
  });
});

describe("applyPatch", () => {
  const doc = { title: "x", pins: [{ key: "A" }, { key: "B" }], props: { "a/b": 1 } };

  it("adds, removes, replaces and tests without mutating the input", () => {
    const ops: PatchOp[] = [
      { op: "test", path: "/title", value: "x" },
      { op: "replace", path: "/title", value: "y" },
      { op: "add", path: "/pins/-", value: { key: "C" } },
      { op: "add", path: "/pins/0", value: { key: "Z" } },
      { op: "remove", path: "/pins/1" },
      { op: "replace", path: "/pins/0/key", value: "Q" },
      { op: "add", path: "/props/new", value: 2 },
      { op: "remove", path: "/props/a~1b" },
    ];
    const out = applyPatch(doc, ops);
    expect(out).toEqual({
      title: "y",
      pins: [{ key: "Q" }, { key: "B" }, { key: "C" }],
      props: { new: 2 },
    });
    expect(doc.title).toBe("x");
    expect(doc.pins).toHaveLength(2);
    expect(Object.keys(out)).toEqual(["title", "pins", "props"]);
  });

  it("adds a __proto__ member as an own property, not a prototype", () => {
    const out = applyPatch({ a: 1 } as Record<string, unknown>, [
      { op: "add", path: "/__proto__", value: { polluted: true } },
    ]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out))).toEqual(
      JSON.parse('{"a":1,"__proto__":{"polluted":true}}'),
    );
  });

  it("replaces the whole document at the root pointer", () => {
    expect(applyPatch(doc, [{ op: "replace", path: "", value: { a: 1 } }])).toEqual({ a: 1 });
    expect(applyPatch(doc, [{ op: "test", path: "", value: doc }])).toEqual(doc);
  });

  it("throws JsonPatchError with the op index", () => {
    const bad = (ops: PatchOp[], re: RegExp) => {
      let err: unknown;
      try {
        applyPatch(doc, ops);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(JsonPatchError);
      expect((err as Error).message).toMatch(re);
    };
    bad([{ op: "test", path: "/title", value: "nope" }], /op 0: test failed/);
    bad([{ op: "remove", path: "" }], /whole document/);
    bad([{ op: "replace", path: "/missing", value: 1 }], /no member "missing" to replace/);
    bad([{ op: "remove", path: "/missing/x" }], /no member "missing"/);
    bad([{ op: "add", path: "/pins/9", value: 1 }], /out of range/);
    bad([{ op: "remove", path: "/pins/2" }], /out of range/);
    bad([{ op: "add", path: "/pins/01", value: 1 }], /bad array index/);
    bad([{ op: "remove", path: "/pins/x/key" }], /no array element "x"/);
    bad([{ op: "add", path: "/title/x", value: 1 }], /parent is not an object/);
    bad([{ op: "add", path: "/title/x/y", value: 1 }], /cannot descend/);
    bad([{ op: "test", path: "/nope", value: 1 }], /no member "nope"/);
    bad([{ op: "test", path: "/pins/5", value: 1 }], /out of range/);
    bad([{ op: "add", path: "title", value: 1 }], /op 0: .*must start with/);
    bad(
      [
        { op: "replace", path: "/title", value: "ok" },
        { op: "test", path: "/title", value: "x" },
      ],
      /op 1: test failed/,
    );
  });
});
