import type { DiffItem, DiffResult } from "./api"

export const KIND_COLOR: Record<DiffItem["kind"], string> = { added: "#22a559", removed: "#e5484d", moved: "#e8a317", changed: "#3b82f6" }

/** Top-down board map of a revision diff: unchanged parts grey, added green, removed red (dashed, at the old
 *  position), moved amber (ghost at the old position + line), changed blue. Drawn from the circuit JSON
 *  geometry rather than over the tscircuit viewer, whose pan/zoom transform is not exposed. */
export default function DiffView({ diff, focus, onFocus, onClose, label }: {
  diff: DiffResult; focus: string | null; onFocus: (n: string | null) => void; onClose: () => void; label: string
}) {
  const b = diff.board ?? { x: 0, y: 0, w: 100, h: 80 }
  const m = Math.max(b.w, b.h) * 0.06
  const fs = Math.max(b.w, b.h) / 55
  const rect = (c: { x?: number; y?: number; w?: number; h?: number }) =>
    c.x === undefined || c.y === undefined ? null : { w: Math.max(c.w ?? 1, 0.4), h: Math.max(c.h ?? 1, 0.4) }
  const dash = `${b.w / 150} ${b.w / 200}`
  // PCB y points up, SVG y points down: every y below is negated.
  return (
    <div className="diffview">
      <div className="tabs">
        <span className="tab-label pad-l">Revision diff · {label}</span>
        <div className="grow" />
        <div className="legend">
          {(Object.keys(KIND_COLOR) as DiffItem["kind"][]).map((k) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k} {diff.counts[k]}</span>
          ))}
        </div>
        <button className="btn ghost" onClick={onClose}>Close diff</button>
      </div>
      <svg viewBox={`${b.x - b.w / 2 - m} ${-(b.y + b.h / 2) - m} ${b.w + 2 * m} ${b.h + 2 * m}`} preserveAspectRatio="xMidYMid meet" onClick={() => onFocus(null)}>
        <rect x={b.x - b.w / 2} y={-(b.y + b.h / 2)} width={b.w} height={b.h} fill="none" stroke="var(--muted)" strokeWidth={b.w / 400} />
        {diff.unchanged.map((c) => {
          const r = rect(c)
          return r && <rect key={c.name} x={c.x! - r.w / 2} y={-c.y! - r.h / 2} width={r.w} height={r.h} fill="var(--panel2)" stroke="var(--border)" strokeWidth={b.w / 700} />
        })}
        {diff.items.map((it) => {
          const r = rect(it)
          if (!r) return null
          const col = KIND_COLOR[it.kind]
          const cx = it.x!, cy = -it.y!
          const ghost = it.fromX !== undefined && (it.fromX !== it.x || it.fromY !== it.y)
          return (
            <g key={it.name} onClick={(e) => { e.stopPropagation(); onFocus(it.name) }} style={{ cursor: "pointer" }} opacity={focus && focus !== it.name ? 0.4 : 1}>
              {ghost && (
                <>
                  <rect x={it.fromX! - r.w / 2} y={-it.fromY! - r.h / 2} width={r.w} height={r.h} fill="none" stroke={col} strokeDasharray={dash} strokeWidth={b.w / 600} opacity={0.7} />
                  <line x1={it.fromX} y1={-it.fromY!} x2={cx} y2={cy} stroke={col} strokeWidth={b.w / 600} opacity={0.8} />
                </>
              )}
              <rect x={cx - r.w / 2} y={cy - r.h / 2} width={r.w} height={r.h} fill={col} fillOpacity={it.kind === "removed" ? 0.12 : 0.35} stroke={col} strokeWidth={(focus === it.name ? 3 : 1.4) * (b.w / 450)} strokeDasharray={it.kind === "removed" ? dash : undefined} />
              <text x={cx} y={cy - r.h / 2 - fs * 0.3} fontSize={fs} textAnchor="middle" fill="var(--text)" style={{ fontFamily: "var(--mono)" }}>{it.name}</text>
            </g>
          )
        })}
      </svg>
      {diff.boardChange && <div className="diff-note">{diff.boardChange}</div>}
    </div>
  )
}
