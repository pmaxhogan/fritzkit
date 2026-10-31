/**
 * part.json schema (zod). This is the single source of truth for the spec format; the
 * published JSON Schema at src/core/schema/part.schema.json is generated from it
 * (npm run gen-schema) and a test asserts the two stay in sync.
 *
 * Units: every length in the spec is millimetres. The compiler converts to mils
 * (1 viewBox unit = 1 mil) when it emits SVG.
 *
 * Frame: the part's own coordinate system has its origin at the TOP-LEFT corner of
 * the outline, x to the right (along widthMm) and y DOWN (along heightMm), i.e. the
 * same orientation as a top-down reference photo. Pins may lie outside the outline
 * (leads, overhanging headers); the compiler grows the canvas to fit them.
 */
import { z } from "zod";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const mm = z.number().finite();
const posMm = z.number().finite().positive();
const color = z.string().regex(COLOR_RE, "hex colour like #1B7F3B");
const key = z.string().regex(KEY_RE, "pin key: letters, digits, _ . + -");

/** fzp connector type. female = a wire or plug attaches; male = a pin that plugs in. */
export const ConnectorType = z.enum(["male", "female", "pad", "wire"]);
export type ConnectorType = z.infer<typeof ConnectorType>;

/** Electrical role; drives schematic grouping (D9) and default colours. */
export const PinRole = z.enum([
  "power",
  "gnd",
  "io",
  "analog",
  "pwm",
  "i2c",
  "spi",
  "uart",
  "usb",
  "clock",
  "reset",
  "enable",
  "nc",
  "other",
]);
export type PinRole = z.infer<typeof PinRole>;

export const PadShape = z.enum(["rect", "round", "oval"]);
export type PadShape = z.infer<typeof PadShape>;

/** Copper geometry of one pad. holeMm absent or 0 = no hole (SMD, copper1 only). */
export const PadGeometry = z
  .object({
    shape: PadShape.default("rect"),
    wMm: posMm,
    hMm: posMm,
    holeMm: z.number().finite().nonnegative().optional(),
    /** Force SMD (copper1 only, no drill) even if holeMm is set. */
    smd: z.boolean().optional(),
  })
  .strict();
export type PadGeometry = z.infer<typeof PadGeometry>;

const pinCommon = {
  /** Stable key; connector numbers are allocated per key in pinIds and never reused. */
  key,
  /** Connector name shown in Fritzing (hover + Inspector), e.g. "GND", "0V", "D7". */
  name: z.string().min(1).max(40),
  /** Short silkscreen label drawn next to the pin; defaults to name. */
  label: z.string().max(16).optional(),
  description: z.string().max(400).optional(),
  role: PinRole.default("io"),
};

/** A free-standing pin or solder pad at an arbitrary position (centre in mm). */
export const Pin = z
  .object({
    ...pinCommon,
    type: ConnectorType.default("female"),
    xMm: mm,
    yMm: mm,
    pad: PadGeometry.default({ shape: "rect", wMm: 2, hMm: 2, holeMm: 1 }),
    /** UI hint only: snap this pin to the 0.1 in grid when dragging. */
    snap: z.boolean().optional(),
  })
  .strict();
export type Pin = z.infer<typeof Pin>;

/** One pin inside a header; its position comes from the header grid. */
export const HeaderPin = z.object({ ...pinCommon }).strict();
export type HeaderPin = z.infer<typeof HeaderPin>;

/**
 * A row/grid of 0.1 in (or other pitch) pins drawn in Fritzing's house style.
 * xMm/yMm is the centre of the FIRST pin (row 0, col 0). Pins are listed row-major:
 * row 0 col 0, row 0 col 1, ... A null entry leaves that position empty.
 * The compiler places header pins exactly on multiples of 100 mil relative to the
 * canvas origin so the part seats in a breadboard.
 */
export const Header = z
  .object({
    key,
    /** male/female = through-hole header pins; castellated = SMD edge pads. */
    kind: z.enum(["male", "female", "castellated"]).default("male"),
    pitchMm: posMm.default(2.54),
    rows: z.number().int().min(1).max(8).default(1),
    cols: z.number().int().min(1).max(64),
    xMm: mm,
    yMm: mm,
    /** horizontal: cols run along +x, rows along +y. vertical: cols run along +y, rows along +x. */
    orientation: z.enum(["horizontal", "vertical"]).default("horizontal"),
    pins: z.array(HeaderPin.nullable()),
    /** Copper geometry override (default: 1.6 mm round pad, 1.0 mm hole; castellated: 1.6 x 2.4 mm SMD). */
    pad: PadGeometry.optional(),
  })
  .strict()
  .refine((h) => h.pins.length === h.rows * h.cols, {
    message: "header.pins must have exactly rows*cols entries (use null for gaps)",
    path: ["pins"],
  });
export type Header = z.infer<typeof Header>;

/**
 * A flying wire lead. Drawn as a bendable leg (fzp legId line) from (fromXMm, fromYMm)
 * on the board, lengthMm long in direction, with the connector at the free end.
 */
export const Lead = z
  .object({
    ...pinCommon,
    color: color.default("#000000"),
    lengthMm: posMm.default(40),
    fromXMm: mm,
    fromYMm: mm,
    direction: z.enum(["left", "right", "up", "down"]).default("left"),
    /** Wire outer diameter for drawing. */
    gaugeMm: posMm.default(1.6),
  })
  .strict();
export type Lead = z.infer<typeof Lead>;

