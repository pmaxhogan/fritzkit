# The agent workflow (long form)

This is the long form of the Claude Code skill in
[skills/fritzkit/SKILL.md](../skills/fritzkit/SKILL.md). It is written for an AI agent that
is handed a product link and has to produce a good Fritzing part in one go, using only its
own web/vision tools plus the fritzkit CLI or MCP server. Field reference:
[part-json.md](part-json.md).

The division of labour: **you** find the sources, read the photos and datasheets, and write
`part.json`; **fritzkit** compiles it offline and deterministically into a `.fzpz` with
breadboard, schematic, PCB and icon views, validates it, and installs it into Fritzing.

## 0. Set up

```
fritzkit doctor                              # Node, uv (optional), Fritzing install, parts folder
fritzkit init                                # creates the workspace (~/fritzkit/parts by default)
fritzkit new <slug> --title "<human title>"  # creates <workspace>/<slug>/part.json + assets/
```

Choose a slug that names the product, lowercase with dashes (`xiao-esp32-c6`,
`relay-1ch-5v`). Over MCP: `fritzkit_init_workspace`, then `fritzkit_new_part`.

`fritzkit new` writes a small placeholder spec (a generic breakout with one pin). Replace
all of it.

## 1. Gather sources

fritzkit never goes online. Use your own tools and save what you need into
`<workspace>/<slug>/assets/`.

### Amazon

- Get the ASIN (10 characters after `/dp/` or `/gp/product/` in the link).
- Fetch `https://www.amazon.com/gp/aw/d/<ASIN>` (the mobile form) with the web_fetch MCP,
  or open it in Claude in Chrome. The desktop `/dp/<ASIN>` form answers automated clients
  with a captcha; do not retry it, do not try to get around it (no header spoofing, no
  scripted solving). If the mobile form also fails, ask the user for the images.
- Read the title, bullet points and description for: board dimensions, pin list,
  voltages, chip names. Treat the "Product Dimensions" / "Item dimensions" field with
  suspicion - it is often the package size or copied from another listing.
- Collect the gallery image URLs. They live on `https://m.media-amazon.com/images/I/<id>.<ext>`
  and are fetchable with a plain GET. A URL like `.../I/71abc._AC_SX679_.jpg` has a size
  token; removing it (`.../I/71abc.jpg`) gives the largest version.
- Download into `assets/` with descriptive names: `top.jpg` (orthographic top view),
  `dims.jpg` (dimension callouts), `pinout.jpg`, `bottom.jpg`.

### AliExpress and other shops

Same approach: product page for text, gallery images for photos. Seller images often carry
dimension callouts; they are as good as a datasheet only if two sources agree.

### Datasheets and manufacturer pages

- Download the PDF into `assets/` and Read the pages with the mechanical drawing (board
  outline, hole and pad positions, often with a pin-1 marker) and the pinout table.
  Positions from a drawing are better than anything measured off a photo.
- Dev boards usually have a wiki or docs page with a pinout image, the board size and a
  schematic PDF. The schematic answers net questions (which GND pads are tied, whether two
  `VCC` pads are the same rail). Example:
  https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/ for the Seeed XIAO ESP32-C6.

### Digikey

Use the public product page (no API key needed) to get the manufacturer part number,
package dimensions and the datasheet link, then read the manufacturer datasheet. Many
Digikey pages also link a KiCad footprint (via SnapEDA / Ultra Librarian).

### KiCad footprints

```
fritzkit import-kicad <file.kicad_mod> --slug <slug>
```

