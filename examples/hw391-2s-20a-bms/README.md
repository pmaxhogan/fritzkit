# HW-391 2S 20A balanced BMS (acceptance part)

Amazon listing: https://www.amazon.com/dp/B08NSTF8CT (AITRIP, HW-391 REV 1.2).

This spec was produced by a FRESH agent in one shot (2026-10-31, attempt 1) from the
listing alone, using only the installed fritzkit skill and CLI, and then measured
against a golden pad table that the agent never saw. Every pad landed within 0.75 mm
and the 48 x 20 mm outline was exact. The part then passed the full local acceptance
run (`npm run e2e`): Fritzing's `-svg` render measured 48.08 x 20.00 mm, and a desktop
automation run dragged it from My Parts, wired all five pads to a breadboard and saved
a sketch that parses with five wired connectors.

| pad  | one-shot (mm) | golden (mm) | delta |
| ---- | ------------- | ----------- | ----- |
| 0V   | 45.85, 2.60   | 45.3, 2.6   | 0.55  |
| 8.4V | 45.85, 17.40  | 45.3, 17.4  | 0.55  |
| 4.2V | 1.75, 10.10   | 1.6, 10.1   | 0.15  |
| P-   | 7.55, 7.60    | 8.0, 7.6    | 0.45  |
| P+   | 7.55, 12.60   | 8.0, 13.2   | 0.75  |

Nets: 0V (B-) and P- are different nets (the MOSFETs sit between them). The agent
bused 8.4V and P+ after seeing one copper pour on the back photo; confirm with a
meter before relying on it. The listing's product photos are Amazon's and are not
committed here; the agent downloads them itself.

## Notes for reuse

- Fetch the listing with `curl -sSL https://www.amazon.com/gp/aw/d/B08NSTF8CT` and pull the
  gallery with `grep -o '"hiRes":"[^"]*"'`; listings mix products, so confirm the HW-391
  silkscreen in the image before measuring.
- The plus/minus-in-circle pads are named `P+` / `P-` (conventional function names, ASCII
  only); the printed symbol is recorded in each description.
- The rectangular through-hole pads look like solid copper in the PCB preview; the drill is
  the empty centre of the SVG ring (see the skill, "Reading the PCB preview").
