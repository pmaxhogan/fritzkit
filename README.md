# fritzkit

[![ci](https://github.com/pmaxhogan/fritzkit/actions/workflows/ci.yml/badge.svg)](https://github.com/pmaxhogan/fritzkit/actions/workflows/ci.yml)
[![fzp-checker](https://github.com/pmaxhogan/fritzkit/actions/workflows/fzp-checker.yml/badge.svg)](https://github.com/pmaxhogan/fritzkit/actions/workflows/fzp-checker.yml)

fritzkit compiles a small JSON description of a board (`part.json`: outline in mm, every
pad and pin with its name, role and position, buses for shared nets) into a first-class
Fritzing part: breadboard, schematic, PCB and icon views that pass Fritzing's own part
checker, seat on the 0.1 in breadboard grid and keep their connector ids across versions so
placed parts can be swapped without losing wires. It ships as a CLI, an MCP server and a
Claude Code skill, so you can hand Claude a product link and get a `.fzpz` back in My Parts.
fritzkit itself is offline and deterministic; the agent does the reading and measuring.

## Install

```
npx fritzkit --help          # run without installing
npm i -g fritzkit            # or install the `fritzkit` command globally
```

Requirements:

- Node.js 22 or newer
- [Fritzing](https://fritzing.org/) 1.0.7 (to use the parts; `install` and `prune` manage its user parts folder)
- optional: [uv](https://docs.astral.sh/uv/) for `validate --checker`, which runs Fritzing's own part checker

`fritzkit doctor` checks all of these.

## 60-second quickstart

```
fritzkit init                                    # create the workspace (~/fritzkit/parts)
fritzkit new my-breakout --title "My breakout"   # <workspace>/my-breakout/part.json + assets/
# edit ~/fritzkit/parts/my-breakout/part.json   (see the reference below)
fritzkit validate my-breakout                    # schema + structural checks
fritzkit render my-breakout --png                # PNG of every view into my-breakout/build/
fritzkit export my-breakout                      # -> my-breakout/<moduleId>.fzpz
fritzkit install my-breakout                     # into Fritzing's My Parts (close Fritzing first)
```

Then start Fritzing; the part is in the **My Parts** bin.

## Use it from Claude Code

As a plugin (skill + MCP server in one step):

```
claude plugin marketplace add pmaxhogan/fritzkit
claude plugin install fritzkit@fritzkit
```

(Inside a session: `/plugin marketplace add pmaxhogan/fritzkit`, then
`/plugin install fritzkit@fritzkit`.)

Or just the MCP server:

```
claude mcp add --scope user fritzkit -- npx -y fritzkit mcp
```

and, for the workflow, copy `skills/fritzkit/` from this repo into `~/.claude/skills/fritzkit/`.

Then ask: "Make me a Fritzing part for https://www.amazon.com/dp/XXXXXXXXXX". The skill
tells Claude how to fetch the listing and images, measure the board, name every pad, write
`part.json`, check the render against the photo, and export/install the part.

## The agent workflow

1. Gather sources with the agent's own tools (listing via Amazon's mobile URL form, gallery
   images, datasheet PDFs, manufacturer wiki, Digikey page, or a KiCad footprint).
2. Determine the outline in mm from dimension callouts or a drawing, cross-checked.
3. Identify every pad: silkscreen name, role, net (buses), connector kind, position measured
   from the photo at a known px/mm.
4. Write `part.json`, `validate`, `render --png`, compare the render with the photo, fix,
   repeat.
5. `export`, then `install` (Fritzing closed) or hand over the `.fzpz`; `prune` old versions.
6. Report what was measured, what was estimated, and what the user should verify.

Long form: [docs/agent-workflow.md](docs/agent-workflow.md). The skill itself:
[skills/fritzkit/SKILL.md](skills/fritzkit/SKILL.md).

## part.json reference

Every field, type, default and the coordinate frame: [docs/part-json.md](docs/part-json.md).
The JSON Schema is printed by `fritzkit schema`. In short: lengths in mm, origin at the
top-left corner of the outline, x right, y down (like a top-down photo), positions are pad
centres.

Example, the [Seeed Studio XIAO ESP32-C6](https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/)
(top view, USB-C at the left edge, two rows of 7 castellated pads, GND pads tied by a bus):

```json
{
  "$schema": "https://raw.githubusercontent.com/pmaxhogan/fritzkit/main/src/core/schema/part.schema.json",
  "slug": "xiao-esp32-c6",
  "title": "Seeed Studio XIAO ESP32-C6",
  "label": "U",
  "description": "Thumb-sized ESP32-C6 board. Top view, USB-C at the left short edge.",
  "sources": ["https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/"],
  "properties": { "mpn": "XIAO ESP32C6", "type": "module" },
  "outline": { "widthMm": 21, "heightMm": 17.8, "shape": "rounded", "cornerRadiusMm": 1 },
  "artwork": {
    "boardColor": "#1A1A1A",
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
      }
    ]
  },
  "headers": [
    {
      "key": "top",
      "kind": "castellated",
      "cols": 7,
      "xMm": 2.88,
      "yMm": 1.28,
      "pins": [
        { "key": "5v", "name": "5V", "role": "power" },
        { "key": "gnd", "name": "GND", "role": "gnd" },
        { "key": "3v3", "name": "3V3", "role": "power" },
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
      "xMm": 2.88,
      "yMm": 16.52,
      "pins": [
        { "key": "d0", "name": "D0" },
        { "key": "d1", "name": "D1" },
        { "key": "d2", "name": "D2" },
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
      "type": "pad",
      "role": "gnd",
      "xMm": 15.6,
      "yMm": 5,
      "pad": { "shape": "rect", "wMm": 1.6, "hMm": 1.2, "smd": true },
      "description": "Battery minus, back side (position estimated)"
    }
  ],
  "buses": [{ "id": "GND", "pins": ["gnd", "bat-"] }]
}
```

More examples (an ESC with wire leads, a relay module, a KiCad import):
[skills/fritzkit/reference/examples.md](skills/fritzkit/reference/examples.md).

## CLI reference

```
fritzkit [--workspace <dir>] [--json] <command>
```

`<part>` is a slug in the workspace (default `~/fritzkit/parts`, or `FRITZKIT_WORKSPACE`) or
a path to a part folder (`validate` and `render` also accept a `.fzpz`). `--json` prints machine-readable output.

| command                                              | what it does                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                                               | create the workspace folder                                                                                                               |
| `new <slug> [--title <t>]`                           | create `<workspace>/<slug>/part.json` (a placeholder spec) and `assets/`                                                                  |
| `list`                                               | list the parts in the workspace                                                                                                           |
| `validate <part> [--checker]`                        | schema and structural checks; `--checker` also runs Fritzing's part checker via uv                                                        |
| `render <part> [--view <v>] [--out <dir>] [--png]`   | write `<view>.svg` for one view or all four (breadboard, schematic, pcb, icon) into `<part>/build/`; `--png` adds `<view>.png` at 300 dpi |
| `export <part> [--out <file>] [--install] [--force]` | build the `.fzpz` (next to part.json by default); refuses on validator errors unless `--force`; `--install` also installs it              |
| `install <part> [--out <file>] [--force]`            | same as `export --install`; refuses while Fritzing is running                                                                             |
| `prune <family-or-slug> [--keep <moduleId>] [--yes]` | list older installed versions of a family (dry run); `--yes` deletes them, keeping the newest                                             |
| `doctor`                                             | check Node, uv, the Fritzing install and its parts folder, sharp                                                                          |
| `schema [--out <file>]`                              | print or write the part.json JSON Schema                                                                                                  |
| `import-kicad <file> --slug <slug>`                  | create a part from a `.kicad_mod` footprint with exact pad geometry                                                                       |
| `mcp`                                                | run the MCP server on stdio                                                                                                               |
| `ui [part] [--port <n>]`                             | local web editor for part.json with live previews (coming in a later release)                                                             |

Exit codes: 0 ok, 1 error, 2 not implemented yet (`ui`), 3 Fritzing is running (install/prune).

## MCP tools

Run with `npx -y fritzkit mcp` (stdio). Same core as the CLI.

| tool                      | purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `fritzkit_init_workspace` | create the workspace                                           |
| `fritzkit_list_parts`     | list parts                                                     |
| `fritzkit_new_part`       | create a part folder with a placeholder spec                   |
| `fritzkit_get_part`       | read a part's part.json                                        |
| `fritzkit_set_part`       | replace part.json with a whole spec                            |
| `fritzkit_patch_part`     | apply JSON-patch operations to part.json                       |
| `fritzkit_add_pins`       | append pins                                                    |
| `fritzkit_validate`       | schema + structural checks (optionally the Fritzing checker)   |
| `fritzkit_render`         | render a view as SVG text or a PNG image the agent can look at |
| `fritzkit_export`         | build the `.fzpz`                                              |
| `fritzkit_install`        | install into Fritzing's user parts folder (Fritzing closed)    |
| `fritzkit_prune`          | remove old installed versions of a family                      |
| `fritzkit_import_kicad`   | create a part from a `.kicad_mod`                              |
| `fritzkit_schema`         | the part.json JSON Schema                                      |
| `fritzkit_doctor`         | environment check                                              |

## FAQ

**Why does every export get a new moduleId?** Fritzing refuses to import a part whose
moduleId it already has ("Part module ID must be unique"). The moduleId is
`fritzkit-<slug>-<hash8>`, where the hash covers part.json and the assets, so every change
imports cleanly. Use `fritzkit prune <family> --yes` to remove the old versions.

**How do I swap a placed part for a newer version?** All versions share a family (the slug)
and differ in the variant (`v<version> <hash8>`). Select the part in a sketch and pick the
newer variant in the Inspector. Connector ids come from the persistent `pinIds` map in
part.json, so pins that still exist keep their ids and wires stay attached.

**Why must Fritzing be closed for `install`?** Fritzing scans its user parts folder only at
startup, so a part copied in while it runs would not show up (and it may write the same
files). `install` and `prune` refuse while Fritzing is running and say why.

**Where are parts installed?** Into Fritzing's user parts folder, one folder per moduleId:
`%APPDATA%\Fritzing\Fritzing\local_parts\user\<moduleId>\` on Windows,
`~/Library/Application Support/Fritzing/Fritzing/local_parts/user/` on macOS,
`~/.local/share/Fritzing/Fritzing/local_parts/user/` on Linux. This is the same layout
Fritzing's own File > Open import writes; the part shows up in My Parts at the next start.

**Should I use the photo artwork style?** Usually not. The default vector style looks like
Fritzing's own parts, stays sharp, is small and survives Fritzing's Parts Editor. The photo
style (`artwork.style: "photo"`) embeds the listing photo with vector pads on top; Fritzing's
Parts Editor drops embedded rasters if you edit the part, it pixelates when zoomed, and
Gerber export strips images (the PCB view is always vector).

**Can it do the PCB view?** Yes: a real footprint from the pad table (through-hole pads on
both copper layers with their drill size, SMD and castellated pads on top copper, the
outline on silkscreen). Positions are only as good as the measurements in part.json, so
verify against a datasheet drawing or calipers before fabricating a board.

## Development

```
npm ci
npm test                 # vitest with coverage
npm run lint             # eslint
npm run format:check     # prettier
npm run check-ascii      # every tracked file must be ASCII
npm run build            # tsc to dist/
npm run fritzkit -- <args>   # run the CLI from source
```

`tools/fzp-checker/` vendors Fritzing's `fzp_checker` (from fritzing-parts 1.0.7) for CI:
`uv run --project tools/fzp-checker check-fzp <file.fzpz>`. `npm run e2e` is a local-only
acceptance harness that drives a real Fritzing install; it needs a desktop session with
Fritzing 1.0.7 installed and is not run in CI. `.mcp.json` points Claude Code at the MCP
server from source when you work in this repo. Keep its server name `fritzkit`: the plugin
manifest declares a server with the same name, which replaces the dev entry when the plugin
is installed, so installers run `npx -y fritzkit mcp` and never the source checkout.

## License

fritzkit itself is MIT (see [LICENSE](LICENSE)). Parts generated with fritzkit are
released under CC-BY-SA 3.0, the license of Fritzing's own parts library.
