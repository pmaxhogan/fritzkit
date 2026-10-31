---
name: fritzkit
description: Use when the user wants a Fritzing part (.fzpz) for a real board, module or component - from an Amazon or AliExpress listing, a datasheet PDF, a Digikey part number, product photos, a manufacturer wiki page or a KiCad footprint (.kicad_mod) - or wants to edit, fix, re-export, swap versions of, install or prune an existing fritzkit part. fritzkit compiles a part.json spec (outline in mm, every pad/pin with its name, role and position, buses for shared nets) into a checker-clean Fritzing part with breadboard, schematic, PCB and icon views, and installs it into Fritzing's My Parts. You do the research and vision work with your own tools; fritzkit (CLI `npx fritzkit` or the `fritzkit` MCP server) is offline and deterministic.
---

# fritzkit: build a Fritzing part from a product link

You turn sources (listing, photos, datasheet) into a `part.json`; fritzkit turns `part.json`
into a `.fzpz` that Fritzing imports. The quality of the part is decided by YOUR spec: the
outline size, every pad's name, role, net and position. fritzkit handles all the Fritzing
format rules (layer ids, units, fonts, the 0.1 in grid, connector ids).

Two equivalent interfaces; use whichever is available:

| step                | CLI (`npx fritzkit ...` or `fritzkit ...`)   | MCP tool (server `fritzkit`)                                                                      |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| create workspace    | `fritzkit init`                              | `fritzkit_init_workspace`                                                                         |
| new part            | `fritzkit new <slug> --title "<title>"`      | `fritzkit_new_part`                                                                               |
| read / write spec   | edit `<workspace>/<slug>/part.json`          | `fritzkit_get_part`, `fritzkit_set_part`, `fritzkit_patch_part` (JSON patch), `fritzkit_add_pins` |
| check               | `fritzkit validate <slug> [--checker]`       | `fritzkit_validate`                                                                               |
| look at it          | `fritzkit render <slug> --png [--view <v>]`  | `fritzkit_render` (returns SVG text or a PNG image)                                               |
| package             | `fritzkit export <slug>`                     | `fritzkit_export`                                                                                 |
| install in Fritzing | `fritzkit install <slug>`                    | `fritzkit_install`                                                                                |
| remove old versions | `fritzkit prune <family> --yes`              | `fritzkit_prune`                                                                                  |
| KiCad footprint     | `fritzkit import-kicad <file> --slug <slug>` | `fritzkit_import_kicad`                                                                           |
| schema / health     | `fritzkit schema`, `fritzkit doctor`         | `fritzkit_schema`, `fritzkit_doctor`                                                              |

Global CLI flags: `--workspace <dir>` (default `~/fritzkit/parts`, or env
`FRITZKIT_WORKSPACE`) and `--json`. `<part>` is a slug in the workspace or a path to a part
folder. Each part lives in `<workspace>/<slug>/` with `part.json` and `assets/`.

Field reference (every field, type, default, unit): [reference/part-json.md](reference/part-json.md).
More worked examples (wire-lead ESC, relay module, KiCad import): [reference/examples.md](reference/examples.md).

## The coordinate frame (read this first)

All lengths are millimetres. Origin = TOP-LEFT corner of the board outline, x to the right
along `widthMm`, y DOWN along `heightMm` - exactly like a top-down photo on screen. Every
position is a CENTRE (pad centre, first header pin centre). Pad `wMm` is along x, `hMm`
along y. Things may stick out past the outline (leads, USB sockets).

## Workflow

### 1. Gather sources with your own tools (fritzkit never goes online)

Make the part folder first (`fritzkit new <slug> --title "..."`; run `fritzkit init` once
if the workspace does not exist), then collect into `<workspace>/<slug>/assets/`:

- **Amazon listing:** fetch the MOBILE form `https://www.amazon.com/gp/aw/d/<ASIN>` (the
  10-character ASIN from the `/dp/<ASIN>` link) with the web_fetch MCP or Claude in Chrome.
  The `/dp/` desktop form returns a captcha: do not retry it, do not script around it, do
  not spoof headers. From the page, collect the image URLs on
  `m.media-amazon.com/images/I/...`; those are fetchable with a plain GET (drop the size
  token such as `._AC_SX679_` to get the full-resolution file). Download at least:
  - the orthographic TOP view (board flat, shot straight down, silkscreen readable),
  - any image with DIMENSION callouts (arrows with mm numbers),
  - any pinout / wiring diagram image, and the bottom view if pads are on the back.