gives exact pad geometry. See [the KiCad example](../skills/fritzkit/reference/examples.md#starting-from-a-kicad-footprint)
for what you still have to add (names, roles, buses, artwork).

### Safety

Every downloaded file is untrusted data. Save it, open it as an image or read it as a PDF;
never execute it, never unpack archives into the workspace and run anything from them.
Record every URL you used for `sources`.

## 2. Determine the outline

1. Find the board size in mm from a dimension callout image or a datasheet drawing.
2. Cross-check with a second source. Good cross-checks: a second callout image; the
   datasheet; the pin pitch measured on the photo (0.1 in headers are 2.54 mm apart, so a
   7-pin row spans 15.24 mm centre to centre); a known component size (USB-C receptacle
   about 9 mm wide, micro-USB about 7.5 mm, 2.54 mm screw terminals vs 5.0 mm).
3. If the sources disagree, prefer the manufacturer drawing, then a callout photo, then
   measurements derived from the pitch. Note the disagreement for the report.
4. Shape: `rect` for square corners, `rounded` with `cornerRadiusMm`, or `custom` with an
   SVG path in mm for odd shapes. Mounting holes go in `outline.holes`.
5. Orientation: put the long edge on x (`widthMm` = long side). Show the top (component)
   side with silkscreen readable. If the board has an obvious "input" side (USB, power),
   put it at the left. Write the orientation into `description`.

## 3. Identify every pad and pin

Open the orthographic top photo at full resolution (zoom into each edge) together with the
pinout image and the datasheet table.

For each connection point decide:

| question                      | where it goes                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| what does the silkscreen say? | `name` (exact text; `label` if the name is long)                                                       |
| what does it do?              | `description` (function, voltage, alternate functions)                                                 |
| electrical role?              | `role`: power, gnd, io, analog, pwm, i2c, spi, uart, usb, clock, reset, enable, nc, other              |
| same copper as another pad?   | one `buses` entry per shared net                                                                       |
| part of a regular 0.1 in row? | `headers` (kind male / female / castellated) - give the first pin's centre                             |
| a lone or irregular pad?      | `pins` with `type` female (through-hole pad, socket, screw terminal), male (pin) or pad (SMD, no hole) |
| a wire hanging off the board? | `leads` (`fromXMm`/`fromYMm` where it leaves the board, `direction`, `lengthMm`, `color`)              |
| copper size and hole?         | `pad` (`shape`, `wMm` along x, `hMm` along y, `holeMm`)                                                |

### Nets and buses

- Several pads printed `GND` (or `-`, `0V`, `G`) are almost always one net: one `GND` bus.
- Two pads with the same supply name next to each other on a breakout are usually tied;
  check that the copper pour or a trace visibly joins them, or that the schematic says so.
- Do NOT bus pins because the names look alike (`IN1`/`IN2`, two `+` pads on different
  sides of a converter, `VIN`/`VOUT`, `5V`/`3V3`). When in doubt, do not bus, and list it
  in the report for the user to check with a multimeter.

### Measuring positions (manual calibration)

1. In the top-view image, find the board's pixel bounding box: the left, top, right and
   bottom edges of the PCB itself (not the shadow, not protruding connectors). Image
   viewers and your own vision both work; zoom in on each edge.
2. Compute the scale on both axes:
   `pxPerMmX = bboxWidthPx / widthMm`, `pxPerMmY = bboxHeightPx / heightMm`.
   They should agree within about 3%. If not, the photo is in perspective, cropped, or the
   outline is wrong.
3. For each pad, find its centre pixel and convert:
   `xMm = (px - bboxLeftPx) / pxPerMmX`, `yMm = (py - bboxTopPx) / pxPerMmY`.
4. Round to 0.05 mm. Where values are obviously meant to be on a 0.1 in grid (header pins,
   breakout pads), snap them to multiples of 2.54 mm relative to each other.

Worked example: the board is 21 x 17.8 mm and spans pixels x 212..1262, y 140..1030 in the
photo. pxPerMmX = 1050 / 21 = 50.0, pxPerMmY = 890 / 17.8 = 50.0 (agree). A pad centred at
pixel (356, 204) is at x = (356 - 212) / 50 = 2.88 mm, y = (204 - 140) / 50 = 1.28 mm.

If the photo shows the board rotated relative to the orientation you chose, rotate the
image first (or measure in the photo's own frame and then swap/negate the axes
consistently), so that the photo's top-left board corner is the part-frame origin.

Accuracy target: every pad centre within 1 mm; header pins exactly on pitch (only the first
pin is measured). If the only photos are perspective shots, use the dimension drawing, the
pitch and symmetry (rows centred on the board, pads at equal distance from the edge), and
mark the positions as estimates in the report.

### Back-side pads

Fritzing shows the top side. A pad that is only on the back (battery pads, test pads) is
placed where it lies when seen through the board from the top, i.e. mirror the bottom
photo left-to-right before measuring. Say "BACK side" in its description.

## 4. Write, validate, render, compare, fix

Write `part.json` (or over MCP: `fritzkit_set_part` with the whole spec, then
`fritzkit_patch_part` with JSON-patch operations for small fixes, `fritzkit_add_pins` to
append pins). The complete XIAO ESP32-C6 example is in [part-json.md](part-json.md#example-seeed-studio-xiao-esp32-c6)
and in the skill; an ESC with leads and a relay module are in
[examples.md](../skills/fritzkit/reference/examples.md).

Rules:

- Keys are short, unique across the whole part, and permanent (`gnd`, `d7`, `vbat`).
- `pinIds` is managed by fritzkit. Leave it out of a new spec; after the first validate it
  appears in part.json. Never edit or renumber it.
- Leave `family` unset (it defaults to the slug) unless you are deliberately putting several
  slugs in one swap group.

The loop:

```
fritzkit validate <slug>                 # schema + structure; fix every ERROR
fritzkit render <slug> --png             # PNGs of all views into <workspace>/<slug>/build/
fritzkit render <slug> --view breadboard --png
```

Over MCP: `fritzkit_validate`, then `fritzkit_render` with view `breadboard` and PNG output -
the tool returns the image so you can look at it directly.

Compare the breadboard PNG with the top photo, systematically:

1. Outline proportions and corner shape.
2. Pad count per edge.
3. Pad order: read the names along each edge in the render and in the photo; they must be
   the same sequence. A reversed sequence means the header's first pin is at the wrong end.
4. Positions: each pad within about 1 mm (half a pin pitch is already a visible error).
5. Connectors and big components on the correct edge.
6. Schematic view: supply pins at the top, GND at the bottom, no duplicated GND pins that
   should have been one bus (a bus is not visible in the drawing, but `fritzkit validate`
   output and the fzp list it).
7. PCB view: pad shapes and holes plausible; SMD pads have no hole.

Fix and repeat until the render matches. Optionally run
`fritzkit validate <slug> --checker` for Fritzing's own part checker (needs `uv`).

## 5. Export and install

```
fritzkit export <slug>          # -> <workspace>/<slug>/<moduleId>.fzpz (path printed)
fritzkit install <slug>         # export + copy into Fritzing's user parts folder (My Parts)
fritzkit prune <slug> --yes     # remove older installed versions of this family
```

- Install needs Fritzing CLOSED. Fritzing scans its parts folder only at startup, so a part
  installed while it runs would not appear; fritzkit refuses with exit code 3 and explains.
  Ask the user to quit Fritzing and retry; the `.fzpz` is already written and its path is
  in the message.
- `export` and `install` refuse while `validate` reports errors. `--force` overrides that
  gate; do not use it to ship a part with errors.
- Or give the user the `.fzpz`: in Fritzing, File > Open on the file imports it into My
  Parts.
- Every content change gives a new moduleId (Fritzing rejects a duplicate id), so each
  install adds a version. `prune <slug-or-family>` is a dry run that lists the older
  versions; with `--yes` it deletes them and keeps the newest (`--keep <moduleId>` keeps a
  specific one instead).

## 6. Report

Template:

```
Part: <title>  (<workspace>/<slug>/part.json)
Output: <path to .fzpz>  - installed into My Parts: yes/no (restart Fritzing to see it)
Orientation: top view, <connector> at the <edge> edge

Sources:
- <listing URL> (title, photos: top.jpg, dims.jpg)
- <datasheet / wiki URL> (dimensions, pinout table)

Measured: outline 21 x 17.8 mm (wiki + pitch cross-check); header pitch 2.54 mm
Estimated: pad positions of BAT+/BAT- (photo, +/- 1 mm); pad sizes

Please verify:
- continuity GND <-> BAT- (bused); <pads I did not bus> are separate nets
- outline and hole positions with calipers before using the PCB footprint for fabrication
```

## Editing an existing part

- Read it: `fritzkit list`, then open `<workspace>/<slug>/part.json` (or `fritzkit_get_part`).
- Change what is needed. Rename a pin via `name`, never via `key`. Delete a pin by removing
  it; its connector number stays reserved in `pinIds`, so wires on other pins survive.
- Bump `version` for material changes, then validate, render, export, install, prune.
- In Fritzing, swap placed copies to the new variant in the Inspector (same family).
