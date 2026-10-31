/**
 * fritzkit ui app: canvas on the left, tabs on the right. Local edits live in `raw` (the
 * part.json object) and are saved with Save or automatically 600 ms after the last change.
 * An SSE "changed" event reloads the part when nothing is unsaved, otherwise a bar asks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allocatePinIds, resolvePart, type ResolvedPart } from "../core/resolve.js";
import { safeParsePartSpec, type PartSpec } from "../core/schema/part.js";
import {
  api,
  ApiError,
  type AssetInfo,
  type Issue,
  type PartListing,
  type PartPayload,
} from "./api.js";
import { photoPlacement, type Rotation } from "./calib.js";
import { Canvas, type PhotoLayer } from "./Canvas.js";
import { NumField } from "./fields.js";
import { anchorOf, moveOwner, ownerOf, type Raw } from "./model.js";
import { ArtworkTab, BusesTab, OutlineTab, PreviewTab, RawTab, type Pick } from "./OtherTabs.js";
import { PinsTab } from "./PinsTab.js";

const TABS = ["Pins", "Outline & Calibration", "Artwork", "Buses", "Preview", "Raw"] as const;
type Tab = (typeof TABS)[number];
const AUTOSAVE_MS = 600;

function slugFromHash(): string | undefined {
  const m = /^#\/([^/?]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

interface Local {
  spec: PartSpec | null;
  resolved: ResolvedPart | null;
  issues: Issue[];
}

/** Client-side parse + resolve of the local edits (the same core code the server runs). */
function analyse(raw: Raw | null): Local {
  if (!raw) return { spec: null, resolved: null, issues: [] };
  const r = safeParsePartSpec(raw);
  if (!r.success) {
    return {
      spec: null,
      resolved: null,
      issues: r.error.issues.map((zi) => {
        const path = zi.path.map(String).join(".");
        return {
          level: "error",
          code: "spec-schema",
          message: path ? `${path}: ${zi.message}` : zi.message,
        };
      }),
    };
  }
  try {
    const { pinIds } = allocatePinIds(r.data);
    const resolved = resolvePart({ ...r.data, pinIds });
    return { spec: r.data, resolved, issues: [] };
  } catch (e) {
    return {
      spec: r.data,
      resolved: null,
      issues: [
        {
          level: "error",
          code: "spec-resolve",
          message: e instanceof Error ? e.message : String(e),
        },
      ],
    };
  }
}

