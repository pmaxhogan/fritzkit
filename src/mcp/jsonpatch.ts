/**
 * A tiny RFC 6902 JSON Patch (add / remove / replace / test) over RFC 6901 JSON pointers.
 * applyPatch never mutates its input: it works on a structured clone and returns it.
 */

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "test"; path: string; value: unknown };

export class JsonPatchError extends Error {
  constructor(
    message: string,
    public readonly index: number,
  ) {
    super(`patch op ${index}: ${message}`);
    this.name = "JsonPatchError";
  }
}

/** "/a/b~1c/~0d" -> ["a", "b/c", "~d"]; "" -> [] (the whole document). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON pointer "${pointer}" must start with "/"`);
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Structural equality of JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

const INDEX_RE = /^(0|[1-9][0-9]*)$/;
type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return v !== null && typeof v === "object";
}

function walk(doc: unknown, tokens: string[], i: number): Container {
  let cur: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (!INDEX_RE.test(t) || Number(t) >= cur.length) {
        throw new JsonPatchError(`no array element "${t}"`, i);
      }
      cur = cur[Number(t)];
    } else if (isContainer(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, t)) {
        throw new JsonPatchError(`no member "${t}"`, i);
      }
      cur = (cur as Record<string, unknown>)[t];
    } else {
      throw new JsonPatchError(`cannot descend into a ${typeof cur} at "${t}"`, i);
    }
  }
  if (!isContainer(cur)) throw new JsonPatchError("parent is not an object or array", i);
  return cur;
}

function arrayIndex(arr: unknown[], t: string, i: number, allowEnd: boolean): number {
  if (allowEnd && t === "-") return arr.length;
  if (!INDEX_RE.test(t)) throw new JsonPatchError(`bad array index "${t}"`, i);
  const n = Number(t);
  if (n > arr.length || (!allowEnd && n === arr.length)) {
    throw new JsonPatchError(`array index ${n} out of range (length ${arr.length})`, i);
  }
  return n;
}

function getAt(doc: unknown, tokens: string[], i: number): unknown {
  if (tokens.length === 0) return doc;
  const parent = walk(doc, tokens.slice(0, -1), i);
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(parent)) return parent[arrayIndex(parent, last, i, false)];
  if (!Object.prototype.hasOwnProperty.call(parent, last)) {
    throw new JsonPatchError(`no member "${last}"`, i);
  }
  return parent[last];
}

/** Apply ops in order to a clone of doc. Throws JsonPatchError (nothing is half-applied). */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let out: unknown = structuredClone(doc);
  ops.forEach((op, i) => {
    let tokens: string[];
    try {
      tokens = parsePointer(op.path);
    } catch (e) {
      throw new JsonPatchError((e as Error).message, i);
    }
    const value = "value" in op ? structuredClone(op.value) : undefined;
    if (op.op === "test") {
      if (!jsonEqual(getAt(out, tokens, i), op.value)) {
        throw new JsonPatchError(`test failed at "${op.path}"`, i);
      }
      return;
    }
    if (tokens.length === 0) {
      if (op.op === "remove") throw new JsonPatchError("cannot remove the whole document", i);
      out = value;
      return;
    }
    const parent = walk(out, tokens.slice(0, -1), i);
    const last = tokens[tokens.length - 1] as string;
    if (Array.isArray(parent)) {
      if (op.op === "add") parent.splice(arrayIndex(parent, last, i, true), 0, value);
      else if (op.op === "remove") parent.splice(arrayIndex(parent, last, i, false), 1);
      else parent[arrayIndex(parent, last, i, false)] = value;
      return;
    }
    if (op.op !== "add" && !Object.prototype.hasOwnProperty.call(parent, last)) {
      throw new JsonPatchError(`no member "${last}" to ${op.op}`, i);
    }
    if (op.op === "remove") delete parent[last];
    // defineProperty, not assignment: a "__proto__" member must become an own property
    // (as JSON.parse makes it) instead of replacing the object's prototype.
    else
      Object.defineProperty(parent, last, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  });
  return out as T;
}
