# Seeed Studio XIAO ESP32-C6

Golden example: a castellated MCU board with pads on both long edges and two battery pads
on the back. Build it with `fritzkit validate examples/xiao-esp32-c6 --checker` and
`fritzkit render examples/xiao-esp32-c6 --png`.

Orientation: top (component) view, USB-C at the TOP short edge, 17.8 mm wide x 21 mm tall.

## Sources

- Wiki (specs table "21 x 17.8mm", Pin Map table with every pin function):
  https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/
- Front and back pinout images (pin order, battery pad polarity, component positions):
  https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/img/XIAO_ESP32-C6_front_pinout.png
  and `.../XIAO_ESP32-C6_back_pinout.png`
- Seeed's official KiCad footprints (pad positions and sizes):
  https://files.seeedstudio.com/wiki/XIAO-KiCad-Library/New_XIAO_Series_Footprints.zip
  (`XIAO-ESP32-C6-DIP.kicad_mod`, `XIAO-ESP32-C6-SMD.kicad_mod`)
- Seeed's official KiCad symbols (pad numbers to net names):
  https://files.seeedstudio.com/wiki/XIAO-KiCad-Library/XIAO_Series_SCH_Symbols.zip
  (symbol `XIAO-ESP32-C6-SMD`)

## Measured (from Seeed's drawings and footprints)

| what                      | value                                                                        | source                                                                |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| outline                   | 17.8 x 21 mm                                                                 | wiki spec table; footprint courtyard `fp_rect 0,0 .. 17.8,-21`        |
| castellation hole centres | x = 1.28 and 16.52 mm (15.24 mm = 0.6 in)                                    | DIP footprint holes at +-7.62 mm on a 17.8 mm board                   |
| first pad / pitch         | y = 2.88 mm, 2.54 mm                                                         | SMD footprint pads 1 and 14 at y = -18.12 (y_part = y_kicad + 21)     |
| pin order                 | left D0..D6 top to bottom; right 5V, GND, 3V3, D10, D9, D8, D7 top to bottom | front pinout image; symbol pads 1-14                                  |
| BAT+ (VBAT) pad           | (7.11, 16.03) mm, 1.1 x 2.5 mm                                               | SMD footprint pad 23 at (7.1086, -4.9683), size 2.5 x 1.1 rotated 270 |
| BAT- pad                  | (9.65, 16.03) mm, 1.1 x 2.5 mm                                               | SMD footprint pad 24 at (9.6486, -4.9683)                             |
| USB-C overhang            | 1.5 mm above the top edge, x 4.4 .. 13.4                                     | SMD footprint silkscreen notch (y -21 .. -22.547)                     |

## Estimated (read off the front pinout image at about 38 px/mm)

USB-C depth (7.4 mm total), the RF shield can (x 3.0 .. 14.8, y 6.8 .. 17.2), the U.FL
connector and the ceramic antenna. These are drawing aids only; no connector depends on
them. Corner radius 1.5 mm is estimated.

## Nets

- BAT- and the side GND pad are one net, so they form the `GND` bus. Evidence: Seeed's KiCad
  symbol `XIAO-ESP32-C6-SMD` names pad 24 (the BAT- pad, left of the "BAT" mark on the back,
  right of it seen from the top) `GND`, the same name as the side pad 13. The wiki text itself
  does not say it.
- BAT+ is `VBAT` (symbol pad 23), the input of the SGM40567 charger; it is NOT the 5V pin
  ("When using battery power, no voltage will be present on the 5V pin").
- The back-side JTAG/boot pads (MTDO, MTDI, MTCK, MTMS, EN, BOOT, a second GND and 3V3) are
  not modelled; they are test pads, not wiring points.

## Modelling notes

- The two columns are `castellated` headers with `orientation: "vertical"`; the default
  vertical castellated pad (2.4 x 1.6 mm) is used.
- The two battery pads are a 1 x 2 `castellated` header at the exact 2.54 mm footprint pitch.
  That gives them a label ABOVE each pad; as free `pins` their labels point towards the board
  centre and collide in the 1.4 mm gap between the pads.
- Pin roles: D0-D2 `analog` (A0-A2), D4/D5 `i2c`, D6/D7 `uart`, D8-D10 `spi`, 5V/3V3/BAT+
  `power`, GND/BAT- `gnd`. Alternate functions are in each pin's description.
