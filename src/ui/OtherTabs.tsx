/** Outline & Calibration, Artwork, Buses, Preview and Raw tabs. */
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  safeUploadName,
  type AssetInfo,
  type DoctorPayload,
  type Issue,
  type ValidatePayload,
} from "./api.js";
import { cropFromScale, dist, type Rotation } from "./calib.js";
import { ColorField, NumField, Select, TextField } from "./fields.js";
import {
  addBus,
  allKeys,
  clone,
  getIn,
  removeBus,
  setBusPins,
  setIn,
  type Raw,
  type RawSilk,
} from "./model.js";

type Edit = (f: (r: Raw) => Raw) => void;

export interface Pick {
  xMm: number;
  yMm: number;
  px?: number;
  py?: number;
}

export interface OutlineTabProps {
  raw: Raw;
  edit: Edit;
  slug: string;
  assets: AssetInfo[];
  asset: string | undefined;
  setAsset: (a: string | undefined) => void;
  onAssets: (a: AssetInfo[]) => void;
  image?: { widthPx: number; heightPx: number };
  mode: "edit" | "points";
  setMode: (m: "edit" | "points") => void;
  points: Pick[];
  clearPoints: () => void;
  notify: (msg: string, error?: boolean) => void;
}

function photoOf(raw: Raw) {
  return raw.artwork?.photo;
}

