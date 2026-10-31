# Golden example parts

`examples/` holds complete parts written by the documented workflow
([agent-workflow.md](agent-workflow.md)): sources read, outline and pad positions taken
from a datasheet drawing or the manufacturer's footprint where one exists, then validated,
rendered and checked. Each folder is `part.json` plus a `README.md` that lists the sources,
what was measured and what was estimated, and why each bus exists (or does not).

| folder                                                       | what it shows                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [xiao-esp32-c6](../examples/xiao-esp32-c6/README.md)         | castellated edge pads on both long edges, back-side battery pads, a GND bus backed by the vendor's KiCad symbol                  |
| [zmr-30a-esc](../examples/zmr-30a-esc/README.md)             | a part made only of flying wire leads, a common-ground bus between the battery and servo grounds                                 |
| [rpi-pico-2w](../examples/rpi-pico-2w/README.md)             | two 1 x 20 male rows 0.7 in apart that straddle a breadboard, a debug header, mounting holes, a GND bus that keeps AGND separate |
| [2s-18650-pack-sim](../examples/2s-18650-pack-sim/README.md) | a spice model so the part works in Fritzing's simulator (two cells in series with a midpoint tap)                                |

Try one:

```
node --import tsx src/cli/main.ts validate examples/rpi-pico-2w --checker
node --import tsx src/cli/main.ts render examples/rpi-pico-2w --png --out <dir>
```

(`validate --checker` writes the `.fzpz` it checks into `examples/<slug>/build/`.)

## How they stay green

- `test/examples.test.ts` compiles each golden example with a fixed date, asserts zero
  structural issues and committed `pinIds` for every pin, snapshots the fzp and the four SVGs
  (`test/__snapshots__/examples-<slug>.fzp` and `examples-<slug>-<view>.svg`), runs Fritzing's
  part checker on each when uv is installed, and pins the Pico 2 W facts below and the battery
  pack's spice tokens.
- `node --import tsx scripts/check-examples.ts` validates every part folder under
  `examples/` and runs the checker on each; it exits non-zero on any error, on a missing
  checker (`--no-checker` skips it) or on pins without a committed connector id. It never
  rewrites `part.json`.

A change to the compiler that alters an example shows up as a snapshot diff: open the SVG
under `test/__snapshots__/`, check it, then update with `npx vitest run test/examples.test.ts -u`.

## Pico 2W vs the community part

The reference is vanepp's community "Raspberry Pi Pico 2W" part (moduleId `rpi_pico2W_1`,
Fritzing 1.0.4, Feb 2025), the usual download for this board. Method: a copy of the `.fzpz`
was unzipped and read (fzp connectors and buses, SVG root attributes), and both parts were run
through the Fritzing 1.0.7 part checker vendored in `tools/fzp-checker`
(`uv run --project tools/fzp-checker check-fzp <file.fzpz>`). Our numbers come from
`examples/rpi-pico-2w` compiled by fritzkit; `test/examples.test.ts` asserts the connector
count, the bus, the 0.7 in row spacing on the 0.1 in grid, and that the drawn board width is
within 1 % of vanepp's root width.

