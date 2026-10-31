/**
 * The editing canvas: an SVG whose user units are millimetres in the part frame. The
 * reference photo is drawn in source pixels under a transform from calib.photoPlacement,
 * so screen -> mm is the SVG's own inverse CTM and mm -> photo pixel is placement.toPx.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Frame, ResolvedConnector } from "../core/resolve.js";
import type { PartSpec } from "../core/schema/part.js";
import { snapMm, type Placement } from "./calib.js";
import { anchorOf, markerLabel, ownerOf, ownerSnaps, type Owner, type Raw } from "./model.js";

export const BASE_PX_PER_MM = 14;

const ROLE_COLOR: Record<string, string> = {
  power: "#d33",
  gnd: "#333",
  io: "#2a6fdb",
  analog: "#1a9a8a",
  pwm: "#8a4bd6",
  i2c: "#c27c0e",
  spi: "#b5179e",
  uart: "#0f8a3c",
  usb: "#555",
  clock: "#a0522d",
  reset: "#e07000",
  enable: "#e07000",
  nc: "#999",
  other: "#666",
};

export interface PhotoLayer {
  url: string;
  widthPx: number;
  heightPx: number;
  placement: Placement;
  opacity: number;
}

export interface CanvasProps {
  raw: Raw;
  spec: PartSpec;
  connectors: ResolvedConnector[];
  frame: Frame;
  photo?: PhotoLayer;
  selected?: string;
  zoom: number;
  snap: boolean;
  /** "points": clicks report photo pixels instead of selecting/dragging. */
  mode: "edit" | "points";
  points: { xMm: number; yMm: number }[];
  onSelect: (key: string | undefined) => void;
  onMove: (owner: Owner, x: number, y: number) => void;
  onPoint: (p: { xMm: number; yMm: number; px?: number; py?: number }) => void;
}

interface Drag {
  owner: Owner;
  start: { x: number; y: number };
  anchor: { x: number; y: number };
  snap: boolean;
  pointerId: number;
}

