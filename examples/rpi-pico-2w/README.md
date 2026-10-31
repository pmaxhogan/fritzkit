# Raspberry Pi Pico 2 W

Golden example: a DIP-style MCU board with two 1 x 20 rows of 0.1 in through-hole pins that
straddles a breadboard's centre channel, a 3-pin SWD header, four mounting holes, and a GND
bus that deliberately leaves AGND out.

Orientation: top view, micro-USB at the TOP short edge, antenna at the bottom, 21 x 51 mm.

## Sources

- Raspberry Pi Pico 2 W datasheet (RP-008304-DS), section 2 "Mechanical specification",
  Figure 3 (dimensions) and Figure 4 (pin numbering), section 2.1 (pin descriptions):
  https://datasheets.raspberrypi.com/picow/pico-2-w-datasheet.pdf
- Pin functions (GPx alternate functions) from the official Pico 2 W pinout.

## Measured (datasheet Figure 3)

| what           | value                                               | how                                                                             |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| outline        | 21 x 51 mm                                          | callouts 21 and 51                                                              |
| pin rows       | x = 1.61 and 19.39 mm, 17.78 mm (0.7 in) apart      | callouts 17.78 and 1.61                                                         |
| first pin      | y = 1.37 mm, pitch 2.54 mm                          | callout 48.26 for the 20-pin span, centred on 51: (51 - 48.26) / 2              |
| holes          | 1 mm (default male pad: 1.6 mm round, 1.0 mm drill) | callout "1 mm holes"                                                            |
| mounting holes | 2.1 mm at x = 4.8 / 16.2, y = 2.0 / 49.0 mm         | callouts 11.4 (centred), 2 (from the top and bottom edges), 2.1                 |
| debug header   | y = 31.2 mm; x = 11.084, 13.624, 16.164 mm          | callout 19.8 from the bottom edge; 7.3759 from the right edge to the middle pin |
| debug order    | SWCLK, GND, SWDIO left to right                     | Figure 4                                                                        |
| USB            | 8 mm wide, centred, 1.3 mm overhang                 | callouts 8 and 1.3 (typ)                                                        |

Estimated (scaled off Figure 3 at about 10.1 px/mm): the BOOTSEL button, the flash chip, the
RP2350 package outline (7 x 7 mm, matches QFN-60) and the CYW43439 shield. Drawing aids only.

Note: the debug header is MID-board on the Pico 2 W (and Pico W), not at the bottom edge like
the original Pico, because the antenna occupies the bottom edge. vanepp's part agrees.

## Nets

- `GND` bus: the seven header GND pins (3, 8, 13, 18, 23, 28, 38) and the debug GND.
- AGND (pin 33) is NOT on the bus: the datasheet calls it "the ground reference for
  GPIO26-29. There is a separate analogue ground plane running under these signals and
  terminating at this pin". Tie it to GND in your circuit if the ADC is not critical.
- 3V3(OUT), VSYS, VBUS, ADC_VREF are four different nets (a SMPS and a filter sit between
  them); no bus.

## Modelling notes

- Both rows are `male` headers (`orientation: "vertical"`) so the part seats in a breadboard;
  the right row is listed top to bottom, so connector20 is VBUS (pin 40) and connector39 is
  GP16 (pin 21). The physical pin number is in every description.
- The debug header is a 1 x 3 `female` header. Its SWDIO label is blank and printed as
  artwork below the pad instead, because a label above the pad collides with the right row's
  GP22 label (the header sits only 1.9 mm below GP22). The schematic therefore shows the SWDIO
  pin without text; its connector name (hover, Inspector) is still SWDIO.
- Roles: GPIO `io`, GP26-28 and ADC_VREF `analog`, VBUS/VSYS/3V3(OUT) `power`, 3V3_EN `enable`,
  RUN `reset`, GND/AGND `gnd`, SWCLK `clock`.

## Compared with the community part

The comparison and how it was made: [docs/examples.md](../../docs/examples.md#pico-2w-vs-the-community-part).

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