export const Outline = z
  .object({
    widthMm: posMm,
    heightMm: posMm,
    shape: z.enum(["rect", "rounded", "custom"]).default("rounded"),
    cornerRadiusMm: z.number().finite().nonnegative().default(1),
    /** For shape "custom": an SVG path in mm in the part frame. */
    pathMm: z.string().optional(),
    /** Mounting holes drawn in breadboard/pcb views (not connectors). */
    holes: z.array(z.object({ xMm: mm, yMm: mm, dMm: posMm }).strict()).default([]),
  })
  .strict();
export type Outline = z.infer<typeof Outline>;

/** Decorative items drawn on the breadboard view (vector style). */
export const SilkItem = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1).max(80),
      xMm: mm,
      yMm: mm,
      sizeMm: posMm.default(1.2),
      color: color.default("#FFFFFF"),
      anchor: z.enum(["start", "middle", "end"]).default("middle"),
      rotate: z.number().finite().default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rect"),
      xMm: mm,
      yMm: mm,
      wMm: posMm,
      hMm: posMm,
      color: color.default("#222222"),
      rxMm: z.number().finite().nonnegative().default(0),
      /** Free-form note, e.g. "TO-252 MOSFET". Not rendered. */
      note: z.string().max(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("circle"),
      xMm: mm,
      yMm: mm,
      dMm: posMm,
      color: color.default("#222222"),
      note: z.string().max(120).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("line"),
      x1Mm: mm,
      y1Mm: mm,
      x2Mm: mm,
      y2Mm: mm,
      widthMm: posMm.default(0.2),
      color: color.default("#FFFFFF"),
    })
    .strict(),
]);
export type SilkItem = z.infer<typeof SilkItem>;

export const Photo = z
  .object({
    /** Path relative to the part folder, e.g. "assets/top.png". */
    src: z.string().min(1),
    /** Crop rectangle in source pixels [x, y, w, h], applied before rotation. */
    crop: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    /** Key out a near-white listing background (sharp flood fill from the corners). */
    removeBackground: z.boolean().default(true),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();
export type Photo = z.infer<typeof Photo>;

export const Artwork = z
  .object({
    /** vector (default, house style) or photo (embedded raster with vector pads on top). */
    style: z.enum(["vector", "photo"]).default("vector"),
    boardColor: color.default("#1B7F3B"),
    silkColor: color.default("#FFFFFF"),
    silkscreen: z.array(SilkItem).default([]),
    components: z.array(SilkItem).default([]),
    photo: Photo.optional(),
  })
  .strict();
export type Artwork = z.infer<typeof Artwork>;

export const Bus = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    pins: z.array(key).min(2),
  })
  .strict();
export type Bus = z.infer<typeof Bus>;

/** Passed through to the fzp <spice> block. Tokens: {instanceTitle}, {net connectorN}, {<property>}. */
export const Spice = z
  .object({
    model: z.string().optional(),
    lines: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Spice = z.infer<typeof Spice>;

export const SchematicOptions = z
  .object({
    layout: z.enum(["by-role"]).default("by-role"),
    /** Override which side each role lands on (default: power top/left, gnd bottom, io right). */
    sides: z
      .object({
        left: z.array(PinRole).optional(),
        right: z.array(PinRole).optional(),
        top: z.array(PinRole).optional(),
        bottom: z.array(PinRole).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SchematicOptions = z.infer<typeof SchematicOptions>;

export const PcbOptions = z
  .object({
    /** auto: per pad (hole => THT); tht / smd force every pad. */
    mode: z.enum(["auto", "tht", "smd"]).default("auto"),
    silkscreenOutline: z.boolean().default(true),
  })
  .strict();
export type PcbOptions = z.infer<typeof PcbOptions>;

export const PartSpec = z
  .object({
    $schema: z.string().optional(),
    slug: z.string().min(3).max(60).regex(SLUG_RE, "lowercase slug, e.g. xiao-esp32-c6"),
    title: z.string().min(1).max(120),
    /** Bumped by hand when the part changes materially; shown as variant "v<n> <hash8>". */
    version: z.number().int().min(1).default(1),
    /** Fritzing family (Inspector swap group). Defaults to slug. */
    family: z.string().min(1).max(60).optional(),
    /** Reference designator prefix: A for modules, U for ICs, J for connectors. */
    label: z.string().min(1).max(4).default("A"),
    author: z.string().max(80).default("fritzkit"),
    tags: z.array(z.string().min(1).max(30)).default([]),
    description: z.string().max(4000).default(""),
    /** Source URLs (listing, datasheet) appended to the description. */
    sources: z.array(z.string().url()).default([]),
    /** Extra fzp properties (mpn, type, voltage ...). Shown in the Inspector. */
    properties: z.record(z.string().min(1), z.string().min(1)).default({}),
    outline: Outline,
    artwork: Artwork.prefault({}),
    pins: z.array(Pin).default([]),
    headers: z.array(Header).default([]),
    leads: z.array(Lead).default([]),
    /** Persistent pin key -> connector number map (decision D12a). Managed by fritzkit. */
    pinIds: z.record(key, z.number().int().nonnegative()).default({}),
    buses: z.array(Bus).default([]),
    spice: Spice.optional(),
    schematic: SchematicOptions.prefault({}),
    pcb: PcbOptions.prefault({}),
  })
  .strict();
export type PartSpec = z.infer<typeof PartSpec>;
/** The spec as written on disk (before defaults are applied). */
export type PartSpecInput = z.input<typeof PartSpec>;

/** Parse and apply defaults. Throws ZodError on invalid input. */
export function parsePartSpec(input: unknown): PartSpec {
  return PartSpec.parse(input);
}

export function safeParsePartSpec(input: unknown) {
  return PartSpec.safeParse(input);
}