export function Canvas(props: CanvasProps) {
  const { spec, frame, connectors, photo, zoom } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);

  const margin = 4;
  const vx = -frame.offsetXMm - margin;
  const vy = -frame.offsetYMm - margin;
  const vw = frame.widthMm + 2 * margin;
  const vh = frame.heightMm + 2 * margin;
  const scale = BASE_PX_PER_MM * zoom;

  /** Screen (client) px -> part frame mm through the SVG's own transform. */
  const toMm = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onMarkerDown = (e: ReactPointerEvent, key: string) => {
    if (props.mode !== "edit") return;
    e.stopPropagation();
    e.preventDefault();
    props.onSelect(key);
    const owner = ownerOf(props.raw, key);
    if (!owner) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = {
      owner,
      start: toMm(e),
      anchor: anchorOf(props.raw, owner),
      snap: props.snap || ownerSnaps(props.raw, owner),
      pointerId: e.pointerId,
    };
  };

  const onMoveEvt = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = toMm(e);
    let x = d.anchor.x + (p.x - d.start.x);
    let y = d.anchor.y + (p.y - d.start.y);
    if (d.snap) {
      x = snapMm(x);
      y = snapMm(y);
    }
    props.onMove(d.owner, x, y);
  };

  const onUp = (e: ReactPointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      drag.current = null;
    }
  };

  const onBackground = (e: ReactPointerEvent) => {
    if (props.mode === "points") {
      const p = toMm(e);
      const src = photo?.placement.toPx(p.x, p.y);
      props.onPoint({ xMm: p.x, yMm: p.y, ...(src ? { px: src.px, py: src.py } : {}) });
      return;
    }
    props.onSelect(undefined);
  };

  const o = spec.outline;
  const rx = o.shape === "rounded" ? o.cornerRadiusMm : 0;
  const font = 0.6;

  return (
    <svg
      ref={svgRef}
      className={`canvas ${props.mode === "points" ? "picking" : ""}`}
      width={vw * scale}
      height={vh * scale}
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      onPointerDown={onBackground}
      onPointerMove={onMoveEvt}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <defs>
        <pattern id="grid" width="2.54" height="2.54" patternUnits="userSpaceOnUse">
          <path d="M 2.54 0 L 0 0 0 2.54" fill="none" stroke="#d8dde3" strokeWidth="0.04" />
        </pattern>
      </defs>
      <rect x={vx} y={vy} width={vw} height={vh} fill="url(#grid)" />
      {photo ? (
        <image
          href={photo.url}
          x={0}
          y={0}
          width={photo.widthPx}
          height={photo.heightPx}
          transform={photo.placement.transform}
          opacity={photo.opacity}
          preserveAspectRatio="none"
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {o.shape === "custom" && o.pathMm ? (
        <path d={o.pathMm} className="outline" />
      ) : (
        <rect
          x={0}
          y={0}
          width={o.widthMm}
          height={o.heightMm}
          rx={rx}
          className={photo ? "outline" : "outline filled"}
          style={photo ? undefined : { fill: spec.artwork.boardColor }}
        />
      )}
      {o.holes.map((h, i) => (
        <circle key={i} cx={h.xMm} cy={h.yMm} r={h.dMm / 2} className="hole" />
      ))}
      {spec.headers.map((h) => {
        const quarter = h.orientation === "vertical";
        const along = (h.cols - 1) * h.pitchMm + h.pitchMm;
        const across = (h.rows - 1) * h.pitchMm + h.pitchMm;
        const w = quarter ? across : along;
        const hh = quarter ? along : across;
        return (
          <rect
            key={`hdr-${h.key}`}
            x={h.xMm - h.pitchMm / 2}
            y={h.yMm - h.pitchMm / 2}
            width={w}
            height={hh}
            className="header-body"
          />
        );
      })}
      {connectors.map((c) => {
        const sel = props.selected === c.key;
        const color = ROLE_COLOR[c.role] ?? "#666";
        const w = Math.max(0.6, c.pad.wMm);
        const h = Math.max(0.6, c.pad.hMm);
        const lead = c.lead;
        return (
          <g
            key={c.key}
            className={`marker ${sel ? "selected" : ""}`}
            onPointerDown={(e) => onMarkerDown(e, c.key)}
          >
            {lead ? (
              <line
                x1={lead.fromXMm}
                y1={lead.fromYMm}
                x2={c.xMm}
                y2={c.yMm}
                stroke={lead.color}
                strokeWidth={lead.gaugeMm}
                strokeLinecap="round"
                opacity={0.85}
              />
            ) : null}
            {lead ? (
              <circle cx={lead.fromXMm} cy={lead.fromYMm} r={lead.gaugeMm * 0.7} className="from" />
            ) : null}
            {c.pad.shape === "rect" && !lead ? (
              <rect
                x={c.xMm - w / 2}
                y={c.yMm - h / 2}
                width={w}
                height={h}
                fill={color}
                className="pad"
              />
            ) : (
              <ellipse
                cx={c.xMm}
                cy={c.yMm}
                rx={lead ? 0.8 : w / 2}
                ry={lead ? 0.8 : h / 2}
                fill={color}
                className="pad"
              />
            )}
            <text
              x={c.xMm}
              y={c.yMm - Math.max(h / 2, 0.8) - 0.25}
              fontSize={font}
              textAnchor="middle"
              className="mlabel"
            >
              {c.key}
            </text>
            <text
              x={c.xMm}
              y={c.yMm + font * 0.35}
              fontSize={font * 0.85}
              textAnchor="middle"
              className="mid"
            >
              <title>{markerLabel(c)}</title>#{c.id}
            </text>
          </g>
        );
      })}
      {props.points.map((p, i) => (
        <g key={i} className="pick">
          <line x1={p.xMm - 1} y1={p.yMm} x2={p.xMm + 1} y2={p.yMm} />
          <line x1={p.xMm} y1={p.yMm - 1} x2={p.xMm} y2={p.yMm + 1} />
        </g>
      ))}
      {props.points.length === 2 ? (
        <line
          className="pick"
          x1={props.points[0]!.xMm}
          y1={props.points[0]!.yMm}
          x2={props.points[1]!.xMm}
          y2={props.points[1]!.yMm}
        />
      ) : null}
    </svg>
  );
}
