# fritzkit architecture

fritzkit is a deterministic compiler: `part.json` (+ `assets/`) in, a Fritzing `.fzpz`
out. It never calls an LLM and needs no network. The agent (Claude Code) does the
vision work and writes the spec; fritzkit turns the spec into a part Fritzing accepts.

## Pipeline

```
part.json --parsePartSpec--> PartSpec (zod, defaults applied)
        --resolvePart-----> ResolvedPart  (flat connector list, ids, buses, canvas frame)
        --identityFor-----> PartIdentity  (moduleId, family, variant, baseName)
        --render x4-------> breadboard.svg, schematic.svg, pcb.svg, icon.svg
        --buildFzp--------> part.fzp
        --zip-------------> <slug>.fzpz   (flat: part.<id>.fzp, svg.<view>.<id>_<view>.svg)
        --install---------> %APPDATA%/Fritzing/Fritzing/local_parts/user/<moduleId>/ + my_parts.fzb
```

Everything under `src/core/` is pure (no fs, no network) except `export/` (zip +
install/prune) and `image/` (sharp). `cli/`, `mcp/` and `ui/` are thin shells over core.

## Coordinate systems

- **Spec (part frame):** millimetres, origin at the top-left corner of the outline,
  x right, y down. Identical to a top-down photo of the board.
- **Canvas:** the SVG drawing area in mm. `Frame.offsetXMm/offsetYMm` translate part
  frame to canvas; the canvas grows past the outline to hold leads and overhanging
  pins. If the part has headers, the offset is chosen so the FIRST header pin lands
  exactly on a 100 mil multiple (Fritzing seats parts in breadboards by connector
  position). Use `toCanvas(frame, x, y)`.
- **SVG units:** root `width`/`height` in inches, `viewBox` in mils (1 unit = 1 mil).
  Use `mil(mm)` from `units.ts`. Never emit unitless sizes (Fritzing reads them at 90 dpi).

## Connector identity (D12 / D12a)

- `pinIds` in part.json maps pin key -> connector number. `allocatePinIds` gives new
  keys the next free number and never reuses one, so re-exporting after removing a pin
  keeps every other `connectorN` id, and the Inspector swap keeps wires attached.
- `moduleId = fritzkit-<slug>-<hash8>` changes with every content change (Fritzing
  refuses duplicate ids). `family = slug` is stable; `variant = v<version> <hash8>`.
- Connector ids AND names are kept stable across versions by construction (the name is
  the spec's `name`; renaming a pin is the user's deliberate choice).

## SVG rules (checked by the validator)

- Fonts: `Noto Sans` or `OCR-Fritzing-mono` only.
- XML attributes, not CSS. No `<tspan>`, no gradients, no `gorn` attributes.
- One top-level `<g id="<layer>">` per layer: `breadboard`, `schematic`,
  `copper1` > `copper0` nested, `silkscreen`, `icon`. Every layerId listed in the fzp
  must exist as an element id in that view's SVG.
- Connector element `connectorNpin` must be visible (fill or stroke). Terminal
  `connectorNterminal` must have non-zero size (1 mil rect at the pin centre). A lead
  uses `connectorNleg` (a `<line>`) INSTEAD of a terminal.
- PCB THT pad: `<circle r=".." stroke-width=".." stroke="#F7BD13" fill="none" id="connectorNpin"/>`
  in BOTH copper0 and copper1 (same id is fine: they are separate groups and Fritzing
  looks the id up per layer). SMD pads: copper1 only, `<rect>`.
- Schematic: pins on the 0.1 in grid, 0.1 in long, body `#000000`, pins `#555555`.

## Views

| view | layer ids | notes |
|---|---|---|
| breadboard | `breadboard` | house-style vector (default) or photo (embedded PNG data URI, `xmlns:xlink`, base64 wrapped at 60 chars) with vector pads on top |
| schematic | `schematic` | auto rectangle; pins grouped by role: power top/left, gnd bottom, io right |
| pcb | `copper0` (THT only), `copper1`, `silkscreen` | real footprint from the pad table |
| icon | `icon` | cropped breadboard artwork, square-ish |

## Files inside the .fzpz

```
part.fritzkit-<slug>-<hash8>.fzp
svg.breadboard.fritzkit-<slug>-<hash8>_breadboard.svg
svg.schematic.fritzkit-<slug>-<hash8>_schematic.svg
svg.pcb.fritzkit-<slug>-<hash8>_pcb.svg
svg.icon.fritzkit-<slug>-<hash8>_icon.svg
```

The fzp's `<layers image="breadboard/fritzkit-<slug>-<hash8>_breadboard.svg">` must
match byte for byte after Fritzing rewrites `svg.breadboard.X.svg` to `breadboard/X.svg`.

## Verified against Fritzing 1.0.7b (2026-10-31 spikes)

- `Fritzing.exe -svg <folder>` renders a self-contained `.fzz` (sketch + embedded part
  files, same entry naming as .fzpz) without importing the part first. Output is 1000
  units per inch and contains a `<g id="watermark">` (the Fritzing logo) that must be
  excluded when measuring the part's bounds; the part's `id="breadboard"` group and
  `connectorNpin` ids survive the export.
- An embedded base64 PNG `<image>` in the breadboard SVG survives the `-svg` export.