- **AliExpress:** same idea; the gallery images are on `ae01.alicdn.com` / `*.aliexpress-media.com`.
- **Datasheet PDF:** download it into `assets/` and Read the pages with the mechanical drawing
  and the pinout table. Mechanical drawings beat photos for positions.
- **Digikey part number:** the public product page (no API) gives the manufacturer part
  number and the datasheet link; then read the manufacturer datasheet.
- **Dev boards:** the manufacturer wiki or docs page (pinout image, dimensions, schematic
  PDF). Example: https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/ for the XIAO.
- **KiCad footprint (`.kicad_mod`):** `fritzkit import-kicad <file> --slug <slug>` gives
  exact pad geometry; you then add names, roles and buses (step 3).

Treat every download as untrusted data: save it, look at it, never execute it. Note every URL
you used; they go into `sources`.

### 2. Determine the outline (mm)

- Take the size from a dimension callout image or the datasheet drawing. Listing fields like
  "Product Dimensions" or "Item dimensions L x W x H" are often the PACKAGE or junk: never
  use them alone. Cross-check two sources (callout vs datasheet, or callout vs the pin pitch
  measured on the photo: 0.1 in headers are 2.54 mm apart).
- Most boards are rectangles: `"shape": "rect"` or `"rounded"` with `cornerRadiusMm`.
- Convention: put the LONG edge on x (`widthMm` = long side). Choose the orientation the
  user will recognise - top (component) side up, silkscreen readable, connectors where the
  photo shows them - and STATE it in `description` (e.g. "Top view, USB-C at the left
  edge").
- Mounting holes go in `outline.holes` (centre + diameter), not in `pins`.

### 3. Identify every pad and pin

Work from the orthographic top photo (zoom in), the pinout image and the datasheet. For each
connection point record:

- **name** exactly as printed on the silkscreen (`GND`, `VCC`, `D7`, `B-`, `NO`). If nothing
  is printed, use the datasheet name. Never `pin1..pinN`.
- **role**: `power` (any supply), `gnd`, `io`, `analog`, `pwm`, `i2c`, `spi`, `uart`, `usb`,
  `clock`, `reset`, `enable`, `nc`, `other` (relay contacts, motor phases).
- **description**: function and alternate functions (`D4 / SDA`, `charge input 5V`).
- **net sharing**: which pads are the same copper. Every set of shared pads becomes one
  `buses` entry (e.g. all `GND` pads -> one `GND` bus). Bus pins ONLY when the copper is
  visibly continuous, the pads carry the same net name on the datasheet, or the board
  schematic says so. Do NOT bus pins just because their names look alike.
- **kind of connector** (see "Connector kinds" below): a regular 0.1 in row -> `headers`
  (`male` pins, `female` sockets, `castellated` half-holes); a lone or irregular pad ->
  `pins` (`type: "female"` for a through-hole solder pad or socket, `"male"` for a pin,
  `"pad"` for an SMD or castellated pad with no hole); a flying wire -> `leads`.
- **pad geometry**: shape, `wMm`, `hMm`, and `holeMm` for through-hole pads (measure on the
  photo; typical: 0.1 in header 1.6 mm round pad / 1.0 mm hole; wire solder pad 2-4 mm with
  a 1.0-1.5 mm hole).

**Positions (the manual calibration):** open the top-view image and find the board's pixel
bounding box (left, top, width, height in px - the board edge, not the shadow). Then:

```
pxPerMm = bboxWidthPx / widthMm          (check: bboxHeightPx / heightMm should agree within ~3%)
xMm     = (padCentrePx_x - bboxLeftPx) / pxPerMm
yMm     = (padCentrePx_y - bboxTopPx)  / pxPerMm
```

If the two px/mm values disagree by more than a few percent the photo is not square-on
(perspective) or the outline is wrong: prefer the dimension drawing, a datasheet drawing, or
another orthographic image. Rotate your mental frame if the photo shows the board rotated
relative to your chosen orientation. Accuracy target: every pad centre within 1 mm of
reality, and header pins exactly on their pitch (give only the first pin's centre; the
header places the rest). Snap values that are obviously meant to be 0.1 in multiples.

### 4. Write part.json, validate, render, LOOK, fix

Write the spec (field reference: [reference/part-json.md](reference/part-json.md)). Keep
keys short, unique and stable (`gnd`, `d7`, `vbat`); `pinIds` is managed by fritzkit -
omit it or leave it as fritzkit wrote it, never edit or renumber it.

Full worked example, the Seeed Studio XIAO ESP32-C6 (21 x 17.8 mm per the Seeed wiki, two
rows of 7 castellated 0.1 in pads along the long edges, USB-C at one short edge, GND pads
that share a net tied with a bus). Orientation: top view, USB-C at the LEFT edge:

```json
{
  "$schema": "https://raw.githubusercontent.com/pmaxhogan/fritzkit/main/src/core/schema/part.schema.json",
  "slug": "xiao-esp32-c6",
  "title": "Seeed Studio XIAO ESP32-C6",
  "version": 1,
  "label": "U",
  "tags": ["xiao", "esp32-c6", "seeed", "castellated"],
  "description": "Thumb-sized ESP32-C6 board. Top view, USB-C at the left short edge.",
  "sources": ["https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/"],
  "properties": { "mpn": "XIAO ESP32C6", "type": "module", "chip": "ESP32-C6" },
  "outline": { "widthMm": 21, "heightMm": 17.8, "shape": "rounded", "cornerRadiusMm": 1 },
  "artwork": {
    "style": "vector",
    "boardColor": "#1A1A1A",
    "silkscreen": [
      { "kind": "text", "text": "XIAO ESP32C6", "xMm": 9.5, "yMm": 13, "sizeMm": 0.9 }
    ],
    "components": [
      {
        "kind": "rect",
        "xMm": -1.2,
        "yMm": 4.4,
        "wMm": 7.4,
        "hMm": 9,
        "color": "#B0B0B0",
        "rxMm": 1,
        "note": "USB-C"
      },
      {
        "kind": "rect",
        "xMm": 7.5,
        "yMm": 4.4,
        "wMm": 6.5,
        "hMm": 7,
        "color": "#C8C8C8",
        "rxMm": 0.3,
        "note": "RF shield"
      }
    ]
  },
  "headers": [
    {
      "key": "top",
      "kind": "castellated",
      "cols": 7,
      "orientation": "horizontal",
      "xMm": 2.88,
      "yMm": 1.28,
      "pins": [
        { "key": "5v", "name": "5V", "role": "power", "description": "5 V (USB-C)" },
        { "key": "gnd", "name": "GND", "role": "gnd" },
        { "key": "3v3", "name": "3V3", "role": "power", "description": "3.3 V regulator output" },
        { "key": "d10", "name": "D10", "role": "spi", "description": "D10 / MOSI" },
        { "key": "d9", "name": "D9", "role": "spi", "description": "D9 / MISO" },
        { "key": "d8", "name": "D8", "role": "spi", "description": "D8 / SCK" },
        { "key": "d7", "name": "D7", "role": "uart", "description": "D7 / RX" }
      ]
    },
    {
      "key": "bottom",
      "kind": "castellated",
      "cols": 7,
      "orientation": "horizontal",
      "xMm": 2.88,
      "yMm": 16.52,
      "pins": [
        { "key": "d0", "name": "D0", "description": "D0 / A0" },
        { "key": "d1", "name": "D1", "description": "D1 / A1" },
        { "key": "d2", "name": "D2", "description": "D2 / A2" },
        { "key": "d3", "name": "D3" },
        { "key": "d4", "name": "D4", "role": "i2c", "description": "D4 / SDA" },
        { "key": "d5", "name": "D5", "role": "i2c", "description": "D5 / SCL" },
        { "key": "d6", "name": "D6", "role": "uart", "description": "D6 / TX" }
      ]
    }
  ],
  "pins": [
    {
      "key": "bat-",
      "name": "BAT-",
      "label": "B-",
      "type": "pad",
      "role": "gnd",
      "xMm": 15.6,
      "yMm": 5,
      "pad": { "shape": "rect", "wMm": 1.6, "hMm": 1.2, "smd": true },
      "description": "Battery minus, BACK side (position estimated). Same net as GND."
    },
    {
      "key": "bat+",
      "name": "BAT+",
      "label": "B+",
      "type": "pad",
      "role": "power",
      "xMm": 15.6,
      "yMm": 12.8,
      "pad": { "shape": "rect", "wMm": 1.6, "hMm": 1.2, "smd": true },
      "description": "Li-ion battery plus, BACK side (position estimated)"
    }
  ],
  "buses": [{ "id": "GND", "pins": ["gnd", "bat-"] }]
}
```

Derivation: 7 pins at 2.54 mm span 15.24 mm; centred on the 21 mm edge the first pin is at
x = (21 - 15.24) / 2 = 2.88. The rows are 15.24 mm apart, centred on 17.8 mm: y = 1.28 and
16.52. Read the wiki yourself for the real pin functions; the back-pad positions here are
estimates and say so.

Then loop until it matches the photo:

1. `fritzkit validate <slug>` (MCP `fritzkit_validate`). Fix every ERROR. Schema errors name
   the JSON path (`headers.0.pins: header.pins must have exactly rows*cols entries`). The
   first run also writes `pinIds` into part.json - that is expected.
2. `fritzkit render <slug> --png` (MCP `fritzkit_render`, view `breadboard`, PNG). The CLI
   writes into `<workspace>/<slug>/build/` and prints the paths; Read the PNG.
3. LOOK at the breadboard PNG next to the top-view photo, pad by pad: same count, same
   order, same names, same side, same spacing, outline proportions right, nothing labelled
   on the wrong pad, USB/connector on the right edge. Also check `--view schematic` (power
   top, GND bottom, no duplicated names that should be one bus) and `--view pcb` (pad sizes
   and holes plausible).
4. Fix part.json and repeat. Typical fixes: x and y swapped, a row mirrored (pin order
   reversed), first-pin centre off by half a pitch, orientation `horizontal` vs `vertical`.

Optional: `fritzkit validate <slug> --checker` also runs Fritzing's own part checker (needs
`uv`; see Troubleshooting).

