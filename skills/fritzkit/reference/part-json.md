<!-- Copy of docs/part-json.md, shipped with the skill so it works when the skill folder is
     copied on its own. Edit docs/part-json.md and copy it here; keep the two identical
     except the relative links in "Worked examples". -->

# part.json reference

Every fritzkit part is one folder: `part.json` plus an optional `assets/` folder. This page
documents every field of `part.json`. The source of truth is the zod schema in
`src/core/schema/part.ts`; the published JSON Schema (`fritzkit schema`, or
`src/core/schema/part.schema.json`) is generated from it. If this page and the schema ever
disagree, the schema wins.

```
<workspace>/<slug>/part.json          the spec (you write this)
<workspace>/<slug>/assets/...         photos, datasheet crops (artwork.photo.src points here)
<workspace>/<slug>/build/...          render output (never read back)
<workspace>/<slug>/<moduleId>.fzpz    export output (never read back)
```

The workspace defaults to `~/fritzkit/parts`; override it with `--workspace <dir>` or the
`FRITZKIT_WORKSPACE` environment variable. Only `part.json` and `assets/` feed the
compiler.

## Units and the coordinate frame

- **Every length is in millimetres** (fields end in `Mm`). fritzkit converts to mils when it
  writes SVG; you never deal with inches, mils or pixels in the spec.
- **Origin = the top-left corner of the outline.** x grows to the RIGHT along `widthMm`,
  y grows DOWN along `heightMm`. This is the orientation of a top-down photo of the board on
  screen, so a pixel in an orthographic photo maps straight to mm:
  `xMm = (px - boardLeftPx) / pxPerMm`, `yMm = (py - boardTopPx) / pxPerMm`.
- **Positions are centres.** A pin's `xMm`/`yMm` is the centre of its pad; a header's
  `xMm`/`yMm` is the centre of its FIRST pin; a hole's `xMm`/`yMm` is its centre. Only
  `rect` silk items use their top-left corner.
- **Pad sizes are in the part frame and never rotated:** `pad.wMm` is the extent along x,
  `pad.hMm` the extent along y, whatever the header orientation.
- Pins, leads and overhanging parts may lie OUTSIDE the outline (negative coordinates or
  beyond the outline size). The compiler grows the drawing canvas to fit them.
- If the part has headers, the compiler shifts the whole drawing so the first header pin
  lands exactly on Fritzing's 0.1 in (100 mil) grid; that is what makes the part seat in a
  breadboard. You do nothing for this; just keep header pins at their true pitch.
- The drawing shows the TOP (component) side. A pad that exists only on the back is placed
  where it would be seen through the board from the top (same x/y as from the top).

## Top level

