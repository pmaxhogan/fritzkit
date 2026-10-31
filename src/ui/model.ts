/**
 * Pure edits on the part.json object the app holds (the raw spec, as written on disk:
 * defaults NOT applied, so saving never bloats the file with default values).
 * Every function returns a new object; the input is never mutated.
 */
import type { ResolvedConnector } from "../core/resolve.js";
import type { PartSpecInput } from "../core/schema/part.js";
import { round2 } from "./calib.js";

export type Raw = PartSpecInput;
export type RawPin = NonNullable<Raw["pins"]>[number];
export type RawHeader = NonNullable<Raw["headers"]>[number];
export type RawLead = NonNullable<Raw["leads"]>[number];
export type RawBus = NonNullable<Raw["buses"]>[number];
export type RawSilk = NonNullable<NonNullable<Raw["artwork"]>["silkscreen"]>[number];
export type RawPhoto = NonNullable<NonNullable<Raw["artwork"]>["photo"]>;

/** Deep copy (part.json is plain JSON). */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** What a canvas marker drags: the pin itself, its whole header, or the lead's from-point. */
export type Owner =
  | { kind: "pin"; index: number }
  | { kind: "header"; index: number }
  | { kind: "lead"; index: number };

/** Find the spec item that owns a connector key. */
export function ownerOf(raw: Raw, key: string): Owner | undefined {
  const pins = raw.pins ?? [];
  const pi = pins.findIndex((p) => p.key === key);
  if (pi >= 0) return { kind: "pin", index: pi };
  const headers = raw.headers ?? [];
  const hi = headers.findIndex((h) => h.pins.some((p) => p?.key === key));
  if (hi >= 0) return { kind: "header", index: hi };
  const li = (raw.leads ?? []).findIndex((l) => l.key === key);
  if (li >= 0) return { kind: "lead", index: li };
  return undefined;
}

/** The anchor point an owner moves by (pin centre, first header pin, lead from-point). */
export function anchorOf(raw: Raw, o: Owner): { x: number; y: number } {
  if (o.kind === "pin") {
    const p = raw.pins![o.index]!;
    return { x: p.xMm, y: p.yMm };
  }
  if (o.kind === "header") {
    const h = raw.headers![o.index]!;
    return { x: h.xMm, y: h.yMm };
  }
  const l = raw.leads![o.index]!;
  return { x: l.fromXMm, y: l.fromYMm };
}

/** Move an owner's anchor to (x, y) mm (rounded to 0.01 mm). */
export function moveOwner(raw: Raw, o: Owner, x: number, y: number): Raw {
  const next = clone(raw);
  const xr = round2(x);
  const yr = round2(y);
  if (o.kind === "pin") {
    const p = next.pins![o.index]!;
    p.xMm = xr;
    p.yMm = yr;
  } else if (o.kind === "header") {
    const h = next.headers![o.index]!;
    h.xMm = xr;
    h.yMm = yr;
  } else {
    const l = next.leads![o.index]!;
    l.fromXMm = xr;
    l.fromYMm = yr;
  }
  return next;
}

/** Whether a pin asks to be snapped while dragging (pin.snap UI hint). */
export function ownerSnaps(raw: Raw, o: Owner): boolean {
  return o.kind === "pin" ? raw.pins![o.index]!.snap === true : false;
}

export function updatePin(raw: Raw, index: number, patch: Partial<RawPin>): Raw {
  const next = clone(raw);
  const pin = { ...next.pins![index]!, ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(pin)) {
    if (v === undefined || (v === "" && (k === "label" || k === "description"))) delete pin[k];
  }
  next.pins![index] = pin as RawPin;
  return next;
}

/** Every connector key in the spec (pins, header pins, leads). */
export function allKeys(raw: Raw): string[] {
  const keys: string[] = [];
  for (const p of raw.pins ?? []) keys.push(p.key);
  for (const h of raw.headers ?? []) for (const p of h.pins) if (p) keys.push(p.key);
  for (const l of raw.leads ?? []) keys.push(l.key);
  return keys;
}