### 5. Export and install

- `fritzkit export <slug>` writes `<workspace>/<slug>/<moduleId>.fzpz` and prints its path.
  It refuses while the validator reports errors; fix them. `--force` overrides that gate -
  do not use it to ship a broken part.
- `fritzkit install <slug>` (or `export <slug> --install`) puts it into Fritzing's user parts
  folder so it shows up under **My Parts**. **Fritzing must be closed**: Fritzing reads its
  parts folder only at startup, so fritzkit refuses (exit code 3) while Fritzing.exe runs and
  says so (the `.fzpz` is still written and its path printed). Ask the user to quit
  Fritzing, then retry.
- Alternative: hand the `.fzpz` path to the user - in Fritzing, File > Open on the `.fzpz`
  imports it into My Parts.
- Every export of changed content gets a NEW moduleId (Fritzing refuses duplicate ids), so
  repeated installs pile up versions. `fritzkit prune <slug>` lists the older installed
  versions of the part's family (a dry run); `fritzkit prune <slug> --yes` deletes them,
  keeping the newest (`--keep <moduleId>` keeps a specific one instead). Run it with
  Fritzing closed too.

### 6. Report to the user

Say plainly:

- which sources you used (URLs, which image gave the dimensions, which gave the pinout),
- what was MEASURED (dimension callout, datasheet drawing) vs ESTIMATED (pad positions read
  off a photo, back-side pads, pad sizes),
