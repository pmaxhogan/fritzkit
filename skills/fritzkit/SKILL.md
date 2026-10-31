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

Check which interface you have: if tools named `fritzkit_*` are in your tool list, the MCP
server is available; if not, use the CLI. The two are equivalent.

Global CLI flags: `--workspace <dir>` (default `~/fritzkit/parts`, or env
`FRITZKIT_WORKSPACE`) and `--json`. `<part>` is a slug in the workspace or a path to a part
folder. `--workspace` may be relative to the cwd. Each part lives in `<workspace>/<slug>/`
with `part.json` and `assets/`. `fritzkit new` writes a TEMPLATE (a placeholder one-pin
breakout): replace the whole part.json with your own spec, do not edit the template in place.
EVERY placeholder field must go. The template values to grep for before export: description `Generic sensor breakout. Replace this with what the part is.`, tags
`sensor` and `breakout`, outline 20 x 15 mm, and a single pin with key and name `VCC`
(description `Supply voltage`, role `power`, female, x 3.81, y 7.62). If your part has no
`VCC` pin, no `VCC` may survive; run `grep -nE 'VCC|Generic sensor|breakout' part.json`.

Field reference (every field, type, default, unit): [reference/part-json.md](reference/part-json.md).
More worked examples (HW-391 pads-only board, wire-lead ESC, relay module, KiCad import): [reference/examples.md](reference/examples.md).

## The coordinate frame (read this first)

All lengths are millimetres. Origin = TOP-LEFT corner of the board outline, x to the right
along `widthMm`, y DOWN along `heightMm` - exactly like a top-down photo on screen. Every
position is a CENTRE (pad centre, first header pin centre). Pad `wMm` is along x, `hMm`
along y. Things may stick out past the outline (leads, USB sockets).

## Workflow

### 1. Gather sources with your own tools (fritzkit never goes online)

Make the part folder first (`fritzkit new <slug> --title "..."`; run `fritzkit init` once
if the workspace does not exist), then collect into `<workspace>/<slug>/assets/`:

- **Amazon listing** (in this order):
  1. Fetch the MOBILE form with a plain GET: `curl -sSL https://www.amazon.com/gp/aw/d/<ASIN> -o
assets/listing.html` (the 10-character ASIN from the `/dp/<ASIN>` link). No header spoofing,
     no cookies, no scripting around anything. This returns the full page including the
     gallery. The `/dp/` desktop form tends to return a captcha. NEVER solve or script around
     a captcha: if any fetch returns a captcha or "robot check" page, stop, use the browser
     tool instead, or ask the user to save the product images into `assets/`.
  2. Extract the full-resolution gallery URLs from the HTML:
     `grep -o '"hiRes":"[^"]*"' assets/listing.html | sort -u` (fall back to `"large":"..."`).
  3. Download them from `m.media-amazon.com` with a plain GET (`curl -sSL -o assets/img1.jpg
<url>`); if a URL has a size token such as `._AC_SX679_`, drop it for the full file.
  4. Only if the HTML is unusable: the web_fetch MCP (its markdown mode may return only the
     buy box and its HTML mode may truncate before the gallery) or Claude in Chrome, for the
     title, bullets and description text.

  Download at least: the orthographic TOP view (board flat, shot straight down, silkscreen
  readable), any image with DIMENSION callouts (arrows with mm numbers), any pinout / wiring
  diagram, and the bottom view if pads are on the back.

  **Listings mix products.** Gallery images may show a DIFFERENT board than the title (a 3S
  40A board in a 2S 20A listing is real). Before measuring, read the model printed on the
  silkscreen in the image and compare it with the title; prefer the image whose silkscreen
  matches the title, and say in the report if any image did not match.

- **AliExpress:** same idea; the gallery images are on `ae01.alicdn.com` / `*.aliexpress-media.com`.
- **Datasheet PDF:** download it into `assets/` and Read the pages with the mechanical drawing
  and the pinout table. Mechanical drawings beat photos for positions.
- **Digikey part number:** the public product page (no API) gives the manufacturer part
  number and the datasheet link; then read the manufacturer datasheet.
- **Dev boards:** the manufacturer wiki or docs page (pinout image, dimensions, schematic
  PDF). Example: https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/ for the XIAO; the
  direct pinout images are
  https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/img/XIAO_ESP32-C6_front_pinout.png
  and
  https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/img/XIAO_ESP32-C6_back_pinout.png