export function App() {
  const [parts, setParts] = useState<PartListing[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [slug, setSlug] = useState<string | undefined>(slugFromHash());
  const [payload, setPayload] = useState<PartPayload | null>(null);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<Issue[]>([]);
  const [diskChanged, setDiskChanged] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Pins");
  const [selected, setSelected] = useState<string | undefined>();
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(false);
  const [mode, setMode] = useState<"edit" | "points">("edit");
  const [points, setPoints] = useState<Pick[]>([]);
  const [chosenAsset, setChosenAsset] = useState<string | undefined>();
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [image, setImage] = useState<{ url: string; widthPx: number; heightPx: number } | null>(
    null,
  );
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);

  const rawRef = useRef<Raw | null>(null);
  rawRef.current = raw;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  /** Hashes of part.json versions this tab loaded or saved (SSE echoes to ignore). */
  const known = useRef(new Set<string>());
  /** Hash of the on-disk change that raised the "changed on disk" bar. */
  const pendingDiskHash = useRef<string | undefined>(undefined);
  const lastGood = useRef<{ spec: PartSpec; resolved: ResolvedPart } | null>(null);

  const notify = useCallback((msg: string, error = false) => setToast({ msg, error }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onHash = () => setSlug(slugFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api
      .parts()
      .then((r) => {
        setParts(r.parts);
        setWorkspace(r.workspace);
        if (!slugFromHash() && r.parts[0]) window.location.hash = `#/${r.parts[0].slug}`;
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const adopt = useCallback((p: PartPayload) => {
    known.current.add(p.hash);
    setPayload(p);
    setRaw(p.raw);
    setAssets(p.assets);
    setDirty(false);
    setDiskChanged(false);
    setSaveIssues([]);
  }, []);

  const reload = useCallback(async () => {
    if (!slug) return;
    try {
      adopt(await api.get(slug));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [slug, adopt]);

  useEffect(() => {
    setPayload(null);
    setRaw(null);
    setSelected(undefined);
    setChosenAsset(undefined);
    lastGood.current = null;
    void reload();
  }, [reload]);

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      const sent = rawRef.current;
      if (!slug || !sent) return false;
      if (!force && analyse(sent).issues.length > 0) return false;
      setSaving(true);
      try {
        const r = await api.put(slug, sent);
        known.current.add(r.hash);
        // The SSE echo of this very save can beat the PUT response; drop its bar.
        if (pendingDiskHash.current === r.hash) setDiskChanged(false);
        setPayload(r);
        setAssets(r.assets);
        setSaveIssues([]);
        if (rawRef.current === sent) {
          setRaw(r.raw);
          setDirty(false);
        } else if (r.raw) {
          // More edits arrived while saving: keep them, adopt the allocated pinIds.
          const pinIds = r.raw.pinIds;
          setRaw((cur) => (cur ? { ...cur, pinIds } : cur));
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.issues.length > 0) setSaveIssues(e.issues);
        else notify(e instanceof Error ? e.message : String(e), true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [slug, notify],
  );

  // Debounced autosave.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [raw, dirty, save]);

  // Live reload from disk (an agent editing part.json, or new assets).
  useEffect(() => {
    if (!slug) return;
    const es = new EventSource(api.eventsUrl(slug));
    es.addEventListener("changed", (ev) => {
      let data: { kind?: string; hash?: string } = {};
      try {
        data = JSON.parse((ev as MessageEvent<string>).data) as typeof data;
      } catch {
        return;
      }
      if (data.kind === "assets") {
        api
          .get(slug)
          .then((p) => setAssets(p.assets))
          .catch(() => undefined);
        setAssetsVersion((v) => v + 1);
        return;
      }
      if (data.hash && known.current.has(data.hash)) return;
      if (dirtyRef.current) {
        pendingDiskHash.current = data.hash;
        setDiskChanged(true);
      } else void reload();
    });
    return () => es.close();
  }, [slug, reload]);

  const local = useMemo(() => analyse(raw), [raw]);
  if (local.spec && local.resolved)
    lastGood.current = { spec: local.spec, resolved: local.resolved };
  const view =
    local.spec && local.resolved
      ? { spec: local.spec, resolved: local.resolved }
      : lastGood.current;

  const edit = useCallback((f: (r: Raw) => Raw) => {
    setRaw((cur) => (cur ? f(cur) : cur));
    setDirty(true);
  }, []);

  // Reference photo: artwork.photo.src, else the asset picked in Outline & Calibration.
  const photoSpec = raw?.artwork?.photo;
  const photoSrc = photoSpec?.src || chosenAsset;
  useEffect(() => {
    if (!photoSpec?.src) return;
    setChosenAsset(photoSpec.src);
  }, [photoSpec?.src]);
  useEffect(() => {
    if (!slug || !photoSrc) {
      setImage(null);
      return;
    }
    const url = `${api.assetUrl(slug, photoSrc)}?v=${assetsVersion}`;
    const img = new Image();
    let live = true;
    img.onload = () =>
      live && setImage({ url, widthPx: img.naturalWidth, heightPx: img.naturalHeight });
    img.onerror = () => live && setImage(null);
    img.src = url;
    return () => {
      live = false;
    };
  }, [slug, photoSrc, assetsVersion]);

  const photoLayer: PhotoLayer | undefined = useMemo(() => {
    if (!image || !view) return undefined;
    const usePhoto = photoSpec?.src === photoSrc;
    const c: [number, number, number, number] =
      usePhoto && photoSpec?.crop ? photoSpec.crop : [0, 0, image.widthPx, image.heightPx];
    const rot = ((usePhoto ? photoSpec?.rotate : 0) ?? 0) as Rotation;
    if (!(c[2] > 0 && c[3] > 0)) return undefined;
    const o = view.spec.outline;
    return {
      url: image.url,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      opacity: 0.9,
      placement: photoPlacement({ x: c[0], y: c[1], w: c[2], h: c[3] }, rot, {
        widthMm: o.widthMm,
        heightMm: o.heightMm,
      }),
    };
  }, [image, view, photoSpec, photoSrc]);

  // Arrow keys nudge the selected item: 0.1 mm, shift 1 mm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || !rawRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))
        return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        e.key
      ];
      if (!d) return;
      const owner = ownerOf(rawRef.current, selected);
      if (!owner) return;
      e.preventDefault();
      const step = e.shiftKey ? 1 : 0.1;
      const a = anchorOf(rawRef.current, owner);
      edit((r) => moveOwner(r, owner, a.x + d[0]! * step, a.y + d[1]! * step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, edit]);

  const selOwner = raw && selected ? ownerOf(raw, selected) : undefined;
  const selAnchor = raw && selOwner ? anchorOf(raw, selOwner) : undefined;
  const issues = saveIssues.length > 0 ? saveIssues : local.issues;
  const status = saving
    ? "saving..."
    : issues.length > 0 && dirty
      ? `not saved: ${issues.length} issue${issues.length === 1 ? "" : "s"}`
      : dirty
        ? "unsaved changes"
        : "saved";

  return (
    <div className="app">
      <header>
        <strong>fritzkit ui</strong>
        <select
          value={slug ?? ""}
          onChange={(e) => {
            window.location.hash = `#/${e.target.value}`;
          }}
        >
          {slug && !parts.some((p) => p.slug === slug) ? (
            <option value={slug}>{slug}</option>
          ) : null}
          {parts.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.slug} - {p.title}
            </option>
          ))}
        </select>
        <span className="muted mono">{payload?.dir ?? workspace}</span>
        <span className="spacer" />
        <span className={`status ${issues.length > 0 && dirty ? "bad" : dirty ? "warn" : ""}`}>
          {status}
        </span>
        <button onClick={() => void save(true)} disabled={!raw || saving}>
          Save
        </button>
      </header>
      {diskChanged ? (
        <div className="bar">
          part.json changed on disk - reload? Your unsaved edits would be lost.
          <button onClick={() => void reload()}>Reload</button>
          <button onClick={() => setDiskChanged(false)}>Keep mine</button>
        </div>
      ) : null}
      {loadError ? <div className="bar bad">{loadError}</div> : null}
      {!slug && parts.length === 0 && !loadError ? (
        <div className="empty">
          The workspace {workspace} has no parts yet. Create one with{" "}
          <code>fritzkit new &lt;slug&gt;</code>; it shows up here after a reload.
        </div>
      ) : null}
      {slug && raw !== undefined ? (
        <main>
          <section className="left">
            <div className="toolbar">
              <label>
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{" "}
                snap 0.1 in
              </label>
              <button className="small" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>
                Zoom -
              </button>
              <span className="mono">{Math.round(zoom * 100)}%</span>
              <button className="small" onClick={() => setZoom((z) => Math.min(12, z * 1.25))}>
                Zoom +
              </button>
              <button className="small" onClick={() => setZoom(1)}>
                100%
              </button>
              <span className="spacer" />
              {selected && selAnchor && selOwner ? (
                <>
                  <span className="mono">
                    {selected}
                    {selOwner.kind === "header"
                      ? " (header)"
                      : selOwner.kind === "lead"
                        ? " (lead from)"
                        : ""}
                  </span>
                  <label>
                    X{" "}
                    <NumField
                      value={selAnchor.x}
                      onChange={(v) =>
                        v !== undefined && edit((r) => moveOwner(r, selOwner, v, selAnchor.y))
                      }
                    />
                  </label>
                  <label>
                    Y{" "}
                    <NumField
                      value={selAnchor.y}
                      onChange={(v) =>
                        v !== undefined && edit((r) => moveOwner(r, selOwner, selAnchor.x, v))
                      }
                    />
                  </label>
                  <span className="muted">mm</span>
                </>
              ) : (
                <span className="muted">click a marker to select it</span>
              )}
            </div>
            <div className="canvaswrap">
              {view && raw ? (
                <Canvas
                  raw={raw}
                  spec={view.spec}
                  connectors={view.resolved.connectors}
                  frame={view.resolved.frame}
                  photo={photoLayer}
                  selected={selected}
                  zoom={zoom}
                  snap={snap}
                  mode={mode}
                  points={points}
                  onSelect={setSelected}
                  onMove={(o, x, y) => edit((r) => moveOwner(r, o, x, y))}
                  onPoint={(p) => setPoints((ps) => (ps.length >= 2 ? [p] : [...ps, p]))}
                />
              ) : (
                <div className="empty">
                  {payload ? "part.json does not parse; fix it in the Raw tab." : "loading..."}
                </div>
              )}
            </div>
            {issues.length > 0 ? (
              <ul className="issues compact">
                {issues.slice(0, 8).map((i, n) => (
                  <li key={n} className={i.level}>
                    {i.message}
                  </li>
                ))}
                {issues.length > 8 ? <li className="muted">... {issues.length - 8} more</li> : null}
              </ul>
            ) : null}
          </section>
          <section className="right">
            <nav className="tabs">
              {TABS.map((t) => (
                <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </nav>
            <div className="tabbody">
              {!raw && tab !== "Raw" ? (
                <p className="err">part.json is not valid JSON; fix it in the Raw tab.</p>
              ) : null}
              {raw && tab === "Pins" ? (
                <PinsTab
                  raw={raw}
                  edit={edit}
                  selected={selected}
                  onSelect={setSelected}
                  pinIds={local.resolved?.pinIds ?? payload?.pinIds ?? {}}
                />
              ) : null}
              {raw && tab === "Outline & Calibration" ? (
                <OutlineTab
                  raw={raw}
                  edit={edit}
                  slug={slug}
                  assets={assets}
                  asset={photoSrc}
                  setAsset={setChosenAsset}
                  onAssets={(a) => {
                    setAssets(a);
                    setAssetsVersion((v) => v + 1);
                  }}
                  image={image ?? undefined}
                  mode={mode}
                  setMode={setMode}
                  points={points}
                  clearPoints={() => setPoints([])}
                  notify={notify}
                />
              ) : null}
              {raw && tab === "Artwork" ? <ArtworkTab raw={raw} edit={edit} /> : null}
              {raw && tab === "Buses" ? <BusesTab raw={raw} edit={edit} /> : null}
              {tab === "Preview" ? (
                <PreviewTab
                  slug={slug}
                  version={`${payload?.hash ?? ""}-${assetsVersion}`}
                  saveNow={async () => (dirtyRef.current ? save(true) : true)}
                  notify={notify}
                  onExported={() => void reload()}
                />
              ) : null}
              {tab === "Raw" ? (
                <RawTab
                  raw={raw}
                  text={payload?.text ?? ""}
                  apply={(v) => {
                    setRaw(v as Raw);
                    setDirty(true);
                  }}
                />
              ) : null}
            </div>
          </section>
        </main>
      ) : null}
      {toast ? <div className={`toast ${toast.error ? "bad" : ""}`}>{toast.msg}</div> : null}
    </div>
  );
}
