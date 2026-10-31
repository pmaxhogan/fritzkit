import { describe, expect, it } from "vitest";
import { FRITZING_VERSION, mmToIn, mmToMil } from "../src/core/index.js";

describe("units", () => {
  it("converts mm to mil", () => {
    expect(mmToMil(25.4)).toBeCloseTo(1000, 9);
    expect(mmToMil(2.54)).toBeCloseTo(100, 9);
  });
  it("converts mm to inches", () => {
    expect(mmToIn(48)).toBeCloseTo(1.8897637795, 9);
  });
  it("targets Fritzing 1.0.7", () => {
    expect(FRITZING_VERSION).toBe("1.0.7");
  });
});