| field         | type                            | default       | notes                                                                                                                                  |
| ------------- | ------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`     | string                          | -             | optional; `fritzkit new` writes the published schema URL so editors validate as you type                                               |
| `slug`        | string, 3-60 chars              | **required**  | lowercase letters, digits and `-`, starting and ending with a letter or digit (`xiao-esp32-c6`). Names the folder and the moduleId     |
| `title`       | string, 1-120                   | **required**  | shown in Fritzing's Inspector and parts bin                                                                                            |
| `version`     | integer >= 1                    | `1`           | bump by hand when the part changes materially; shown in the variant as `v<version> <hash8>`                                            |
| `family`      | string, 1-60                    | the slug      | Fritzing swap group: parts in one family can be swapped in the Inspector. Leave unset unless several slugs should swap with each other |
| `label`       | string, 1-4                     | `"A"`         | reference designator prefix: `A` module/board, `U` IC or MCU board, `J` connector, `K` relay, `M` motor                                |
| `author`      | string, max 80                  | `"fritzkit"`  |                                                                                                                                        |
| `tags`        | string[] (each 1-30)            | `[]`          | search keywords for Fritzing's parts search                                                                                            |
| `description` | string, max 4000                | `""`          | plain text; say what the part is and which side and orientation the drawing shows                                                      |
| `sources`     | URL[]                           | `[]`          | listing, wiki and datasheet URLs (must be valid URLs); appended to the description in Fritzing                                         |
| `properties`  | object string -> string         | `{}`          | extra Inspector properties (`mpn`, `type`, `voltage`, `chip` ...). Keys and values must be non-empty. `family`/`variant` are automatic |
| `outline`     | [Outline](#outline)             | **required**  | board size and shape                                                                                                                   |
| `artwork`     | [Artwork](#artwork)             | `{}` (vector) | how the breadboard view looks                                                                                                          |
| `pins`        | [Pin](#pin)[]                   | `[]`          | free-standing pads or pins at arbitrary positions                                                                                      |
| `headers`     | [Header](#header)[]             | `[]`          | rows/grids of pins at a fixed pitch (0.1 in headers, castellated edges)                                                                |
| `leads`       | [Lead](#lead)[]                 | `[]`          | flying wire leads with a connector at the free end                                                                                     |
| `pinIds`      | object key -> integer >= 0      | `{}`          | **managed by fritzkit; never edit by hand.** See [pinIds](#pinids)                                                                     |
| `buses`       | [Bus](#bus)[]                   | `[]`          | connectors that are the same electrical node (e.g. several GND pads)                                                                   |
| `spice`       | [Spice](#spice)                 | -             | optional simulator model                                                                                                               |
| `schematic`   | [schematic options](#schematic) | `{}`          | schematic symbol layout                                                                                                                |
| `pcb`         | [pcb options](#pcb)             | `{}`          | PCB footprint options                                                                                                                  |

Unknown keys are rejected everywhere (every object is strict), so a typo such as
`"widthmm"` is an error instead of being silently ignored.

## Fields shared by pins, header pins and leads

| field         | type            | default      | notes                                                                                                                           |
| ------------- | --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `key`         | string          | **required** | stable identifier, unique across the whole part. Letters, digits, `_ . + -`; must not start with `.`, `+` or `-`. Never rename  |
| `name`        | string, 1-40    | **required** | the connector name Fritzing shows on hover and in the Inspector. Use the silkscreen text (`GND`, `D7`, `NO`), never `pin1`      |
| `label`       | string, max 16  | the name     | text drawn next to the pin (breadboard and schematic); `""` hides the breadboard label; the fzp connector name is always `name` |
| `description` | string, max 400 | the name     | function, voltage, alternate functions (`D4 / SDA`)                                                                             |
| `role`        | enum            | `"io"`       | `power`, `gnd`, `io`, `analog`, `pwm`, `i2c`, `spi`, `uart`, `usb`, `clock`, `reset`, `enable`, `nc`, `other`                   |

`role` decides where the pin goes on the schematic symbol (see [schematic](#schematic)) and
its label colour. Use `power` for every supply pin (VCC, 5V, 3V3, VBAT, VIN), `gnd` for every
ground, `nc` for pins that are not connected, `other` for things like relay contacts and
motor phases.

Symbol-only or non-Latin silkscreen (a plus in a circle, Chinese text): `name` is the
conventional ASCII function name (`P+`, `P-`, `VCC`); the printed symbol or the translation
goes in `description`. Names and labels are ASCII only.

## Pin

A pad or pin at an arbitrary position: solder pads, screw terminals, odd pin spacings, test
pads, anything not on a regular grid.

| field                               | type                               | default                                                | notes                                                               |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| key, name, label, description, role | see above                          |                                                        |                                                                     |
| `type`                              | `female` / `male` / `pad` / `wire` | `"female"`                                             | see below                                                           |
| `xMm`                               | number                             | **required**                                           | pad centre, part frame                                              |
| `yMm`                               | number                             | **required**                                           | pad centre, part frame                                              |
| `pad`                               | [PadGeometry](#padgeometry)        | `{ "shape": "rect", "wMm": 2, "hMm": 2, "holeMm": 1 }` | copper size and drill                                               |
| `snap`                              | boolean                            | -                                                      | UI hint only: snap to the 0.1 in grid when dragged in `fritzkit ui` |

Connector `type` (what Fritzing lets attach to it):

- `female` - a wire or a male pin attaches to it: through-hole solder pads, female header
  sockets, screw terminals. The default, and the right choice for most pads with a hole.
- `male` - it plugs into a breadboard or socket: header pins.
- `pad` - a surface pad with no hole: SMD pads, castellated edges, test pads.
- `wire` - reserved by Fritzing for its own wires; do not use it (leads are emitted as
  `male` automatically).

## PadGeometry

| field    | type                      | default      | notes                                                           |
| -------- | ------------------------- | ------------ | --------------------------------------------------------------- |
| `shape`  | `rect` / `round` / `oval` | `"rect"`     | copper shape                                                    |
| `wMm`    | number > 0                | **required** | copper extent along x                                           |
| `hMm`    | number > 0                | **required** | copper extent along y                                           |
| `holeMm` | number >= 0               | -            | drill diameter; absent or 0 = no hole (SMD, top copper only)    |
| `smd`    | boolean                   | -            | force SMD (no drill, top copper only) even when `holeMm` is set |

In the PCB view a pad with a hole becomes a through-hole pad on both copper layers. Fritzing
needs a minimum hole and annular ring, so very small holes are drawn slightly bigger.

The PCB SVG draws the pad as a ring: a `<circle fill="none">` whose stroke is the copper, so
`drill = 2 * (r - stroke-width / 2)` and `copper = 2 * (r + stroke-width / 2)` (mils). Oblong
and rectangular pads also get a solid copper rect under the ring, so a preview PNG can look
like a solid block; the drill is still the ring's empty centre.

## Header

A row or grid of pins at a fixed pitch, drawn in Fritzing's house style.

| field         | type                              | default        | notes                                                                                                    |
| ------------- | --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `key`         | string                            | **required**   | identifies the header (not a connector)                                                                  |
| `kind`        | `male` / `female` / `castellated` | `"male"`       | male pins, female sockets, or castellated (half-hole) SMD edge pads                                      |
| `pitchMm`     | number > 0                        | `2.54`         | centre-to-centre spacing, both directions                                                                |
| `rows`        | integer 1-8                       | `1`            |                                                                                                          |
| `cols`        | integer 1-64                      | **required**   |                                                                                                          |
| `xMm`, `yMm`  | number                            | **required**   | centre of the FIRST pin (row 0, col 0)                                                                   |
| `orientation` | `horizontal` / `vertical`         | `"horizontal"` | horizontal: cols run along +x, rows along +y. vertical: cols run along +y (down), rows along +x (right)  |
| `pins`        | (HeaderPin or `null`)[]           | **required**   | exactly `rows * cols` entries, row-major (row 0 col 0, row 0 col 1, ...). `null` leaves a position empty |
| `pad`         | [PadGeometry](#padgeometry)       | see below      | copper override                                                                                          |

A HeaderPin has only `key`, `name`, `label`, `description` and `role`. Its position comes
from the grid and its connector type from `kind` (male -> `male`, female -> `female`,
castellated -> `pad`).

Default copper: male/female = round 1.6 mm pad with a 1.0 mm hole (through-hole);
castellated = rect 1.6 x 2.4 mm SMD (`wMm` along x, `hMm` along y). The castellated default
suits a HORIZONTAL row along the top or bottom edge. For a VERTICAL column along the left or
right edge set `"pad": { "shape": "rect", "wMm": 2.4, "hMm": 1.6, "smd": true }` so the long
side points into the board.

Examples: a 1x7 row with pin 1 at the left is
`{ "key": "j1", "cols": 7, "xMm": <x of pin 1>, "yMm": <y>, "pins": [7 entries] }`; a 2x20
header is `{ "rows": 2, "cols": 20, ... }` with 40 entries (all of row 0, then all of row 1).
Two rows that are NOT one pitch apart (the two sides of a DIP-style module) are two separate
headers.

## Lead

A flying wire (motor phases, battery leads, a servo cable). Drawn as a bendable leg; the
connector is the free end, which plugs into a breadboard like a male pin.

| field                               | type                             | default      | notes                                                         |
| ----------------------------------- | -------------------------------- | ------------ | ------------------------------------------------------------- |
| key, name, label, description, role | see above                        |              |                                                               |
| `fromXMm`, `fromYMm`                | number                           | **required** | where the wire leaves the board (usually on the outline edge) |
| `direction`                         | `left` / `right` / `up` / `down` | `"left"`     | which way the wire runs from that point                       |
| `lengthMm`                          | number > 0                       | `40`         | drawn length; the free end is `lengthMm` away in `direction`  |
| `color`                             | `#RRGGBB`                        | `"#000000"`  | insulation colour                                             |
| `gaugeMm`                           | number > 0                       | `1.6`        | wire outer diameter, for drawing                              |

