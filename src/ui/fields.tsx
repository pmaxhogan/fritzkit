/** Small controlled inputs that tolerate half-typed values ("1.", "-"). */
import { useEffect, useState } from "react";

export function NumField(props: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  min?: number;
  /** Empty input clears the value (optional fields). */
  optional?: boolean;
  width?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { value, onChange, optional } = props;
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === undefined ? "" : String(value));
  }, [value, focused]);
  return (
    <input
      className="num"
      type="text"
      inputMode="decimal"
      value={text}
      title={props.title}
      disabled={props.disabled}
      style={props.width ? { width: props.width } : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(value === undefined ? "" : String(value));
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") {
          if (optional) onChange(undefined);
          return;
        }
        const n = Number(t);
        if (Number.isFinite(n) && (props.min === undefined || n >= props.min)) onChange(n);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        const step = (props.step ?? 0.1) * (e.shiftKey ? 10 : 1);
        const n = (value ?? 0) + (e.key === "ArrowUp" ? step : -step);
        onChange(Math.round(n * 1000) / 1000);
      }}
    />
  );
}

export function TextField(props: {
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <input
      type="text"
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      title={props.title}
      style={props.width ? { width: props.width } : undefined}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function Select<T extends string>(props: {
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={props.value ?? props.options[0]}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
    >
      {props.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function ColorField(props: { value: string | undefined; onChange: (v: string) => void }) {
  const v = props.value ?? "";
  return (
    <span className="color">
      <input
        type="color"
        value={HEX.test(v) ? v : "#000000"}
        onChange={(e) => props.onChange(e.target.value.toUpperCase())}
      />
      <TextField value={v} onChange={props.onChange} width="6em" />
    </span>
  );
}
