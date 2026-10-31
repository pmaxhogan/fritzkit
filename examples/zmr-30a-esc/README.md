# ZMR 30A bidirectional brushless ESC

Golden example: a part with no pads at all, only flying wire leads. Each wire is a `leads`
entry; its connector is the free end, which plugs into a breadboard like a male pin.

Orientation: top view of the heat-shrunk body, 45 x 24 mm, battery leads and the servo
cable on the LEFT short edge, the three motor phases on the RIGHT short edge.

## Sources

- Retailer listings for the ZMR bidirectional ESC family (rating, 5 V BEC, forward/reverse,
  RC car / boat / underwater thruster use):
  https://rajivelectronics.com/product/zmr-40a-bidirectional-brushless-2-6s-ubec-3a-5v-esc-for-remote-control-car-pneumatic-underwater-propeller
  and https://makerbazar.in/products/bidirectional-brushless-esc-with-ubec
- No manufacturer datasheet or dimension drawing exists that I could find. One listing gave a
  "5 x 2.5 mm" size, which is obviously wrong and was ignored.

## Measured vs estimated

Nothing here is measured. Everything physical is the typical form factor of a 30 A ESC:

| item          | value used                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| body          | 45 x 24 x 8 mm, heat shrink colour #202020                                     |
| motor leads   | 3 x black, about 16 AWG (2.4 mm OD), 60 mm, right edge                         |
| battery leads | red / black, about 14 AWG (2.6 mm OD), 80 mm, left edge                        |
| servo cable   | orange / red / brown, 1 mm OD, 150 mm, 0.1 in apart at the free end, left edge |
| silkscreen    | "ZMR 30A"                                                                      |

Measure your ESC with calipers before using the PCB view for anything.

## Nets

- `GND` bus: BAT- (battery minus) and the servo cable's brown GND wire. An ESC's signal ground
  is its power ground: the BEC regulator and the MCU sit on the battery minus. Check with a
  meter (continuity between the black battery lead and the brown servo wire).
- BEC 5V is a regulator OUTPUT. It is NOT bused with BAT+ (a regulator sits between them) and
  must not be connected to another 5 V supply.
- The three motor phases are three separate outputs; no bus. Swap any two to reverse the
  default direction.
- SIG is the throttle input: 1-2 ms RC PWM; on a bidirectional ESC 1.5 ms is stop, shorter is
  reverse, longer is forward.

## Modelling notes

Roles: motor phases `io`, BAT+ `power`, BAT- `gnd`, SIG `io`, BEC 5V `power`, servo GND
`gnd`. Lead labels: the motor phases print as A, B, C and the BEC wire as 5V; the battery
leads keep their full names (BAT+/BAT-) because a bare + or - reads ambiguously in the
schematic. The breadboard SVG holds only the body and the start of each lead; Fritzing draws
the bendable legs at their full length.
