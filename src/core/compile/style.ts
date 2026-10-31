/**
 * Fritzing house style (graphic standards + core templates). Keep every colour and
 * dimension here so the renderers stay consistent and a style change is one edit.
 * Dimensions in mils unless the name says Mm.
 */
export const STYLE = {
  // Breadboard view
  legColor: "#8C8C8C",
  legWidthMil: 30,
  contactColor: "#9A916C",
  padHoleColor: "#000000",
  labelColor: "#E6E6E6",
  labelFontSizeMil: 50, // ~5 pt at 1 mil units (Fritzing labels are 5 pt light grey)
  silkFontSizeMil: 45,
  male: {
    body: "#404040",
    pinSquare: "#8D8C8C",
    center: "#8C8663",
    bevelTop: "#B8AF82",
    bevelRight: "#80795B",
    bevelBottom: "#5E5B43",
    bevelLeft: "#9A916C",
  },
  female: {
    body: "#404040",
    hole: "#000000",
    bevelTop: "#2A2A29",
    bevelRight: "#474747",
    bevelBottom: "#595959",
    bevelLeft: "#373737",
  },
  // Schematic view
  schematic: {
    body: "#000000",
    bodyFill: "#FFFFFF",
    bodyStrokeMil: 9.7,
    pin: "#555555",
    pinStrokeMil: 9.7,
    pinLengthMil: 100,
    fontSizeMil: 49, // pin labels
    titleFontSizeMil: 59,
    gridMil: 100,
  },
  // PCB view
  pcb: {
    copper: "#F7BD13",
    silkscreen: "#000000",
    silkStrokeMil: 8,
    minRingMil: 20,
    minHoleMil: 40,
  },
  // Terminal rect (must have non-zero size or Fritzing ignores it)
  terminalSizeMil: 1,
} as const;

/** Default pin colours by role for the vector style breadboard pin labels. */
export const ROLE_COLORS: Record<string, string> = {
  power: "#D9534F",
  gnd: "#333333",
  io: "#E6E6E6",
  analog: "#E6E6E6",
  pwm: "#E6E6E6",
  i2c: "#E6E6E6",
  spi: "#E6E6E6",
  uart: "#E6E6E6",
  usb: "#E6E6E6",
  clock: "#E6E6E6",
  reset: "#E6E6E6",
  enable: "#E6E6E6",
  nc: "#777777",
  other: "#E6E6E6",
};
