import { describe, expect, it } from "vitest";
import { parsePartSpec } from "../src/core/schema/part.js";
import { allocatePinIds, resolvePart, ResolveError } from "../src/core/resolve.js";
import { identityFor } from "../src/core/identity.js";

const base = {
  slug: "t-part",
  title: "T",
  outline: { widthMm: 48, heightMm: 20 },
  pins: [
    { key: "a", name: "A", xMm: 5, yMm: 10 },
    { key: "b", name: "B", xMm: 43, yMm: 10 },
  ],
};

describe("resolvePart", () => {
  it("allocates connector ids in spec order and never reuses them", () => {
    const s1 = parsePartSpec(base);
    const r1 = resolvePart(s1);
    expect(r1.pinIds).toEqual({ a: 0, b: 1 });
    // remove "a", add "c": b keeps 1, c gets 2
    const s2 = parsePartSpec({
      ...base,
      pinIds: r1.pinIds,
      pins: [base.pins[1], { key: "c", name: "C", xMm: 20, yMm: 10 }],
    });
    const r2 = resolvePart(s2);
    expect(r2.pinIds).toEqual({ a: 0, b: 1, c: 2 });
    expect(r2.connectors.map((c) => [c.id, c.key])).toEqual([
      [1, "b"],
      [2, "c"],
    ]);
    expect(r2.newPinKeys).toEqual(["c"]);
  });

  it("rejects duplicate keys and duplicate numbers", () => {
    expect(() =>
      allocatePinIds(parsePartSpec({ ...base, pins: [base.pins[0], base.pins[0]] })),
    ).toThrow(ResolveError);
    expect(() => allocatePinIds(parsePartSpec({ ...base, pinIds: { a: 0, b: 0 } }))).toThrow(
      /used twice/,
    );
  });

  it("puts the first header pin on a 100 mil multiple and grows the canvas for leads", () => {
    const s = parsePartSpec({
      ...base,
      pins: [],
      headers: [
        {
          key: "h",
          cols: 3,
          xMm: 3.3,
          yMm: 1.27,
          pins: [{ key: "d0", name: "D0" }, null, { key: "d2", name: "D2" }],
        },
      ],
      leads: [{ key: "w", name: "W", fromXMm: 0, fromYMm: 15, lengthMm: 20 }],
    });
    const r = resolvePart(s);
    const first = r.connectors.find((c) => c.source === "header")!;
    expect(((first.xMm + r.frame.offsetXMm) / 2.54) % 1).toBeCloseTo(0, 9);
    expect(((first.yMm + r.frame.offsetYMm) / 2.54) % 1).toBeCloseTo(0, 9);
    // Leads do not grow the canvas (the leg line runs past the viewBox, like core parts).
    expect(r.frame.offsetXMm).toBeLessThan(5);
    expect(r.connectors.map((c) => c.id)).toEqual([0, 1, 2]);
    const lead = r.connectors.find((c) => c.source === "lead")!;
    expect(lead.legId).toBe("connector2leg");
    expect(lead.xMm).toBe(-20);
  });

  it("resolves buses to connector ids and rejects overlaps", () => {
    const r = resolvePart(parsePartSpec({ ...base, buses: [{ id: "X", pins: ["a", "b"] }] }));
    expect(r.buses).toEqual([{ id: "X", connectorIds: [0, 1] }]);
    expect(() =>
      resolvePart(
        parsePartSpec({
          ...base,
          buses: [
            { id: "X", pins: ["a", "b"] },
            { id: "Y", pins: ["b", "a"] },
          ],
        }),
      ),
    ).toThrow(/two buses/);
    expect(() =>
      resolvePart(parsePartSpec({ ...base, buses: [{ id: "X", pins: ["a", "zz"] }] })),
    ).toThrow(/unknown pin key/);
  });

  it("marks SMD pads as copper1-only", () => {
    const r = resolvePart(
      parsePartSpec({
        ...base,
        pins: [{ key: "a", name: "A", xMm: 1, yMm: 1, pad: { wMm: 1, hMm: 2 } }],
      }),
    );
    expect(r.connectors[0]!.tht).toBe(false);
    expect(r.hasTht).toBe(false);
  });
});

describe("identityFor", () => {
  it("is deterministic and changes with content", () => {
    const s = parsePartSpec(base);
    const a = identityFor(s);
    expect(a).toEqual(identityFor(parsePartSpec(base)));
    expect(a.moduleId).toMatch(/^fritzkit-t-part-[0-9a-f]{8}$/);
    expect(a.family).toBe("t-part");
    expect(a.variant).toBe(`v1 ${a.hash8}`);
    const b = identityFor(parsePartSpec({ ...base, title: "T2" }));
    expect(b.hash8).not.toBe(a.hash8);
    const c = identityFor(s, [{ name: "assets/x.png", data: new Uint8Array([1, 2, 3]) }]);
    expect(c.hash8).not.toBe(a.hash8);
  });
});
