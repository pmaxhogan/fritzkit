import { describe, expect, it } from "vitest";
import { renderBreadboardContent } from "../src/core/compile/breadboard.js";
import {
  ICON_MARGIN_MIL,
  ICON_SIZE_MIL,
  iconTransform,
  renderIcon,
} from "../src/core/compile/icon.js";
import { mmToMil } from "../src/core/units.js";
import { attrValues, build, FIXTURES, photoFixture } from "./breadboard-fixtures.js";

describe("iconTransform", () => {
  it("fits the longer side into the square minus the margins and centres", () => {
    const t = iconTransform(1000, 500);
    expect(t.scale).toBe(0.288);
    expect(t.tx).toBeCloseTo(16, 6);
    expect(t.ty).toBeCloseTo((320 - 144) / 2, 6);
    const tall = iconTransform(100, 400);
    expect(tall.scale).toBe(0.72);
    expect(tall.ty).toBeCloseTo(16, 6);
    expect(tall.tx).toBeCloseTo((320 - 72) / 2, 6);
  });

  it("never overflows the margin after rounding the scale", () => {
    for (const w of [333, 1889.764, 7874.016, 12345.6, 77]) {
      const t = iconTransform(w, w / 3);
      expect(w * t.scale).toBeLessThanOrEqual(ICON_SIZE_MIL - 2 * ICON_MARGIN_MIL + 1e-9);
      expect(t.tx).toBeGreaterThanOrEqual(ICON_MARGIN_MIL - 1e-9);
      expect(Number(t.scale.toFixed(3))).toBe(t.scale);
    }
  });
});

describe("renderIcon", () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`${name}: a 0.32 in square with one id-less icon group`, async () => {
      const { part, ctx } = build(input);
      const svg = renderIcon(part, ctx);
      expect(svg).toContain('width="0.32in" height="0.32in" viewBox="0 0 320 320"');
      expect(attrValues(svg, "id")).toEqual(["icon"]);
      expect(svg).not.toContain("xmlns:xlink");
      expect(svg).not.toContain("style=");
      expect(svg).not.toContain("tspan");
      for (const f of attrValues(svg, "font-family")) expect(f).toBe("Noto Sans");
      // the artwork is the breadboard content, id-less, inside one transformed group
      const body = renderBreadboardContent(part, ctx, { ids: false });
      for (const e of body) expect(svg).toContain(e);
      const t = iconTransform(mmToMil(part.frame.widthMm), mmToMil(part.frame.heightMm));
      expect(svg).toMatch(
        /<g id="icon">\n {2}<g transform="translate\([\d.]+ [\d.]+\) scale\([\d.]+\)">/,
      );
      expect(svg).toContain(`scale(${t.scale})`);
      expect(renderIcon(part, ctx)).toBe(svg);
      await expect(svg).toMatchFileSnapshot(`__snapshots__/icon-${name}.svg`);
    });
  }

  it("embeds the photo with xlink when present", async () => {
    const { part, ctx } = photoFixture();
    const svg = renderIcon(part, ctx);
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(svg).toContain("data:image/png;base64,");
    expect(attrValues(svg, "id")).toEqual(["icon"]);
    await expect(svg).toMatchFileSnapshot("__snapshots__/icon-photo.svg");
  });
});
