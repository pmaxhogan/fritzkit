# 2S 18650 battery pack (simulator)

Golden example for spec decision D8: a part that works in Fritzing's simulator. Two 18650
Li-ion cells in series in a side-by-side holder, with three flying leads: PACK- (black),
PACK+ (red) and BAL (white, the midpoint between the two cells).

Orientation: top view, about 75 x 40 mm. Cell 1 (top) has its plus end on the right, cell 2
(bottom) has its plus end on the left, and the holder strap on the right joins cell 1 plus to
cell 2 minus. So PACK- leaves the left edge at cell 1 minus, PACK+ the left edge at cell 2
plus, and BAL the right edge at the strap.

## Sources

- The spice block is modelled on Fritzing's own core part
  `fritzing-parts/core/4 x AAA Battery Mount.fzp` (installed with Fritzing 1.0.x), which has:

  ```
  <property name="voltage">4.8V</property>
  <property name="internal resistance">0.1&#937;</property>
  ...
  <spice>
      <line>V{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector0} DC {voltage}</line>
      <line>R{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector1} {internal resistance}</line>
  </spice>
  ```

  `{voltage}` and `{internal resistance}` are replaced by the property values of the same name
  (spaces allowed), `{instanceTitle}` by the part's title in the sketch and `{net connectorN}`
  by the net of that connector.

- Dimensions are typical for a 2 x 18650 side-by-side holder (an 18650 cell is 18 mm x 65 mm);
  nothing was measured from a specific product.

## The model

Connectors: connector0 = PACK-, connector1 = PACK+, connector2 = BAL. Two cells, each a
voltage source with its own series resistance, stacked PACK- -> cell 1 -> BAL -> cell 2 ->
PACK+:

```
V{instanceTitle}A {net connector2}_{instanceTitle}_aux1 {net connector0} DC {cell voltage}
R{instanceTitle}A {net connector2}_{instanceTitle}_aux1 {net connector2} {internal resistance}
V{instanceTitle}B {net connector1}_{instanceTitle}_aux2 {net connector2} DC {cell voltage}
R{instanceTitle}B {net connector1}_{instanceTitle}_aux2 {net connector1} {internal resistance}
```

Properties: `cell voltage` = `3.7V` and `internal resistance` = `0.05` (ohm, PER CELL, so
0.1 ohm for the pack) drive the model; `voltage` = `7.4V` is the nominal pack voltage shown
in the Inspector and is not used by the model (two sources of `{voltage}` would make each cell
7.4 V). The resistance is a plain number because the files must be ASCII (the core part uses
the ohm sign as `&#937;`); spice reads `0.05` as ohms.

## Test it in Fritzing's simulator

1. Install the part (`fritzkit install examples/2s-18650-pack-sim`, Fritzing closed), start
   Fritzing and open a new sketch.
2. Breadboard view: drag in the pack from My Parts. Open the SIMULATOR bin (or search) and
   add a resistor (set it to 100 ohm in the Inspector) and a multimeter.
3. Wire PACK+ to one end of the resistor and PACK- to the other. Set the multimeter to DC
   voltage and connect it across PACK+ and PACK-.
4. Start the simulator (the Simulate button). The pack must NOT be greyed out (parts with no
   spice model are greyed out). Expect about 7.4 V, minus 0.1 ohm x 74 mA = about 7.39 V.
5. Move the multimeter's plus probe to BAL: expect about 3.7 V between BAL and PACK-.

Not verified in Fritzing yet: this repository's tooling may not launch Fritzing, so steps 4
and 5 have not been run. The fzp passes Fritzing's part checker, and every token in the spice
lines resolves to a property or a connector (asserted in `test/examples.test.ts`). If the
pack is greyed out with BAL unconnected, connect BAL through a 1 Mohm resistor to PACK- and
report it.

## Nets

PACK-, PACK+ and BAL are three different nodes; no bus. Roles: PACK+ and BAL `power`, PACK-
`gnd`. Label `VCC` (the core battery parts use it too).