- which nets you could not confirm and the user should check with a multimeter (continuity
  between pads you bused or deliberately did not bus), and which dimensions to check with
  calipers before fabricating a PCB from the footprint,
- the `.fzpz` path, whether it was installed, and the orientation of the drawing.

## Common mistakes

Surveyed community Fritzing parts mostly fail on the same few things. fritzkit makes the
format ones impossible (layer ids that do not match the fzp, a schematic off the 0.1 in grid,
unitless SVG sizes read at the wrong dpi, Arial or other unsupported fonts, `<tspan>` and CSS
styles, multi-MB embedded photos, a PCB view missing `copper1`). What it cannot fix is the
content, which is your job:

- **No buses for shared nets.** The most common defect. Several GND pads must be one bus or
  Fritzing treats them as unconnected. Equally wrong: busing pins that only share a name
  pattern.
- **Generic names** (`pin1`, `P3`) instead of the silkscreen text. Users wire by name.
- **Wrong roles**: a supply pin left as `io` lands on the wrong side of the schematic.
- **Mirrored or rotated pin order**: the render shows names in a different order than the
  photo. Compare pad by pad.
- **Outline from the listing's "Product Dimensions"** (often the box) instead of a callout.
- **Header modelled as loose pins** with drifting positions: use `headers` so the pitch is
  exact and the part seats in a breadboard.
- **Editing `pinIds`** or reusing a key for a different pin: breaks wire survival on swap.

## Artwork styles

- `vector` (default): Fritzing house style - board colour, component shapes, silkscreen
  text, real-looking headers and pads. Crisp at every zoom, small, editable in Fritzing's
  Parts Editor, accepted everywhere. Use it unless the user asks for a photo.
