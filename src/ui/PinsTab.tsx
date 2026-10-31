/** Pins tab: free pins (full table), headers and leads (compact editors). */
import { useState } from "react";
import { ConnectorType, KEY_RE, PadShape, PinRole } from "../core/schema/part.js";
import { ColorField, NumField, Select, TextField } from "./fields.js";
import {
  addPin,
  allKeys,
  busesOf,
  clone,
  freeKey,
  movePinIndex,
  removePin,
  setPinBuses,
  updatePin,
  dropKeyFromBuses,
  type Raw,
  type RawHeader,
  type RawLead,
} from "./model.js";

const TYPES = ConnectorType.options;
const ROLES = PinRole.options;
const SHAPES = PadShape.options;

export interface TabProps {
  raw: Raw;
  edit: (f: (r: Raw) => Raw) => void;
  selected?: string;
  onSelect: (key: string | undefined) => void;
  pinIds: Record<string, number>;
}

function newKeyError(raw: Raw, key: string): string | undefined {
  if (!KEY_RE.test(key)) return "letters, digits, _ . + - (no spaces)";
  if (allKeys(raw).includes(key)) return `key "${key}" is taken`;
  return undefined;
}

function AddKey(props: { raw: Raw; label: string; prefix: string; onAdd: (key: string) => void }) {
  const [key, setKey] = useState("");
  const k = key.trim() || freeKey(props.raw, props.prefix);
  const err = newKeyError(props.raw, k);
  return (
    <div className="addrow">
      <TextField value={key} onChange={setKey} placeholder={k} width="8em" />
      <button
        disabled={err !== undefined}
        onClick={() => {
          props.onAdd(k);
          setKey("");
        }}
      >
        {props.label}
      </button>
      {err && key ? <span className="err">{err}</span> : null}
    </div>
  );
}

