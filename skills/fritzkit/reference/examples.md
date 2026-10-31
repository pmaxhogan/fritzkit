# fritzkit worked examples

Each example is a complete, valid `part.json` that compiles to a checker-clean `.fzpz`.
Field reference: [part-json.md](part-json.md). The XIAO ESP32-C6 example is in
[../SKILL.md](../SKILL.md).

## Brushless ESC with wire leads

A board with no pins at all, only flying wires: battery leads on one side, three motor
phases on the other, a thin servo cable underneath. Each wire is a `leads` entry; the
connector is the free end, which plugs into a breadboard. The two ground wires (thick
battery minus and the servo cable's ground) are the same net, so they are one bus. The
motor phases are NOT bused: they are three separate outputs.

```json
{
  "slug": "esc-30a-example",
  "title": "30A brushless ESC (wire leads)",
  "description": "Top view. Battery leads leave the left edge, motor phases the right edge, servo cable the bottom edge.",
  "label": "A",
  "outline": { "widthMm": 45, "heightMm": 24, "shape": "rounded", "cornerRadiusMm": 2 },
  "artwork": {
    "boardColor": "#1F4FA0",
    "silkscreen": [{ "kind": "text", "text": "30A ESC", "xMm": 22.5, "yMm": 12, "sizeMm": 2.5 }]
  },
  "leads": [
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
    },
    {
      "key": "gnd",
      "name": "GND",
      "role": "gnd",
      "color": "#000000",
      "gaugeMm": 2.2,
      "fromXMm": 0,
      "fromYMm": 18,
      "direction": "left",
      "lengthMm": 40
    },
    {
      "key": "ma",
      "name": "A",
      "role": "other",
      "color": "#202020",
      "fromXMm": 45,
      "fromYMm": 5,
      "direction": "right",
      "lengthMm": 30,
      "description": "motor phase A"
    },
    {
      "key": "mb",
      "name": "B",
      "role": "other",
      "color": "#202020",
      "fromXMm": 45,
      "fromYMm": 12,
      "direction": "right",
      "lengthMm": 30,
      "description": "motor phase B"
    },
    {
      "key": "mc",
      "name": "C",
      "role": "other",
      "color": "#202020",
      "fromXMm": 45,
      "fromYMm": 19,
      "direction": "right",
      "lengthMm": 30,
      "description": "motor phase C"
    },
    {
      "key": "sig",
      "name": "SIG",
      "role": "pwm",
      "color": "#F0F0F0",
      "gaugeMm": 0.8,
      "fromXMm": 10,
      "fromYMm": 24,
      "direction": "down",
      "lengthMm": 30,
      "description": "servo PWM input"
    },
    {
      "key": "sgnd",
      "name": "SIG GND",
      "label": "-",
      "role": "gnd",
      "color": "#5A3A1A",
      "gaugeMm": 0.8,
      "fromXMm": 12,
      "fromYMm": 24,
      "direction": "down",
      "lengthMm": 30
    }
  ],
  "buses": [{ "id": "GND", "pins": ["gnd", "sgnd"] }]
}
```

Notes: if the ESC's servo cable also has a BEC `+5V` wire, add it as a third thin lead with
`role: "power"`; do not bus it with VBAT (a regulator sits between them).

## 1-channel 5 V relay module

A 3-pin 0.1 in input header on the left (a `headers` entry, vertical column) and a 3-way
screw terminal on the right (three `pins` with big holes, `type: "female"`, because the
terminal pitch is 5 mm and the terminal accepts wires). Mounting holes go in
`outline.holes`.

```json
{
  "slug": "relay-1ch-5v-example",
  "title": "1-channel 5V relay module",
  "description": "Top view. Input header on the left edge, screw terminal on the right edge.",
  "label": "K",
  "outline": {
    "widthMm": 50,
    "heightMm": 26,
    "shape": "rect",
    "holes": [
      { "xMm": 3, "yMm": 3, "dMm": 3 },
      { "xMm": 47, "yMm": 3, "dMm": 3 }
    ]
  },
  "artwork": {
    "boardColor": "#1B4F9C",
    "components": [
      {
        "kind": "rect",
        "xMm": 16,
        "yMm": 5,
        "wMm": 19,
        "hMm": 15.5,
        "color": "#2060D0",
        "note": "relay can"
      }
    ]
  },
  "headers": [
    {
      "key": "in",
      "kind": "male",
      "cols": 3,
      "orientation": "vertical",
      "xMm": 2.5,
      "yMm": 10.46,
      "pins": [
        { "key": "vcc", "name": "VCC", "role": "power" },
        { "key": "gnd", "name": "GND", "role": "gnd" },
        { "key": "in1", "name": "IN", "role": "io", "description": "relay driver input" }
      ]
    }
  ],
  "pins": [
    {
      "key": "no",
      "name": "NO",
      "type": "female",
      "role": "other",
      "xMm": 46,
      "yMm": 8,
      "pad": { "shape": "round", "wMm": 3, "hMm": 3, "holeMm": 1.3 },
      "description": "screw terminal: normally open"
    },
    {
      "key": "com",
      "name": "COM",
      "type": "female",
      "role": "other",
      "xMm": 46,
      "yMm": 13,
      "pad": { "shape": "round", "wMm": 3, "hMm": 3, "holeMm": 1.3 },
      "description": "screw terminal: common"
    },
    {
      "key": "nc",
      "name": "NC",
      "type": "female",
      "role": "other",
      "xMm": 46,
      "yMm": 18,
      "pad": { "shape": "round", "wMm": 3, "hMm": 3, "holeMm": 1.3 },
      "description": "screw terminal: normally closed"
    }
  ]
}
```

Notes: NO, COM and NC are three different nets; no bus. Modules with an extra `JD-VCC`
jumper header get those pins as a second header; bus `VCC` with `JD-VCC` only if the jumper
is a fixed trace, not a removable jumper.

## Starting from a KiCad footprint

When a `.kicad_mod` exists (manufacturer download, SnapEDA, KiCad library):

```
fritzkit import-kicad path/to/Module.kicad_mod --slug my-module
```

This writes a part with exact pad positions and sizes (through-hole pads -> `type: "female"`
with `holeMm`; SMD pads -> `type: "pad"`, `smd: true`; non-plated holes -> `outline.holes`;
pads that share a KiCad number -> tied by a bus). The outline comes from the board edge,
courtyard, fab layer or the pad bounding box, in that order. Pads on a 2.54 mm grid stay as
individual pins (exact geometry), they are not converted to headers.

What you still do: replace the KiCad pad numbers in `name` with the real signal names from
the datasheet, set every `role`, add buses for pads that share a net but have different
KiCad numbers, set `title`, `description`, `sources` and artwork, then validate and render
as usual. Check the orientation: KiCad footprints are drawn from the top, y down, the same
frame as fritzkit.