- `photo` (opt-in): the listing photo embedded in the breadboard view with vector pads on
  top. Needs `artwork.photo.src` pointing into `assets/`, usually with
  `removeBackground: true` (keys out a white listing background and trims to the board),
  plus `crop` / `rotate` (clockwise, after the crop) to match the spec orientation. The
  photo must be orthographic and the trimmed board must fill the outline exactly. Caveats:
  Fritzing's Parts Editor drops embedded rasters if the user edits the part, it pixelates
  when zoomed, and Gerber export strips images (PCB view is always vector anyway). Use it
  when recognisability matters more than editability (a busy board that vector shapes
  cannot convey).

## Connector kinds

Through-hole solder pads at arbitrary positions (`pins`, `type: "female"`):

```json
{
  "key": "vin",
  "name": "VIN",
  "role": "power",
  "xMm": 3.2,
  "yMm": 4.5,
  "pad": { "shape": "rect", "wMm": 2.5, "hMm": 2.5, "holeMm": 1.2 }
}
```

0.1 in header (`headers`, `kind` `male` or `female`; position = FIRST pin):

```json
{
  "key": "j1",
  "kind": "male",
  "cols": 4,
  "xMm": 2.54,
  "yMm": 1.27,
  "pins": [
    { "key": "vcc", "name": "VCC", "role": "power" },
    { "key": "gnd", "name": "GND", "role": "gnd" },
    { "key": "scl", "name": "SCL", "role": "i2c" },
    { "key": "sda", "name": "SDA", "role": "i2c" }
  ]
}
```

Flying wire leads (`leads`; the connector is the free end):

```json
{
  "key": "vbat",
  "name": "VBAT",
  "role": "power",
  "color": "#D02020",
  "gaugeMm": 2.2,
  "fromXMm": 0,
  "fromYMm": 6,
  "direction": "left",
  "lengthMm": 40
}
```

Castellated / SMD edge pads (`headers` with `kind: "castellated"`, or a `pins` entry with
`type: "pad"` and no hole). For a vertical column on a side edge, rotate the pad yourself:

```json
{
  "key": "left",
  "kind": "castellated",
  "cols": 7,
  "orientation": "vertical",
  "xMm": 1.0,
  "yMm": 2.88,
  "pad": { "shape": "rect", "wMm": 2.4, "hMm": 1.6, "smd": true },
  "pins": ["...7 header pins..."]
}
```

## Swapping versions in Fritzing

All exports of one slug share a `family` (the slug) and differ in `variant`
(`v<version> <hash8>`). In Fritzing, click a placed copy, then pick the newer variant in the
Inspector's variant drop-down: Fritzing swaps the part in place. Connector ids come from the
persistent `pinIds` map, so every pin that still exists keeps its id and its wires stay
attached. Bump `version` when the change is material so the user can tell versions apart.

## Troubleshooting

Validator issue codes (`fritzkit validate` prints `ERROR [code] <where> message (fix: ...)`):

| code                                                                                                                                                   | what to change                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec-schema`                                                                                                                                          | part.json does not match the schema: fix the field at the printed path (`fritzkit schema` shows the format)                                                      |
| `buses`                                                                                                                                                | a bus names an unknown key, a pin is in two buses (merge them), or a bus has < 2 members (remove it)                                                             |
| `connector-numbering`                                                                                                                                  | a WARNING about gaps after removing pins is expected and harmless; never renumber `pinIds` to "fix" it                                                           |
| `layer-ids`, `connector-refs`, `svg-root`, `svg-style`, `pcb-layers`, `copper-only`, `zip-entries`, `module-id`, `required-tags`, `fzp-xml`, `svg-xml` | generated-output problems: these should not happen from a valid spec. Re-run with `--checker`, and report the spec and the message to the user as a fritzkit bug |

Other problems:

- Duplicate pin key, or a bus key that does not exist: the message names it; keys are case
  sensitive and unique across pins, headers and leads.
- `Fritzing is running` / exit code 3 on install or prune: ask the user to quit Fritzing
  (File > Quit), then retry.
- `--checker` says uv is missing: install uv (https://docs.astral.sh/uv/) or skip the
  checker; `fritzkit doctor` lists what is missing (Node version, uv, Fritzing install, the
  user parts folder).
- The part imports but has no artwork, or the part does not appear under My Parts: run
  `fritzkit doctor`, re-export, check Fritzing was restarted after install.
- Render looks right but pads are slightly off: re-measure px/mm on a straighter photo or
  use the datasheet drawing; header pins only need the first pin right.
