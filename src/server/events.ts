/**
 * Server-sent events for `GET /api/parts/:slug/events`. One fs.watch per part folder
 * (recursive, so assets/ is covered even when it is created later), shared by every
 * subscriber and closed with the last one. Events are debounced per kind:
 *
 *   event: changed
 *   data: {"kind":"part","hash":"<sha1 of part.json>"}     part.json changed
 *   data: {"kind":"assets"}                                 something under assets/ changed
 *
 * The hash lets the app ignore the echo of its own save. build/ and *.fzpz writes are
 * ignored: they are output, never input.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { ASSETS_DIR, PART_FILE } from "../core/workspace.js";

export type ChangeKind = "part" | "assets";

export interface ChangeEvent {
  kind: ChangeKind;
  hash?: string;
}

/** sha1 hex of a string (the app compares it with the hash of what it saved). */
export function textHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** Classify a watcher filename relative to the part folder; undefined = ignore. */
export function classifyChange(filename: string | null | undefined): ChangeKind | undefined {
  if (!filename) return "part";
  const f = filename.replace(/\\/g, "/");
  if (f === PART_FILE) return "part";
  if (f === ASSETS_DIR || f.startsWith(`${ASSETS_DIR}/`)) {
    // writeFileAtomic's temp file; the rename that follows reports the real name.
    if (/\.tmp-\d+$/.test(f)) return undefined;
    return "assets";
  }
  return undefined;
}

/** Format one SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Channel {
  watcher?: FSWatcher;
  clients: Set<ServerResponse>;
  timers: Map<ChangeKind, NodeJS.Timeout>;
}

export class EventHub {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly debounceMs = 200) {}

  /** Subscribe an SSE response to changes in `dir` (keyed by `slug`). */
  subscribe(slug: string, dir: string, res: ServerResponse): void {
    let ch = this.channels.get(slug);
    if (!ch) {
      ch = { clients: new Set(), timers: new Map() };
      this.channels.set(slug, ch);
      const channel = ch;
      try {
        channel.watcher = watch(dir, { recursive: true }, (_type, filename) => {
          const kind = classifyChange(filename);
          if (kind) this.schedule(slug, dir, channel, kind);
        });
        channel.watcher.on("error", () => undefined);
      } catch {
        // The folder vanished; subscribers still get the hello and keep-alives.
      }
    }
    ch.clients.add(res);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(sseFrame("hello", { slug }));
    const channel = ch;
    res.on("close", () => {
      channel.clients.delete(res);
      if (channel.clients.size === 0) this.drop(slug);
    });
  }

  private schedule(slug: string, dir: string, ch: Channel, kind: ChangeKind): void {
    const old = ch.timers.get(kind);
    if (old) clearTimeout(old);
    ch.timers.set(
      kind,
      setTimeout(() => {
        ch.timers.delete(kind);
        void this.fire(dir, ch, kind);
      }, this.debounceMs),
    );
  }

  private async fire(dir: string, ch: Channel, kind: ChangeKind): Promise<void> {
    const ev: ChangeEvent = { kind };
    if (kind === "part") {
      try {
        ev.hash = textHash(await readFile(join(dir, PART_FILE), "utf8"));
      } catch {
        // deleted or mid-rename: send the event without a hash
      }
    }
    const frame = sseFrame("changed", ev);
    for (const c of ch.clients) c.write(frame);
  }

  /** Send a comment line to every client (keeps proxies and the browser from timing out). */
  ping(): void {
    for (const ch of this.channels.values()) for (const c of ch.clients) c.write(": ping\n\n");
  }

  /** Number of open subscriptions (tests). */
  get size(): number {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.clients.size;
    return n;
  }

  private drop(slug: string): void {
    const ch = this.channels.get(slug);
    if (!ch) return;
    for (const t of ch.timers.values()) clearTimeout(t);
    ch.watcher?.close();
    this.channels.delete(slug);
  }

  /** End every stream and close every watcher. */
  close(): void {
    for (const [slug, ch] of [...this.channels]) {
      for (const c of ch.clients) c.end();
      this.drop(slug);
    }
  }
}