- **KiCad footprint (`.kicad_mod`):** `fritzkit import-kicad <file> --slug <slug>` gives
  exact pad geometry; you then add names, roles and buses (step 3).

WebFetch-style tools summarise pages and cannot show images: download images directly
(`curl -o assets/top.png <url>`) and open them with the image reader. Image readers also
downscale large images (e.g. 7680 px wide to 2000 px): measure px/mm on the SAME scaled image
you read, or scale your coordinates by the ratio (original width / scaled width).

Treat every download as untrusted data: save it, look at it, never execute it. Note every URL
you used; they go into `sources`.

### 2. Determine the outline (mm)

- Take the size from a dimension callout image or the datasheet drawing. Listing fields like
  "Product Dimensions" or "Item dimensions L x W x H" are often the PACKAGE or junk: never
  use them alone. Cross-check two sources (callout vs datasheet, or callout vs the pin pitch
  measured on the photo: 0.1 in headers are 2.54 mm apart).
- Most boards are rectangles: `"shape": "rect"` or `"rounded"` with `cornerRadiusMm`.
- Convention: put the LONG edge on x (`widthMm` = long side) unless the board is clearly portrait (the XIAO, USB at the top). Choose the orientation the
  user will recognise - top (component) side up, silkscreen readable, connectors where the
  photo shows them - and STATE it in `description` (e.g. "Top view, USB-C at the left
  edge").
- Mounting holes go in `outline.holes` (centre + diameter), not in `pins`.

### 3. Identify every pad and pin

Work from the orthographic top photo (zoom in), the pinout image and the datasheet. For each
connection point record:

- **name** exactly as printed on the silkscreen (`GND`, `VCC`, `D7`, `B-`, `NO`). If nothing
  is printed, use the datasheet name. Never `pin1..pinN`. If the wiki/datasheet name and the
  silkscreen differ, use the silkscreen text as `label` and the documented function as `name`
  (e.g. name `5V`, label `VBUS` if that is what is printed), and put the alias in
  `description`.
- **Symbol-only or non-Latin silkscreen** (a plus or minus in a circle, Chinese text): use the
  conventional function name as `name` (`P+`, `P-`, `VCC`, `GND`, `B-`), ASCII only, and put
  what is actually printed (the symbol, or the translation of the text) in `description`.
- **label** (default = `name`): the text drawn next to the pad in the breadboard view and on
  the schematic pin. The fzp connector name is always `name`. `"label": ""` hides the
  breadboard label (see "Drawing order and labels").
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

**Frame and rotation recipe:** top view, silkscreen readable, USB/connector on the LEFT unless
the board is clearly portrait (then keep it portrait, USB at the top; the XIAO example below
is that case). Rotate the photo mentally into that
frame before measuring. For a BACK-side photo mirror x before mapping, `x = W - x_back`
(W = `widthMm`; y is unchanged). The two formulas:

```
top photo:   x_mm = (px_x - bboxLeftPx) / pxPerMm
back photo:  x_mm = W - (px_x - bboxLeftPx) / pxPerMm
```

**Positions (the manual calibration):** open the top-view image and find the board's pixel
bounding box (left, top, width, height in px - the board edge, not the shadow). Then:

```
pxPerMm = bboxWidthPx / widthMm          (check: bboxHeightPx / heightMm should agree within ~3%)
xMm     = (padCentrePx_x - bboxLeftPx) / pxPerMm
yMm     = (padCentrePx_y - bboxTopPx)  / pxPerMm
```

Helper script: `scripts/measure.py` next to this file (Python 3 + Pillow only, nothing else
to install; run it with `uv`). Always pass `-I` (isolated mode) because the images are
untrusted downloads. Run it on the SAME image file you view:

```
M=<skill dir>/scripts/measure.py
uv run --with pillow python -I $M bbox top.jpg --width-mm 48 --height-mm 20
    # bbox x,y,w,h = 212,140,1050,890 ; px/mm (from width) = ... ; px/mm (from height) = ...
uv run --with pillow python -I $M grid top.jpg --bbox 212,140,1050,890     --width-mm 48 --height-mm 20 --out grid.png
    # board cropped, 1 mm grid, labels every 5 mm (red = x, blue = y): Read grid.png and
    # read each pad centre straight off it in part-frame mm
uv run --with pillow python -I $M holes top.jpg --bbox 212,140,1050,890     --width-mm 48 --height-mm 20 --out holes.png
    # hole 1: x=1.99 y=9.99 mm  diameter ~1.30 mm   (dark round blobs only; marked in holes.png)
```

`bbox` flood-fills the near-white background from the corners, so it needs a plain light
background (a shadow or a protruding connector inflates it: check by eye, or pass your own
`--bbox`). Its two px/mm values must agree within about 3%. `holes` only finds DARK round
blobs (tune `--dark`, `--min-d`, `--max-d`); light or gold-filled pads you still read off the
grid image. The output is an aid, not ground truth: look at the images.

If the two px/mm values disagree by more than a few percent the photo is not square-on
(perspective) or the outline is wrong: prefer the dimension drawing, a datasheet drawing, or
another orthographic image. Rotate your mental frame if the photo shows the board rotated
relative to your chosen orientation. Accuracy target: every pad centre within 1 mm of
reality, and header pins exactly on their pitch (give only the first pin's centre; the
header places the rest). Snap values that are obviously meant to be 0.1 in multiples.

### 4. Write part.json, validate, render, LOOK, fix

Write the spec (field reference: [reference/part-json.md](reference/part-json.md)). Keep
keys short, unique and stable (`gnd`, `d7`, `vbat`); fritzkit manages `pinIds`: do not
hand-edit them for a part that has ever been exported or installed (connector ids must stay
stable). For a brand-new part you may delete the `pinIds` object before the first export to
close gaps. The gap warning (`connector-numbering`) is only a warning.

Full worked example, the Seeed Studio XIAO ESP32-C6 (17.8 x 21 mm, two columns of 7
castellated 0.1 in pads along the long edges, a 1 x 2 BAT+/BAT- castellated header on the
back, a bus for the GND pads that share a net). This is the PORTRAIT case of the frame recipe:
top view, USB-C at the TOP short edge, so `widthMm` is the short side. It is a copy of the
checked, measured golden part in `examples/xiao-esp32-c6/` (part.json plus a README with the
source of every number), minus `pinIds` and two of the sources:

```json
{
  "$schema": "https://raw.githubusercontent.com/pmaxhogan/fritzkit/main/src/core/schema/part.schema.json",
  "slug": "xiao-esp32-c6",
  "title": "Seeed Studio XIAO ESP32-C6",
  "version": 1,
  "label": "U",
  "tags": ["xiao", "esp32-c6", "seeed", "castellated", "wifi 6", "zigbee", "thread"],
  "description": "Seeed Studio XIAO ESP32-C6, 21 x 17.8 mm. Top (component) view, USB-C at the TOP short edge, the two columns of 7 castellated 0.1 in pads along the long edges: D0..D6 down the left edge, 5V/GND/3V3/D10/D9/D8/D7 down the right edge. BAT+ and BAT- are pads on the BACK, drawn where they sit seen through the board. BAT- and the side GND pad are the same net (Seeed's KiCad symbol names that pad GND), hence the GND bus.",
  "sources": [
    "https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/",
    "https://files.seeedstudio.com/wiki/XIAO-KiCad-Library/New_XIAO_Series_Footprints.zip"
  ],
  "properties": {
    "mpn": "XIAO ESP32C6",
    "type": "module",
    "chip": "ESP32-C6"
  },
  "outline": {
    "widthMm": 17.8,
    "heightMm": 21,
    "shape": "rounded",
    "cornerRadiusMm": 1.5
  },
  "artwork": {
    "style": "vector",
    "boardColor": "#1A1A1A",
    "components": [
      {
        "kind": "rect",
        "xMm": 4.4,
        "yMm": -1.5,
        "wMm": 9,
        "hMm": 7.4,
        "color": "#B8B8B8",
        "rxMm": 0.8,
        "note": "USB-C receptacle, overhangs the top edge by 1.5 mm (KiCad footprint silk)"
      },
      {
        "kind": "rect",
        "xMm": 3,
        "yMm": 6.8,
        "wMm": 11.8,
        "hMm": 10.4,
        "color": "#6E6E6E",
        "rxMm": 0.4,
        "note": "ESP32-C6 RF shield can"
      },
      {
        "kind": "text",
        "text": "XIAO",
        "xMm": 8.9,
        "yMm": 9.8,
        "sizeMm": 1.8,
        "color": "#E8E8E8"
      },
      {
        "kind": "text",
        "text": "ESP32-C6",
        "xMm": 8.9,
        "yMm": 12,
        "sizeMm": 1.4,
        "color": "#E8E8E8"
      },
      {
        "kind": "rect",
        "xMm": 3.2,
        "yMm": 18,
        "wMm": 2.4,
        "hMm": 2.4,
        "color": "#C8A040",
        "rxMm": 0.3,
        "note": "U.FL external antenna connector"
      },
      {
        "kind": "rect",
        "xMm": 8.7,
        "yMm": 18.5,
        "wMm": 6.4,
        "hMm": 1.9,
        "color": "#B0B0B0",
        "rxMm": 0.2,
        "note": "ceramic chip antenna"
      }
    ]
  },
  "headers": [
    {
      "key": "left",
      "kind": "castellated",
      "cols": 7,
      "orientation": "vertical",
      "xMm": 1.28,
      "yMm": 2.88,
      "pins": [
        {
          "key": "d0",
          "name": "D0",
          "role": "analog",
          "description": "D0 / A0: GPIO0 (LP_GPIO0), ADC"
        },
        {
          "key": "d1",
          "name": "D1",
          "role": "analog",
          "description": "D1 / A1: GPIO1 (LP_GPIO1), ADC"
        },
        {
          "key": "d2",
          "name": "D2",
          "role": "analog",
          "description": "D2 / A2: GPIO2 (LP_GPIO2), ADC"
        },
        {
          "key": "d3",
          "name": "D3",
          "role": "io",
          "description": "D3: GPIO21 (SDIO_DATA1)"
        },
        {
          "key": "d4",
          "name": "D4",
          "role": "i2c",
          "description": "D4 / SDA: GPIO22, I2C data (SDIO_DATA2)"
        },
        {
          "key": "d5",
          "name": "D5",
          "role": "i2c",
          "description": "D5 / SCL: GPIO23, I2C clock (SDIO_DATA3)"
        },
        {
          "key": "d6",
          "name": "D6",
          "role": "uart",
          "description": "D6 / TX: GPIO16, UART transmit"
        }
      ]
    },
    {
      "key": "right",
      "kind": "castellated",
      "cols": 7,
      "orientation": "vertical",
      "xMm": 16.52,
      "yMm": 2.88,
      "pins": [
        {
          "key": "5v",
          "name": "5V",
          "role": "power",
          "description": "5V (VBUS): USB-C 5 V in/out. No voltage here when running from the battery"
        },
        {
          "key": "gnd",
          "name": "GND",
          "role": "gnd",
          "description": "Ground"
        },
        {
          "key": "3v3",
          "name": "3V3",
          "role": "power",
          "description": "3V3 (3V3_OUT): 3.3 V regulator output"
        },
        {
          "key": "d10",
          "name": "D10",
          "role": "spi",
          "description": "D10 / MOSI: GPIO18, SPI data out"
        },
        {
          "key": "d9",
          "name": "D9",
          "role": "spi",
          "description": "D9 / MISO: GPIO20, SPI data in"
        },
        {
          "key": "d8",
          "name": "D8",
          "role": "spi",
          "description": "D8 / SCK: GPIO19, SPI clock"
        },
        {
          "key": "d7",
          "name": "D7",
          "role": "uart",
          "description": "D7 / RX: GPIO17, UART receive"
        }
      ]
    },
    {
      "key": "bat",
      "kind": "castellated",
      "cols": 2,
      "orientation": "horizontal",
      "xMm": 7.11,
      "yMm": 16.03,
      "pad": {
        "shape": "rect",
        "wMm": 1.1,
        "hMm": 2.5,
        "smd": true
      },
      "pins": [
        {
          "key": "bat+",
          "name": "BAT+",
          "label": "B+",
          "role": "power",
          "description": "Li-ion battery plus (VBAT), pad on the BACK; charged by the on-board SGM40567 charger"
        },
        {
          "key": "bat-",
          "name": "BAT-",
          "label": "B-",
          "role": "gnd",
          "description": "Battery minus, pad on the BACK. Same net as GND"
        }
      ]
    }
  ],
  "buses": [
    {
      "id": "GND",
      "pins": ["gnd", "bat-"]
    }
  ]
}
```

Derivation: 7 pins at 2.54 mm span 15.24 mm; the columns are 15.24 mm apart, centred on the
17.8 mm width: x = (17.8 - 15.24) / 2 = 1.28 and 16.52. The first pad is at y = 2.88 (from
Seeed's KiCad footprint), pitch 2.54. BAT+ (7.11, 16.03) and BAT- (9.65, 16.03) are measured
from the same footprint, not estimated. Read the wiki yourself for the real pin functions and
silkscreen (apply the name/label rule).

What this example deliberately leaves out or hedges:

- The real board also has back-side test pads (MTDO, MTDI, MTCK, MTMS, EN, BOOT, a second GND
  and 3V3). They are omitted; if you add them, give them `"label": ""` to avoid clutter.
- BAT- is bused with the side GND pad because Seeed's KiCad symbol names that pad GND; the
  wiki text itself does not say it. Without such evidence, leave a pin unbused until a
  continuity check.
- The battery pads are on the BACK but drawn where they sit seen through the board, as a
  castellated `bat` header with a custom `pad`.

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
`uv`; see Troubleshooting). In the current build the plain text output may show only
`No issues found.` without a checker line; use `--json`, whose `checker` object (`ran`,
`summary` such as `fzp checker: ran (0 errors, 0 warnings)`, `errors`, `warnings`) is the
reliable way to confirm the checker actually ran.

`validate` and `render` also accept a path to a `.fzpz`. `validate <file.fzpz>` checks the
package itself (zip entries, fzp XML, layer ids, connector refs, svg roots, module id) but
not your spec (no schema or bus checks); `render <file.fzpz>` writes that package's SVGs.

`render` writes `<view>.svg` for each view (breadboard, schematic, pcb, icon) into
`<workspace>/<slug>/build/` (or `--out <dir>`); `--png` ALSO writes `<view>.png` next to each
SVG. Options: `--view <v>`, `--out <dir>`, `--png`. It prints the output paths.
`--view <breadboard|schematic|pcb|icon>` restricts the run to that ONE view (default `all`), so
you only get that view's files: use it for fast re-checks while iterating. If it ever prints
paths for views you did not ask for, ignore the extras and report it.

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

## Drawing order and labels

- Breadboard layer order: silkscreen and `components` are drawn UNDER header bodies, pads and
  pin labels. Put your own text and shapes where pads and labels are not.
- Pin labels use `label` (default `name`). `"label": ""` skips the breadboard label for that
  pin (pads and headers). In the schematic an empty label is NOT replaced by `name`: the pin
  is drawn with an empty label (the pin still exists; the fzp connector name is still `name`).
- Schematic `layout` `by-role` (the only one): ONE box; pins are grouped by role onto sides
  (power/usb/enable/reset left, gnd bottom, io-like right), in spec order within a role; every
  bused GND pin still gets its own pin. `schematic.sides` overrides the side per role
  (`{"left": ["power", "gnd"], ...}`). There is no explicit per-pin ordering hint yet; reorder
  the pins in the spec to change order within a role.

## Reading the PCB preview

Through-hole pads are drawn as a copper RING (an SVG `<circle>` with `fill="none"`, the ring
being its stroke), so the drill is the empty centre. Oblong or rectangular pads also get a
solid copper rect UNDER the ring, which makes the PNG look like a solid block with no visible
hole. To read the drill from `pcb.svg`: units are mils (1/1000 in; 1 mm = 39.37 mil); the
circle has `r` (the stroke centre line) and `stroke-width` (the ring width), so
`drill diameter = 2 * (r - stroke-width / 2)` and `copper diameter = 2 * (r + stroke-width / 2)`.
A pad's copper is clamped to at least the drill plus the minimum ring, and the drill to a
minimum size, so very small `holeMm` values are enlarged. In a rectangular pad the ring spans
the SHORT side; the rest is the rect.

## Pin labels: placement and suppression

There is no field to move a label: breadboard labels sit at a fixed offset next to their pad.
If a label collides with artwork or another label, set `"label": ""` on that pin (breadboard
only; the schematic pin is then drawn unlabelled and the connector name is still `name`) or
move your own silkscreen/components, which are drawn UNDER pads and labels (see "Drawing order
and labels"). Layer order, bottom to top: board, `silkscreen` and `components`, header bodies,
pads, pin labels.

## Environment notes

- Old `.fzpz` exports stay in the part folder (each material change is a new moduleId):
  delete stale ones or use the path `export` printed.

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
- **Editing `pinIds`** of an exported part, or reusing a key for a different pin: breaks wire survival on swap.

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
