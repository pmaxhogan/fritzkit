/**
 * Human-readable explanations: for fritzkit's own structural issues and for the most
 * common messages printed by Fritzing's vendored part checker (paraphrasing
 * tools/fzp-checker/vendor/scripts/checks/explain_errors.md).
 */
import type { Issue } from "./structural.js";

const CODE_HELP: Record<string, string> = {
  "module-id": "The moduleId identifies the part inside Fritzing and names its folder.",
  "zip-entries": "The .fzpz zip must be flat and hold exactly the files the fzp references.",
  "required-tags": "Fritzing expects title, label, date, author, version and a family property.",
  "layer-ids": "Each layer the fzp lists must be a <g id=...> group in that view's SVG.",
  "connector-refs": "Each connector's svgId/terminalId/legId must name an element in the SVG.",
  "connector-numbering": "Connector ids are connector0, connector1, ... and must be unique.",
  buses: "A bus ties connectors that are the same electrical node (e.g. two GND pins).",
  "svg-root": "SVG sizes must be physical (in/mm) with a viewBox, or Fritzing guesses the dpi.",
  "svg-style": "Fritzing's renderer supports only a small subset of SVG and CSS.",
  "svg-ids": "SVG ids must be unique; Fritzing finds connectors and layers by id.",
  "copper-only": "Copper layers become real copper on a fabricated board.",
  "pcb-layers": "THT pads live on both copper layers; SMD pads on copper1 only.",
  spice: "The <spice> block is substituted per instance when simulating.",
  "fzp-xml": "The fzp file could not be parsed as XML.",
  "svg-xml": "An SVG file could not be parsed as XML.",
  "spec-schema": "part.json does not match the fritzkit part schema.",
};

/** One or two lines of text for an issue: what is wrong, why it matters, how to fix it. */
export function explain(issue: Issue): string {
  const head = `${issue.level === "error" ? "Error" : "Warning"} [${issue.code}]: ${issue.message}`;
  const where = issue.where ? ` (in ${issue.where})` : "";
  const why = CODE_HELP[issue.code];
  const lines = [head + where];
  if (why) lines.push(`  Why: ${why}`);
  if (issue.fix) lines.push(`  Fix: ${issue.fix}`);
  return lines.join("\n");
}

const CHECKER_FIXES: { match: RegExp; fix: string }[] = [
  {
    match: /Missing viewBox/i,
    fix: "Add viewBox, width and height to the SVG root; give width/height in in or mm.",
  },
  {
    match: /Invalid viewBox/i,
    fix: 'Use viewBox="0 0 <w> <h>" with four numbers (fritzkit: 1 unit = 1 mil).',
  },
  {
    match: /Invisible connector|invisible/i,
    fix: "Give the connector element a fill or stroke, or mark the connector hybrid in the fzp.",
  },
  {
    match: /Duplicate id attribute/i,
    fix: "Make SVG ids unique; for PCB nest copper0 inside copper1 and share one pad element.",
  },
  {
    match: /terminal/i,
    fix: "Make the terminal element visible with non-zero size, or drop terminalId (Fritzing 1.0.3+ picks the connector centre).",
  },
  {
    match: /style/i,
    fix: "Replace style= with XML attributes (fill, stroke, stroke-width ...); Fritzing converts only a few CSS properties.",
  },
  {
    match: /has an empty value/i,
    fix: "Give the property a value or remove it; empty properties do nothing in the Inspector.",
  },
  {
    match: /Layer ID '([^']*)' from (\w+) not found/i,
    fix: "Wrap that view's artwork in a <g> whose id is the layer id; for the icon, use a separate cropped icon SVG.",
  },
  {
    match: /not referenced in (any )?FZP/i,
    fix: "Declare the connector in the fzp for that view, or remove/rename the stray SVG element.",
  },
  {
    match: /Missing required tag: (\w+)/i,
    fix: "Add the missing element to the fzp (title, label, date, author, version ...).",
  },
  {
    match: /Date format/i,
    fix: "Write <date> as YYYY-MM-DD.",
  },
  {
    match: /fritzingVersion/i,
    fix: 'Set fritzingVersion="1.0.7" on <module> after re-checking the part with a current Fritzing.',
  },
  {
    match: /Invalid font family/i,
    fix: 'Use font-family="Noto Sans" (or "OCR-Fritzing-mono" for PCB silkscreen).',
  },
  {
    match: /gorn attribute/i,
    fix: "Delete every gorn= attribute; they are written by Fritzing's editor and must not ship.",
  },
  {
    match: /not inside a valid Fritzing layer group/i,
    fix: 'Put every drawn element inside the view\'s layer group, e.g. <g id="breadboard">.',
  },
  {
    match: /does not reference an element in layer/i,
    fix: "Add the connector's svgId element to that layer group in the SVG.",
  },
  {
    match: /not found in \w+ SVG/i,
    fix: "The fzp names an svgId that the SVG lacks; add the element or fix the id.",
  },
  {
    match:
      /Non-standard copper color|Invalid color '.*' found in copper|Invalid stroke for connector/i,
    fix: 'Draw copper with stroke/fill "#F7BD13".',
  },
  {
    match: /ModuleID contains/i,
    fix: "Keep the moduleId to letters, digits, '_', '.' and '-'.",
  },
  {
    match: /Connector mismatch/i,
    fix: "A numeric connector name does not match its connectorN id; harmless when pins were removed (fritzkit never reuses ids, D12a), otherwise rename the pin.",
  },
  {
    match: /layer nested inside/i,
    fix: "Only copper0 may sit inside copper1; move other layer groups to the top level of the SVG.",
  },
  {
    match: /ModuleID .*too short|'ModuleID' is undefined/i,
    fix: "Give <module> a moduleId of at least 8 filename-safe characters.",
  },
  {
    match: /No font (family|size) found|Invalid font size/i,
    fix: 'Give every <text> font-family="Noto Sans" and a unitless font-size attribute.',
  },
];

/** A short fix for a checker output line, or undefined when the message is not known. */
export function explainCheckerLine(line: string): string | undefined {
  // parseCheckerOutput prefixes svg issues with "<file>.svg: " and some messages end in
  // " File: <path>"; a slug such as "terminal-block" must not steer the match.
  const msg = line.replace(/^\S+\.svg: /, "").replace(/ File: .*$/, "");
  for (const { match, fix } of CHECKER_FIXES) if (match.test(msg)) return fix;
  return undefined;
}