export function OutlineTab(p: OutlineTabProps) {
  const { raw, edit } = p;
  const o = raw.outline ?? { widthMm: 10, heightMm: 10 };
  const photo = photoOf(raw);
  const rot = (photo?.rotate ?? 0) as Rotation;
  const [distMm, setDistMm] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Ensure artwork.photo exists with src = the chosen asset, then patch it. */
  const patchPhoto = (patch: Record<string, unknown>) =>
    edit((r) => {
      const next = clone(r);
      next.artwork = next.artwork ?? {};
      const cur = (next.artwork.photo ?? { src: p.asset ?? "" }) as Record<string, unknown>;
      const merged = { ...cur, ...patch };
      for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
      next.artwork.photo = merged as unknown as NonNullable<typeof next.artwork.photo>;
      return next;
    });

  const upload = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.upload(p.slug, safeUploadName(f.name), f);
      p.onAssets(r.assets);
      p.setAsset(r.name);
      if (photo) patchPhoto({ src: r.name });
      p.notify(`uploaded ${r.name}`);
    } catch (e) {
      p.notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const autoDetect = async () => {
    if (!p.asset) return;
    setBusy(true);
    try {
      const r = await api.calibrate(p.slug, p.asset, rot);
      patchPhoto({ src: r.asset, crop: r.crop });
      p.notify(
        `board found at ${r.crop.join(", ")} px; ${r.pxPerMm.x.toFixed(2)} x ${r.pxPerMm.y.toFixed(2)} px/mm`,
      );
    } catch (e) {
      p.notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const applyTwoPoints = () => {
    const [a, b] = p.points;
    if (!a || !b || a.px === undefined || b.px === undefined || !p.image || !distMm) return;
    const dPx = dist({ x: a.px, y: a.py! }, { x: b.px, y: b.py! });
    if (dPx <= 0) return;
    const ppm = dPx / distMm;
    const c = photo?.crop;
    const centre = c
      ? { x: c[0] + c[2] / 2, y: c[1] + c[3] / 2 }
      : { x: p.image.widthPx / 2, y: p.image.heightPx / 2 };
    const box = cropFromScale(ppm, centre, rot, { widthMm: o.widthMm, heightMm: o.heightMm });
    patchPhoto({ crop: [box.x, box.y, box.w, box.h] });
    p.notify(`scale ${ppm.toFixed(2)} px/mm; crop ${box.w} x ${box.h} px centred on the old crop`);
    p.clearPoints();
    p.setMode("edit");
  };

  const crop = photo?.crop;
  const setCrop = (i: number, v: number | undefined) => {
    const base: [number, number, number, number] = crop
      ? [...crop]
      : [0, 0, p.image?.widthPx ?? 100, p.image?.heightPx ?? 100];
    base[i] = Math.round(v ?? 0);
    patchPhoto({ crop: base });
  };

  return (
    <div className="tab">
      <h3>Outline</h3>
      <div className="row">
        <label>
          width mm{" "}
          <NumField
            value={o.widthMm}
            min={0.01}
            onChange={(v) => v && edit((r) => setIn(r, ["outline", "widthMm"], v))}
          />
        </label>
        <label>
          height mm{" "}
          <NumField
            value={o.heightMm}
            min={0.01}
            onChange={(v) => v && edit((r) => setIn(r, ["outline", "heightMm"], v))}
          />
        </label>
        <label>
          shape{" "}
          <Select
            value={o.shape ?? "rounded"}
            options={["rect", "rounded", "custom"] as const}
            onChange={(v) => edit((r) => setIn(r, ["outline", "shape"], v))}
          />
        </label>
        <label>
          corner radius{" "}
          <NumField
            value={o.cornerRadiusMm ?? 1}
            min={0}
            onChange={(v) => edit((r) => setIn(r, ["outline", "cornerRadiusMm"], v ?? 0))}
          />
        </label>
      </div>

      <h3>Reference photo</h3>
      <div className="row">
        <label>
          asset{" "}
          <select
            value={p.asset ?? ""}
            onChange={(e) => {
              const a = e.target.value || undefined;
              p.setAsset(a);
              if (photo && a) patchPhoto({ src: a });
            }}
          >
            <option value="">(none)</option>
            {p.assets.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} ({Math.round(a.size / 1024)} KB)
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.gif,.avif,.tif,.tiff"
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      <div className="row">
        <button disabled={!p.asset || busy} onClick={() => void autoDetect()}>
          Auto-detect board
        </button>
        <button
          disabled={!p.asset || !p.image}
          className={p.mode === "points" ? "active" : ""}
          onClick={() => {
            p.clearPoints();
            p.setMode(p.mode === "points" ? "edit" : "points");
          }}
        >
          {p.mode === "points" ? "Cancel two points" : "Click two points"}
        </button>
        <span>rotate</span>
        {([0, 90, 180, 270] as const).map((r) => (
          <button
            key={r}
            disabled={!p.asset}
            className={rot === r ? "active small" : "small"}
            onClick={() => patchPhoto({ rotate: r })}
          >
            {r}
          </button>
        ))}
      </div>
      {p.mode === "points" ? (
        <div className="callout">
          {p.points.length < 2 ? (
            <span>
              Click point {p.points.length + 1} of 2 on the photo (two features a known distance
              apart).
            </span>
          ) : (
            <span>
              Pixel distance{" "}
              {dist(
                { x: p.points[0]!.px ?? 0, y: p.points[0]!.py ?? 0 },
                { x: p.points[1]!.px ?? 0, y: p.points[1]!.py ?? 0 },
              ).toFixed(1)}
              . Real distance mm <NumField value={distMm} min={0.01} onChange={setDistMm} />{" "}
              <button disabled={!distMm} onClick={applyTwoPoints}>
                Apply scale
              </button>
            </span>
          )}
        </div>
      ) : null}
      {photo ? (
        <>
          <div className="row">
            <span>crop px</span>
            {["x", "y", "w", "h"].map((k, i) => (
              <label key={k}>
                {k}{" "}
                <NumField value={crop?.[i]} step={1} onChange={(v) => setCrop(i, v)} width="5em" />
              </label>
            ))}
            <button
              className="small"
              disabled={!crop}
              onClick={() => patchPhoto({ crop: undefined })}
            >
              Clear crop
            </button>
          </div>
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={photo.removeBackground ?? true}
                onChange={(e) => patchPhoto({ removeBackground: e.target.checked })}
              />{" "}
              remove background on export
            </label>
            <label>
              opacity{" "}
              <NumField
                value={photo.opacity ?? 1}
                min={0}
                step={0.1}
                onChange={(v) => patchPhoto({ opacity: v })}
              />
            </label>
            <button
              className="small danger"
              onClick={() => edit((r) => setIn(r, ["artwork", "photo"], undefined))}
            >
              Remove photo from spec
            </button>
          </div>
        </>
      ) : (
        <p className="hint">
          Pick or upload a photo, then Auto-detect or Click two points. The crop and rotation are
          stored in artwork.photo; set Artwork style to photo to embed it.
        </p>
      )}
      {p.image ? (
        <p className="hint">
          image {p.image.widthPx} x {p.image.heightPx} px
        </p>
      ) : null}
    </div>
  );
}

export function ArtworkTab(props: { raw: Raw; edit: Edit }) {
  const { raw, edit } = props;
  const art = raw.artwork ?? {};
  const silk = art.silkscreen ?? [];
  const setSilk = (i: number, patch: Record<string, unknown>) =>
    edit((r) => {
      const next = clone(r);
      const list = next.artwork!.silkscreen!;
      list[i] = { ...list[i]!, ...patch } as RawSilk;
      return next;
    });
  return (
    <div className="tab">
      <h3>Artwork</h3>
      <div className="row">
        <label>
          style{" "}
          <Select
            value={art.style ?? "vector"}
            options={["vector", "photo"] as const}
            onChange={(v) => edit((r) => setIn(r, ["artwork", "style"], v))}
          />
        </label>
        <label>
          board{" "}
          <ColorField
            value={art.boardColor ?? "#1B7F3B"}
            onChange={(v) => edit((r) => setIn(r, ["artwork", "boardColor"], v))}
          />
        </label>
        <label>
          silk{" "}
          <ColorField
            value={art.silkColor ?? "#FFFFFF"}
            onChange={(v) => edit((r) => setIn(r, ["artwork", "silkColor"], v))}
          />
        </label>
      </div>
      {art.style === "photo" && !art.photo ? (
        <p className="err">
          style is photo but there is no artwork.photo: pick a photo in Outline & Calibration.
        </p>
      ) : null}
      <h3>Silkscreen ({silk.length})</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>kind</th>
            <th>text</th>
            <th>x</th>
            <th>y</th>
            <th>size</th>
            <th>colour</th>
            <th>anchor</th>
            <th>rotate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {silk.map((s, i) => (
            <tr key={i}>
              <td>{s.kind}</td>
              {s.kind === "text" ? (
                <>
                  <td>
                    <TextField
                      value={s.text}
                      onChange={(v) => setSilk(i, { text: v })}
                      width="10em"
                    />
                  </td>
                  <td>
                    <NumField value={s.xMm} onChange={(v) => setSilk(i, { xMm: v ?? 0 })} />
                  </td>
                  <td>
                    <NumField value={s.yMm} onChange={(v) => setSilk(i, { yMm: v ?? 0 })} />
                  </td>
                  <td>
                    <NumField
                      value={s.sizeMm ?? 1.2}
                      min={0.01}
                      onChange={(v) => setSilk(i, { sizeMm: v })}
                    />
                  </td>
                  <td>
                    <ColorField
                      value={s.color ?? "#FFFFFF"}
                      onChange={(v) => setSilk(i, { color: v })}
                    />
                  </td>
                  <td>
                    <Select
                      value={s.anchor ?? "middle"}
                      options={["start", "middle", "end"] as const}
                      onChange={(v) => setSilk(i, { anchor: v })}
                    />
                  </td>
                  <td>
                    <NumField
                      value={s.rotate ?? 0}
                      step={90}
                      onChange={(v) => setSilk(i, { rotate: v ?? 0 })}
                    />
                  </td>
                </>
              ) : (
                <td colSpan={7} className="muted mono">
                  {JSON.stringify(s)}
                </td>
              )}
              <td>
                <button
                  className="small danger"
                  onClick={() =>
                    edit((r) => {
                      const next = clone(r);
                      next.artwork!.silkscreen!.splice(i, 1);
                      return next;
                    })
                  }
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          edit((r) => {
            const next = clone(r);
            next.artwork = next.artwork ?? {};
            const w = r.outline?.widthMm ?? 10;
            const h = r.outline?.heightMm ?? 10;
            next.artwork.silkscreen = [
              ...(next.artwork.silkscreen ?? []),
              { kind: "text", text: "LABEL", xMm: w / 2, yMm: h / 2 },
            ];
            return next;
          })
        }
      >
        Add text
      </button>
      <p className="hint">
        Rect, circle and line items (and components) are edited in the Raw tab.
      </p>
    </div>
  );
}

export function BusesTab(props: { raw: Raw; edit: Edit }) {
  const { raw, edit } = props;
  const buses = raw.buses ?? [];
  const keys = allKeys(raw);
  const [id, setId] = useState("");
  const idErr = !/^[A-Za-z0-9_.-]+$/.test(id)
    ? "letters, digits, _ . -"
    : buses.some((b) => b.id === id)
      ? "taken"
      : undefined;
  return (
    <div className="tab">
      <h3>Buses ({buses.length})</h3>
      <p className="hint">
        Pins in one bus are connected inside the part (for example every GND pad). A bus needs at
        least two pins.
      </p>
      {buses.map((b) => (
        <fieldset key={b.id} className="box">
          <legend className="mono">{b.id}</legend>
          <div className="checks">
            {keys.map((k) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={b.pins.includes(k)}
                  onChange={(e) =>
                    edit((r) =>
                      setBusPins(
                        r,
                        b.id,
                        e.target.checked ? [...b.pins, k] : b.pins.filter((x) => x !== k),
                      ),
                    )
                  }
                />
                <span className="mono">{k}</span>
              </label>
            ))}
          </div>
          {b.pins.length < 2 ? <p className="err">pick at least two pins</p> : null}
          <button className="small danger" onClick={() => edit((r) => removeBus(r, b.id))}>
            Remove bus
          </button>
        </fieldset>
      ))}
      <div className="addrow">
        <TextField value={id} onChange={setId} placeholder="gnd" width="8em" />
        <button
          disabled={idErr !== undefined}
          onClick={() => {
            edit((r) => addBus(r, id));
            setId("");
          }}
        >
          Add bus
        </button>
        {id && idErr ? <span className="err">{idErr}</span> : null}
      </div>
    </div>
  );
}

const VIEWS = ["breadboard", "schematic", "pcb", "icon"] as const;

export interface PreviewTabProps {
  slug: string;
  /** Changes after every saved edit (the saved file's hash) or asset change. */
  version: string;
  /** Saves pending local edits first; false when the save failed. */
  saveNow: () => Promise<boolean>;
  notify: (msg: string, error?: boolean) => void;
  onExported: () => void;
}

export function PreviewTab(p: PreviewTabProps) {
  const [svgs, setSvgs] = useState<Record<string, { url?: string; error?: string }>>({});
  const [val, setVal] = useState<ValidatePayload | { error: string } | null>(null);
  const [doctor, setDoctor] = useState<DoctorPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    let live = true;
    void Promise.all(
      VIEWS.map(async (v) => {
        try {
          const svg = await api.render(p.slug, v);
          return [
            v,
            { url: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) },
          ] as const;
        } catch (e) {
          return [v, { error: e instanceof Error ? e.message : String(e) }] as const;
        }
      }),
    ).then((rows) => {
      const made = rows
        .map(([, r]) => ("url" in r ? r.url : undefined))
        .filter((u): u is string => u !== undefined);
      if (!live) {
        made.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = made;
      setSvgs(Object.fromEntries(rows));
    });
    api
      .validate(p.slug)
      .then((r) => live && setVal(r))
      .catch((e: unknown) => live && setVal({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [p.slug, p.version]);

  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  const refreshDoctor = () => {
    api
      .doctor()
      .then(setDoctor)
      .catch(() => setDoctor(null));
  };
  useEffect(refreshDoctor, []);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        refreshDoctor();
      }
      p.notify(e instanceof Error ? e.message : String(e), true);
      if (e instanceof ApiError && e.issues.length > 0) setVal({ ok: false, issues: e.issues });
    } finally {
      setBusy(null);
    }
  };

  const issues: Issue[] = val && "issues" in val ? val.issues : [];
  const running = doctor?.fritzingRunning === true;

  return (
    <div className="tab">
      <div className="row">
        <button
          disabled={busy !== null}
          onClick={() =>
            void run("export", async () => {
              if (!(await p.saveNow())) return;
              const r = await api.exportPart(p.slug);
              p.notify(`wrote ${r.path} (${r.moduleId})`);
              p.onExported();
            })
          }
        >
          {busy === "export" ? "Exporting..." : "Export .fzpz"}
        </button>
        <button
          disabled={busy !== null || running}
          title={
            running ? "Fritzing is running: close it first (it reads parts only at startup)" : ""
          }
          onClick={() =>
            void run("install", async () => {
              if (!(await p.saveNow())) return;
              const r = await api.install(p.slug);
              p.notify(
                `installed ${r.moduleId} to ${r.installed?.installedDir ?? "?"}; restart Fritzing to see it`,
              );
              p.onExported();
            })
          }
        >
          {busy === "install" ? "Installing..." : "Install into Fritzing"}
        </button>
        <button disabled={busy !== null} onClick={refreshDoctor} className="small">
          Re-check Fritzing
        </button>
        <button
          disabled={busy !== null}
          className="small"
          onClick={() =>
            void run("checker", async () => {
              if (!(await p.saveNow())) return;
              setVal(await api.validate(p.slug, true));
            })
          }
        >
          {busy === "checker" ? "Checking..." : "Run Fritzing checker"}
        </button>
      </div>
      {running ? (
        <p className="err">
          Install is disabled: Fritzing is running. Close it (File &gt; Quit), then Re-check.
        </p>
      ) : null}
      <div className="previews">
        {VIEWS.map((v) => (
          <figure key={v}>
            <figcaption>{v}</figcaption>
            {svgs[v]?.url ? (
              <img src={svgs[v]!.url} alt={`${v} view`} />
            ) : (
              <div className="err">{svgs[v]?.error ?? "rendering..."}</div>
            )}
          </figure>
        ))}
      </div>
      <h3>Validator</h3>
      {val === null ? <p className="muted">validating...</p> : null}
      {val && "error" in val ? <p className="err">{val.error}</p> : null}
      {val && "ok" in val && issues.length === 0 ? <p className="ok">No issues found.</p> : null}
      {val && "checker" in val && val.checker && !val.checker.available ? (
        <p className="muted">The Fritzing checker is not available on this machine (needs uv).</p>
      ) : null}
      <ul className="issues">
        {issues.map((i, n) => (
          <li key={n} className={i.level}>
            <pre>{i.explain ?? `${i.level} [${i.code}] ${i.message}`}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RawTab(props: { raw: Raw | null; text: string; apply: (v: unknown) => void }) {
  const source = props.raw ? JSON.stringify(props.raw, null, 2) : props.text;
  const [text, setText] = useState(source);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!touched) setText(source);
  }, [source, touched]);
  return (
    <div className="tab rawtab">
      <div className="row">
        <button
          disabled={!touched}
          onClick={() => {
            try {
              const v = JSON.parse(text) as unknown;
              setErr(null);
              setTouched(false);
              props.apply(v);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Apply
        </button>
        <button
          className="small"
          disabled={!touched}
          onClick={() => {
            setTouched(false);
            setErr(null);
            setText(source);
          }}
        >
          Revert
        </button>
        {err ? <span className="err">{err}</span> : null}
        {getIn(props.raw, ["$schema"]) ? (
          <span className="muted">validated against the fritzkit schema on save</span>
        ) : null}
      </div>
      <textarea
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTouched(true);
        }}
      />
    </div>
  );
}