| aspect                        | fritzkit `examples/rpi-pico-2w`                                                                                                                               | vanepp `rpi_pico2W_1` (community)                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connectors                    | 43: 40 header pins (`male`) + 3 SWD (`female`)                                                                                                                | 43: connector0-39 `male` + connector40-42 `female`                                                                                                                                                                                                                                                              |
| connector names               | pinout names: `GP0`..`GP28`, `GND`, `AGND`, `RUN`, `3V3(OUT)`, `3V3_EN`, `VSYS`, `VBUS`, `ADC_VREF`, `SWCLK`, `SWDIO`; physical pin number in the description | `pin 1`..`pin 43`; GPIO names only in the description and the schematic text                                                                                                                                                                                                                                    |
| connector ids                 | connector0-19 = pins 1-20 (left, top down), connector20-39 = pins 40..21 (right, top down), connector40-42 = SWCLK, GND, SWDIO                                | connectorN = pin N+1; 40-42 = SWDIO, GND, SWCLK                                                                                                                                                                                                                                                                 |
| GND bus                       | `GND`, 8 members: the 7 header GNDs (pins 3, 8, 13, 18, 23, 28, 38) + debug GND                                                                               | `GND`, 9 members: connector2, 7, 12, 17, 22, 27, 32, 37, 41, i.e. the same 8 plus AGND (pin 33)                                                                                                                                                                                                                 |
| AGND                          | separate net (datasheet: "a separate analogue ground plane running under these signals and terminating at this pin")                                          | bused with GND                                                                                                                                                                                                                                                                                                  |
| breadboard root               | 0.864 x 2.054 in (viewBox 864 x 2054, 1 unit = 1 mil)                                                                                                         | 0.82678 x 2.07914 in (viewBox 826.78 x 2079.14)                                                                                                                                                                                                                                                                 |
| board width drawn             | 826.77 mil (21 mm outline + stroke), within 0.01 % of vanepp's root width                                                                                     | 826.78 mil (the root)                                                                                                                                                                                                                                                                                           |
| why the roots differ          | the first pin is shifted onto a 100 mil multiple, which pads the canvas by 37 mil on the left; the canvas ends at the USB overhang (1.3 mm per the datasheet) | pins sit at x = 63.4 mil (not on a 100 mil multiple); about 1.8 mm more height than the 51 mm board                                                                                                                                                                                                             |
| breadboard pin pitch          | exactly 100 mil; rows exactly 700 mil apart                                                                                                                   | 100.06 / 100.00 mil                                                                                                                                                                                                                                                                                             |
| schematic                     | 1.2 x 3.2 in, pins and body on the 0.1 in grid, pitch 100 mil, power left, GND/AGND bottom, GPIO right in GP order                                            | 1.0097 x 2.31 in, pin pitch 100.5 mil, first pin at y = 206.05 (off the 0.1 in grid)                                                                                                                                                                                                                            |
| debug header                  | mid-board at y = 31.2 mm (datasheet Figure 3: 19.8 mm above the bottom edge), x = 11.08 / 13.62 / 16.16 mm                                                    | mid-board (cy 1309 of 2079 mil), same order                                                                                                                                                                                                                                                                     |
| mounting holes                | 4 x 2.1 mm at (4.8, 2.0), (16.2, 2.0), (4.8, 49.0), (16.2, 49.0) mm                                                                                           | 4 non-connector circles in copper (`nonconn1..4`)                                                                                                                                                                                                                                                               |
| fonts                         | Noto Sans                                                                                                                                                     | `DroidSans` / `'Droid Sans'`                                                                                                                                                                                                                                                                                    |
| Fritzing part checker (1.0.7) | clean: 0 errors, 0 warnings                                                                                                                                   | 250 errors + 1 warning: fzp 3 errors (empty `part number` and `layer` properties, iconView layer `icon` not in the SVG) + 1 warning (date `Mon Feb 17 2025` not YYYY-MM-DD); breadboard 238 (204 `gorn` attributes, 34 `DroidSans` fonts); pcb 9 (8 copper circles filled `#ffffff`, 1 `gorn`); schematic clean |

Both parts agree on the physical layout (43 connectors, 0.7 in row spacing, a mid-board SWD
header, the GND pins). The differences that matter to a user:

- Names: with fritzkit a wire's ends read `GP15` or `VSYS` on hover and in the Inspector;
  with the community part they read `pin 20` / `pin 39`.
- AGND: the community part ties AGND into the GND bus, so Fritzing's ratsnest treats a wire
  to AGND as a ground connection. The datasheet describes a separate analogue ground plane
  that ends at that pin; fritzkit keeps it separate, which is right for ADC work and harmless
  otherwise (connect AGND to GND yourself).
- Checker: the community part fails Fritzing's own checker on format details (Illustrator
  `gorn` attributes, a non-allowed font name, white fills in copper, an icon layer that does
  not exist, empty properties). None of these stops it from loading in Fritzing today; they
  are what fritzkit rules out by construction.
- Geometry: the breadboard roots differ by 4.5 % in width only because fritzkit pads the
  canvas so the first pin sits on a 100 mil multiple; the board itself is drawn at the same
  21 mm. The breadboard pin pitch is exact in fritzkit (100.00 mil) and slightly irregular in
  the community part (100.06 / 100.00 mil); its schematic pins are 100.5 mil apart and off the
  0.1 in grid, ours are on it.

<!-- ratchet probe: this PR exists only to show the required coverage check; it is closed unmerged -->