function BusPicker(props: { raw: Raw; pinKey: string; edit: TabProps["edit"] }) {
  const ids = (props.raw.buses ?? []).map((b) => b.id);
  if (ids.length === 0) return <span className="muted">-</span>;
  const cur = busesOf(props.raw, props.pinKey);
  return (
    <select
      multiple
      size={Math.min(3, ids.length)}
      value={cur}
      onChange={(e) => {
        const sel = [...e.target.selectedOptions].map((o) => o.value);
        props.edit((r) => setPinBuses(r, props.pinKey, sel));
      }}
    >
      {ids.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

export function PinsTab(props: TabProps) {
  const { raw, edit } = props;
  const pins = raw.pins ?? [];
  return (
    <div className="tab">
      <h3>Pins and pads ({pins.length})</h3>
      <div className="tablewrap">
        <table className="grid">
          <thead>
            <tr>
              <th />
              <th>key</th>
              <th>#</th>
              <th>name</th>
              <th>label</th>
              <th>type</th>
              <th>role</th>
              <th>description</th>
              <th>pad</th>
              <th>w</th>
              <th>h</th>
              <th>hole</th>
              <th>x</th>
              <th>y</th>
              <th>buses</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pins.map((p, i) => {
              const pad = p.pad ?? { shape: "rect", wMm: 2, hMm: 2, holeMm: 1 };
              const setPad = (patch: Record<string, unknown>) =>
                edit((r) => {
                  const next = clone(r);
                  const cur = next.pins![i]!.pad ?? { shape: "rect", wMm: 2, hMm: 2, holeMm: 1 };
                  const merged = { ...cur, ...patch } as Record<string, unknown>;
                  for (const [k, v] of Object.entries(merged))
                    if (v === undefined) delete merged[k];
                  next.pins![i]!.pad = merged as typeof cur;
                  return next;
                });
              return (
                <tr
                  key={p.key}
                  className={props.selected === p.key ? "selected" : ""}
                  onClick={() => props.onSelect(p.key)}
                >
                  <td className="nowrap">
                    <button
                      className="small"
                      disabled={i === 0}
                      onClick={() => edit((r) => movePinIndex(r, i, -1))}
                    >
                      Up
                    </button>
                    <button
                      className="small"
                      disabled={i === pins.length - 1}
                      onClick={() => edit((r) => movePinIndex(r, i, 1))}
                    >
                      Down
                    </button>
                  </td>
                  <td className="mono">{p.key}</td>
                  <td className="mono muted">{props.pinIds[p.key] ?? "new"}</td>
                  <td>
                    <TextField
                      value={p.name}
                      width="7em"
                      onChange={(v) => edit((r) => updatePin(r, i, { name: v }))}
                    />
                  </td>
                  <td>
                    <TextField
                      value={p.label}
                      width="5em"
                      placeholder={p.name}
                      onChange={(v) => edit((r) => updatePin(r, i, { label: v }))}
                    />
                  </td>
                  <td>
                    <Select
                      value={p.type ?? "female"}
                      options={TYPES}
                      onChange={(v) => edit((r) => updatePin(r, i, { type: v }))}
                    />
                  </td>
                  <td>
                    <Select
                      value={p.role ?? "io"}
                      options={ROLES}
                      onChange={(v) => edit((r) => updatePin(r, i, { role: v }))}
                    />
                  </td>
                  <td>
                    <TextField
                      value={p.description}
                      width="10em"
                      onChange={(v) => edit((r) => updatePin(r, i, { description: v }))}
                    />
                  </td>
                  <td>
                    <Select
                      value={pad.shape ?? "rect"}
                      options={SHAPES}
                      onChange={(v) => setPad({ shape: v })}
                    />
                  </td>
                  <td>
                    <NumField value={pad.wMm} min={0.01} onChange={(v) => setPad({ wMm: v })} />
                  </td>
                  <td>
                    <NumField value={pad.hMm} min={0.01} onChange={(v) => setPad({ hMm: v })} />
                  </td>
                  <td>
                    <NumField
                      value={pad.holeMm}
                      min={0}
                      optional
                      title="empty or 0 = SMD pad"
                      onChange={(v) => setPad({ holeMm: v })}
                    />
                  </td>
                  <td>
                    <NumField
                      value={p.xMm}
                      onChange={(v) => edit((r) => updatePin(r, i, { xMm: v ?? 0 }))}
                    />
                  </td>
                  <td>
                    <NumField
                      value={p.yMm}
                      onChange={(v) => edit((r) => updatePin(r, i, { yMm: v ?? 0 }))}
                    />
                  </td>
                  <td>
                    <BusPicker raw={raw} pinKey={p.key} edit={edit} />
                  </td>
                  <td>
                    <button className="small danger" onClick={() => edit((r) => removePin(r, i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <AddKey
        raw={raw}
        label="Add pin"
        prefix="P"
        onAdd={(k) => {
          const w = raw.outline?.widthMm ?? 10;
          const h = raw.outline?.heightMm ?? 10;
          edit((r) => addPin(r, k, { x: w / 2, y: h / 2 }));
          props.onSelect(k);
        }}
      />
      <p className="hint">
        Keys are permanent (they own the connector number shown as #). Drag a marker on the canvas
        or use the arrow keys (shift = 1 mm) to move the selected item.
      </p>
      <HeadersEditor {...props} />
      <LeadsEditor {...props} />
    </div>
  );
}

function HeadersEditor(props: TabProps) {
  const { raw, edit } = props;
  const headers = raw.headers ?? [];
  const setH = (i: number, patch: Partial<RawHeader>) =>
    edit((r) => {
      const next = clone(r);
      next.headers![i] = { ...next.headers![i]!, ...patch };
      return next;
    });
  return (
    <>
      <h3>Headers ({headers.length})</h3>
      {headers.map((h, i) => (
        <fieldset key={h.key} className="box">
          <legend className="mono">{h.key}</legend>
          <div className="row">
            <label>
              kind{" "}
              <Select
                value={h.kind ?? "male"}
                options={["male", "female", "castellated"] as const}
                onChange={(v) => setH(i, { kind: v })}
              />
            </label>
            <label>
              orientation{" "}
              <Select
                value={h.orientation ?? "horizontal"}
                options={["horizontal", "vertical"] as const}
                onChange={(v) => setH(i, { orientation: v })}
              />
            </label>
            <label>
              pitch{" "}
              <NumField
                value={h.pitchMm ?? 2.54}
                min={0.1}
                onChange={(v) => setH(i, { pitchMm: v })}
              />
            </label>
            <label>
              x <NumField value={h.xMm} onChange={(v) => setH(i, { xMm: v ?? 0 })} />
            </label>
            <label>
              y <NumField value={h.yMm} onChange={(v) => setH(i, { yMm: v ?? 0 })} />
            </label>
            <span className="muted">
              {h.rows ?? 1} x {h.cols}
            </span>
            <button
              className="small danger"
              onClick={() =>
                edit((r) => {
                  let next = clone(r);
                  const [gone] = next.headers!.splice(i, 1);
                  for (const p of gone?.pins ?? []) if (p) next = dropKeyFromBuses(next, p.key);
                  return next;
                })
              }
            >
              Remove header
            </button>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>slot</th>
                <th>key</th>
                <th>#</th>
                <th>name</th>
                <th>label</th>
                <th>role</th>
              </tr>
            </thead>
            <tbody>
              {h.pins.map((p, j) => (
                <tr
                  key={j}
                  className={p && props.selected === p.key ? "selected" : ""}
                  onClick={() => p && props.onSelect(p.key)}
                >
                  <td className="muted">{j + 1}</td>
                  <td className="mono">{p ? p.key : <span className="muted">(empty)</span>}</td>
                  <td className="mono muted">{p ? (props.pinIds[p.key] ?? "new") : ""}</td>
                  <td>
                    {p ? (
                      <TextField
                        value={p.name}
                        width="7em"
                        onChange={(v) =>
                          edit((r) => {
                            const next = clone(r);
                            next.headers![i]!.pins[j] = { ...p, name: v };
                            return next;
                          })
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    {p ? (
                      <TextField
                        value={p.label}
                        width="5em"
                        onChange={(v) =>
                          edit((r) => {
                            const next = clone(r);
                            const q = { ...p, label: v } as Record<string, unknown>;
                            if (!v) delete q.label;
                            next.headers![i]!.pins[j] = q as typeof p;
                            return next;
                          })
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    {p ? (
                      <Select
                        value={p.role ?? "io"}
                        options={ROLES}
                        onChange={(v) =>
                          edit((r) => {
                            const next = clone(r);
                            next.headers![i]!.pins[j] = { ...p, role: v };
                            return next;
                          })
                        }
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>
      ))}
      <AddHeader raw={raw} edit={edit} />
    </>
  );
}

function AddHeader(props: { raw: Raw; edit: TabProps["edit"] }) {
  const [cols, setCols] = useState<number | undefined>(4);
  return (
    <div className="row">
      <span>pins:</span>
      <NumField value={cols} min={1} step={1} onChange={setCols} width="4em" />
      <AddKey
        raw={props.raw}
        label="Add 1-row header"
        prefix="J"
        onAdd={(key) => {
          const n = Math.max(1, Math.min(64, Math.round(cols ?? 1)));
          props.edit((r) => {
            const next = clone(r);
            const used = new Set(allKeys(next));
            const pins = Array.from({ length: n }, (_, k) => {
              let pk = `${key}_${k + 1}`;
              while (used.has(pk)) pk += "_";
              used.add(pk);
              return { key: pk, name: `${k + 1}` };
            });
            next.headers = [
              ...(next.headers ?? []),
              { key, kind: "male", cols: n, xMm: 2.54, yMm: 2.54, pins },
            ];
            return next;
          });
        }}
      />
    </div>
  );
}

function LeadsEditor(props: TabProps) {
  const { raw, edit } = props;
  const leads = raw.leads ?? [];
  const setL = (i: number, patch: Partial<RawLead>) =>
    edit((r) => {
      const next = clone(r);
      next.leads![i] = { ...next.leads![i]!, ...patch };
      return next;
    });
  return (
    <>
      <h3>Wire leads ({leads.length})</h3>
      {leads.length > 0 ? (
        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                <th>key</th>
                <th>#</th>
                <th>name</th>
                <th>role</th>
                <th>colour</th>
                <th>length</th>
                <th>direction</th>
                <th>from x</th>
                <th>from y</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map((l, i) => (
                <tr
                  key={l.key}
                  className={props.selected === l.key ? "selected" : ""}
                  onClick={() => props.onSelect(l.key)}
                >
                  <td className="mono">{l.key}</td>
                  <td className="mono muted">{props.pinIds[l.key] ?? "new"}</td>
                  <td>
                    <TextField value={l.name} width="7em" onChange={(v) => setL(i, { name: v })} />
                  </td>
                  <td>
                    <Select
                      value={l.role ?? "io"}
                      options={ROLES}
                      onChange={(v) => setL(i, { role: v })}
                    />
                  </td>
                  <td>
                    <ColorField
                      value={l.color ?? "#000000"}
                      onChange={(v) => setL(i, { color: v })}
                    />
                  </td>
                  <td>
                    <NumField
                      value={l.lengthMm ?? 40}
                      min={0.1}
                      onChange={(v) => setL(i, { lengthMm: v })}
                    />
                  </td>
                  <td>
                    <Select
                      value={l.direction ?? "left"}
                      options={["left", "right", "up", "down"] as const}
                      onChange={(v) => setL(i, { direction: v })}
                    />
                  </td>
                  <td>
                    <NumField value={l.fromXMm} onChange={(v) => setL(i, { fromXMm: v ?? 0 })} />
                  </td>
                  <td>
                    <NumField value={l.fromYMm} onChange={(v) => setL(i, { fromYMm: v ?? 0 })} />
                  </td>
                  <td>
                    <button
                      className="small danger"
                      onClick={() =>
                        edit((r) => {
                          const next = clone(r);
                          next.leads!.splice(i, 1);
                          return dropKeyFromBuses(next, l.key);
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
        </div>
      ) : null}
      <AddKey
        raw={raw}
        label="Add lead"
        prefix="W"
        onAdd={(key) =>
          edit((r) => {
            const next = clone(r);
            next.leads = [
              ...(next.leads ?? []),
              {
                key,
                name: key,
                fromXMm: 0,
                fromYMm: (r.outline?.heightMm ?? 10) / 2,
                lengthMm: 20,
              },
            ];
            return next;
          })
        }
      />
    </>
  );
}