/** A free key like "P3" that no connector uses yet. */
export function freeKey(raw: Raw, prefix = "P"): string {
  const used = new Set(allKeys(raw));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function addPin(raw: Raw, key: string, at: { x: number; y: number }): Raw {
  const next = clone(raw);
  next.pins = [
    ...(next.pins ?? []),
    { key, name: key, type: "female", role: "io", xMm: round2(at.x), yMm: round2(at.y) },
  ];
  return next;
}

/** Remove a pin and drop its key from every bus (buses left with < 2 pins are removed). */
export function removePin(raw: Raw, index: number): Raw {
  const next = clone(raw);
  const [gone] = next.pins!.splice(index, 1);
  if (gone) return dropKeyFromBuses(next, gone.key);
  return next;
}

export function dropKeyFromBuses(raw: Raw, key: string): Raw {
  if (!raw.buses) return raw;
  const next = clone(raw);
  next.buses = next
    .buses!.map((b) => ({ ...b, pins: b.pins.filter((k) => k !== key) }))
    .filter((b) => b.pins.length >= 2);
  return next;
}

export function movePinIndex(raw: Raw, index: number, delta: -1 | 1): Raw {
  const to = index + delta;
  if (!raw.pins || to < 0 || to >= raw.pins.length) return raw;
  const next = clone(raw);
  const [p] = next.pins!.splice(index, 1);
  next.pins!.splice(to, 0, p!);
  return next;
}

/** Bus ids that contain `key`. */
export function busesOf(raw: Raw, key: string): string[] {
  return (raw.buses ?? []).filter((b) => b.pins.includes(key)).map((b) => b.id);
}

/** Set exactly which buses contain `key`. A bus needs 2+ pins, so it may be dropped. */
export function setPinBuses(raw: Raw, key: string, ids: string[]): Raw {
  const next = clone(raw);
  next.buses = (next.buses ?? []).map((b) => {
    const has = b.pins.includes(key);
    const want = ids.includes(b.id);
    if (has === want) return b;
    return { ...b, pins: want ? [...b.pins, key] : b.pins.filter((k) => k !== key) };
  });
  return next;
}

export function setBusPins(raw: Raw, id: string, pins: string[]): Raw {
  const next = clone(raw);
  next.buses = (next.buses ?? []).map((b) => (b.id === id ? { ...b, pins } : b));
  return next;
}

export function addBus(raw: Raw, id: string): Raw {
  const next = clone(raw);
  next.buses = [...(next.buses ?? []), { id, pins: [] }];
  return next;
}

export function removeBus(raw: Raw, id: string): Raw {
  const next = clone(raw);
  next.buses = (next.buses ?? []).filter((b) => b.id !== id);
  return next;
}

/** Set (or with undefined: delete) a nested field by path, e.g. ["outline", "widthMm"]. */
export function setIn(raw: Raw, path: (string | number)[], value: unknown): Raw {
  const next = clone(raw) as Record<string | number, unknown>;
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") {
      cur[k] = typeof path[i + 1] === "number" ? [] : {};
    }
    cur = cur[k] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === undefined) {
    if (Array.isArray(cur) && typeof last === "number") cur.splice(last, 1);
    else delete cur[last];
  } else cur[last] = value;
  return next as Raw;
}

/** Read a nested field by path. */
export function getIn(raw: unknown, path: (string | number)[]): unknown {
  let cur = raw as Record<string | number, unknown> | undefined;
  for (const k of path) {
    if (cur === undefined || cur === null || typeof cur !== "object") return undefined;
    cur = cur[k] as Record<string | number, unknown> | undefined;
  }
  return cur;
}

/** Label for a marker: "<key> #<connector number>". */
export function markerLabel(c: Pick<ResolvedConnector, "key" | "id">): string {
  return `${c.key} #${c.id}`;
}