Leads have no `type` or `pad` field. In the PCB view a lead becomes a through-hole pad
(unless `pcb.mode` is `smd`).

## Outline

| field            | type                          | default      | notes                                                                          |
| ---------------- | ----------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `widthMm`        | number > 0                    | **required** | extent along x. Convention: put the LONG edge on x                             |
| `heightMm`       | number > 0                    | **required** | extent along y                                                                 |
| `shape`          | `rect` / `rounded` / `custom` | `"rounded"`  |                                                                                |
| `cornerRadiusMm` | number >= 0                   | `1`          | used by `rounded`                                                              |
| `pathMm`         | string                        | -            | for `custom`: an SVG path in mm, part frame, e.g. `"M0 0 H30 V10 L25 15 H0 Z"` |
| `holes`          | `{ xMm, yMm, dMm }`[]         | `[]`         | mounting holes (centre, diameter); drawn in breadboard and PCB, not connectors |

## Artwork

How the breadboard view is drawn. The schematic, PCB and icon views are always generated
from the pins and the outline.

| field        | type                    | default     | notes                                                                                |
| ------------ | ----------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `style`      | `vector` / `photo`      | `"vector"`  | vector = Fritzing house style; photo = embedded raster with vector pads on top       |
| `boardColor` | `#RRGGBB`               | `"#1B7F3B"` | PCB colour (green). Black `#1A1A1A`, blue `#1B4F9C`, red `#B0242A`, purple `#5B2A86` |
| `silkColor`  | `#RRGGBB`               | `"#FFFFFF"` | silkscreen colour                                                                    |
| `silkscreen` | [SilkItem](#silkitem)[] | `[]`        | text and lines printed on the board                                                  |
| `components` | [SilkItem](#silkitem)[] | `[]`        | large components drawn as shapes (USB socket, relay can, chip, heatsink)             |
| `photo`      | [Photo](#photo)         | -           | required when `style` is `photo`                                                     |

Draw only the components that help a user recognise the board and find pin 1 (the USB
connector, a relay can, a big chip). Do not draw every resistor. fritzkit labels every pin
already, so do not repeat pin names in `silkscreen`. Component shapes are drawn on top of
silkscreen text (pads are drawn on top of both), so keep text off component shapes or it is
hidden. Silkscreen and components are drawn under header bodies, pads and pin labels, so
put text where pads are not.

### SilkItem

A union on `kind`. All positions in mm, part frame.

| kind     | fields (default)                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text`   | `text` (1-80, required), `xMm`, `yMm`, `sizeMm` (`1.2`), `color` (`#FFFFFF`), `anchor` `start`/`middle`/`end` (`middle`), `rotate` degrees (`0`) |
| `rect`   | `xMm`, `yMm` (TOP-LEFT corner), `wMm`, `hMm`, `color` (`#222222`), `rxMm` corner radius (`0`), `note` (not rendered)                             |
| `circle` | `xMm`, `yMm` (centre), `dMm` diameter, `color` (`#222222`), `note`                                                                               |
| `line`   | `x1Mm`, `y1Mm`, `x2Mm`, `y2Mm`, `widthMm` (`0.2`), `color` (`#FFFFFF`)                                                                           |

### Photo

| field              | type                       | default      | notes                                                                           |
| ------------------ | -------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `src`              | string                     | **required** | path relative to the part folder, e.g. `"assets/top.jpg"`                       |
| `crop`             | `[x, y, w, h]` (pixels)    | -            | crop rectangle in source pixels, applied BEFORE rotation                        |
| `rotate`           | `0` / `90` / `180` / `270` | `0`          | clockwise, applied after the crop, so the board ends up in the spec orientation |
| `removeBackground` | boolean                    | `true`       | key out a near-white listing background and trim to the board                   |
| `opacity`          | number 0-1                 | `1`          |                                                                                 |

After crop, rotate and trim the image is stretched over the outline rectangle, so the board
must fill the processed image edge to edge (that is what `removeBackground` trims to; with
`removeBackground: false`, crop exactly to the board). The image is downscaled to at most
1600 px wide. Pads are still drawn as vector shapes on top, at the spec positions.

## Bus

| field  | type                    | notes                                                 |
| ------ | ----------------------- | ----------------------------------------------------- |
| `id`   | string (`A-Za-z0-9_.-`) | unique, e.g. `GND`, `VBAT`                            |
| `pins` | pin key[] (>= 2)        | keys of pins, header pins or leads that share one net |

A bus tells Fritzing that the connectors are one electrical node, so a wire to one GND pad
counts as connected to every GND pad (ratsnest, routing checks). A connector can be in at
most one bus. Bus pins that are really the same copper: several `GND` pads, two `VIN` pads
tied together, a screw terminal paralleled with a solder pad. Pins that merely have similar
names (two `+` pads on different nets, `IN1` and `IN2`, `VCC` and `5V` with a regulator
between them) are NOT a bus unless the copper is visibly shared or the datasheet says so.

## pinIds

`pinIds` maps every pin key to its Fritzing connector number (`connector0`, `connector1`,
...). fritzkit fills it in: the first `validate`, `render` or `export` after you add a pin
gives the new key the next free number and writes it back to `part.json`. Numbers are never
reused, so when you delete a pin its number stays reserved and every other pin keeps its id.
That is what lets Fritzing swap a placed copy for a newer version without dropping wires.

fritzkit manages `pinIds`: do not hand-edit them for a part that has ever been
exported/installed (connector ids must stay stable). For a brand-new part you may delete
the `pinIds` object before the first export to close gaps. Never reuse a key for a
different physical pin;
rename a pin by changing `name`, not `key`. A new spec may omit `pinIds` or write `{}`. Gaps
in the numbering after a pin was removed produce a harmless `connector-numbering` warning
(only a warning).

## Spice

| field   | type     | notes                              |
| ------- | -------- | ---------------------------------- |
| `model` | string   | optional `.model` / `.subckt` text |
| `lines` | string[] | at least one netlist line          |

Tokens: `{instanceTitle}`, `{net connectorN}` (N from `pinIds`, so add spice AFTER the first
validate), and `{<property>}` for any entry in `properties`. A battery with internal
resistance, where connector0 is minus and connector1 is plus:

```json
{
  "properties": { "voltage": "3.7V", "internal resistance": "0.05" },
  "spice": {
    "lines": [
      "V{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector0} DC {voltage}",
      "R{instanceTitle} {net connector1}_{instanceTitle}_aux {net connector1} {internal resistance}"
    ]
  }
}
```

Parts without `spice` are greyed out in Fritzing's simulator, which is normal for modules
and MCU boards.

## schematic

| field    | type                                       | default     | notes                                      |
| -------- | ------------------------------------------ | ----------- | ------------------------------------------ |
| `layout` | `by-role`                                  | `"by-role"` | an auto-sized rectangle on the 0.1 in grid |
| `sides`  | `{ left?, right?, top?, bottom? }`, role[] | -           | override which side each role lands on     |

Behaviour of `by-role`: one box; pins are grouped by role onto sides, in spec order within
a role; every bused GND pin still gets its own pin. Default sides: power, usb, enable and
reset on the left, gnd at the bottom, everything else on the right. An empty `label` is
drawn as an empty pin label (it does not fall back to `name`). An explicit per-pin ordering
hint is not available yet.
Example override:
`"schematic": { "sides": { "left": ["power", "gnd"], "right": ["io", "i2c", "spi", "uart", "analog", "pwm"] } }`.

## pcb

| field               | type                   | default  | notes                                                               |
| ------------------- | ---------------------- | -------- | ------------------------------------------------------------------- |
| `mode`              | `auto` / `tht` / `smd` | `"auto"` | auto: per pad (a hole means through-hole); tht / smd force all pads |
| `silkscreenOutline` | boolean                | `true`   | draw the board outline on the PCB silkscreen                        |

## Identity (computed, not in the spec)

- `moduleId = fritzkit-<slug>-<hash8>`; `hash8` hashes part.json (minus `$schema`) and every
  file in `assets/`. Any change gives a new moduleId, because Fritzing refuses to import a
  moduleId it already has.
- `family = family ?? slug` (stable) and `variant = v<version> <hash8>` (unique per export).
  In Fritzing, select a placed part and pick another variant in the Inspector to swap it.

## Worked examples

Complete, valid specs live in the skill's
[examples.md](examples.md): the Seeed XIAO ESP32-C6 (headers and a
bus), an ESC with wire leads, a relay module, a KiCad import, and the pads-only HW-391
board measured from a listing photo. The full XIAO spec is also in
[SKILL.md](../SKILL.md) (a portrait board, USB at the top).
