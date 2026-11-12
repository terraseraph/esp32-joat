import { useEffect, useRef, useState } from "react"
import type { Comp, Model, Pad } from "./pcbModel"

export type PcbPick = { comp?: string | null; key?: string | null; clear?: boolean; port?: string }
type Pending = { dx: number; dy: number; rot: number }

const SNAPS = [0, 0.1, 0.25, 0.5, 1]
const TOP = "#d4503f"
const BOT = "#4b7fd6"

/**
 * Interactive PCB view drawn straight from circuit JSON (the stock tscircuit PcbViewer cannot report clicks or
 * drag parts). Click a part to select it, drag to move, R rotates, click a pad or trace to highlight its net.
 */
export default function PcbEdit({ model, fitKey, selected, netKey, editable, snap, setSnap, onPick, onMove, onRotate, stale }: {
  model: Model
  fitKey: string
  selected: string | null
  netKey: string | null
  editable: (name: string) => boolean
  snap: number
  setSnap: (s: number) => void
  onPick: (p: PcbPick) => void
  /** dx/dy in mm of the footprint origin; the caller turns this into pcbX/pcbY edits. */
  onMove: (name: string, dx: number, dy: number) => void
  onRotate: (name: string, delta: number) => void
  stale: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ cx: 0, cy: 0, s: 8 })
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<null | { kind: "comp" | "net" | "pan"; comp?: string; key?: string; port?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean; ox?: number; oy?: number }>(null)
  const fitted = useRef("")
  const userView = useRef(false) // set once the user pans or zooms; until then the view keeps fitting the board
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = () => {
    if (!size.w || !size.h) return
    const b = model.board
    const s = Math.min((size.w - 40) / b.w, (size.h - 40) / b.h)
    setView({ cx: b.cx, cy: b.cy, s: Math.max(0.5, s) })
  }
  useEffect(() => {
    if (!size.w || !size.h) return
    if (fitted.current !== fitKey) { fitted.current = fitKey; userView.current = false }
    if (!userView.current) fit() // the first size can be a transient one while the layout settles
  }, [size.w, size.h, fitKey, model.board.w, model.board.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // a fresh build replaces the temporary "moved" preview
  useEffect(() => setPending({}), [model])

  const toWorld = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: v.cx + (clientX - r.left - r.width / 2) / v.s, y: v.cy - (clientY - r.top - r.height / 2) / v.s }
  }

  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      const before = toWorld(e.clientX, e.clientY)
      const s = Math.min(400, Math.max(0.5, v.s * Math.exp(-e.deltaY * 0.0015)))
      const r = el.getBoundingClientRect()
      userView.current = true
      setView({ s, cx: before.x - (e.clientX - r.left - r.width / 2) / s, cy: before.y + (e.clientY - r.top - r.height / 2) / s })
    }
    el.addEventListener("wheel", wheel, { passive: false })
    return () => el.removeEventListener("wheel", wheel)
  }, [])

  const stepOf = snap || 0.1
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest(".cm-editor"))) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === "Escape") return onPick({ clear: true })
      if (!selected) return
      const k = e.key.toLowerCase()
      const bump = (dx: number, dy: number, r: number) => setPending((p) => ({ ...p, [selected]: { dx: (p[selected]?.dx ?? 0) + dx, dy: (p[selected]?.dy ?? 0) + dy, rot: (p[selected]?.rot ?? 0) + r } }))
      if (k === "r" && editable(selected)) { e.preventDefault(); bump(0, 0, e.shiftKey ? -90 : 90); onRotate(selected, e.shiftKey ? -90 : 90) }
      else if (k === "r") { e.preventDefault(); onRotate(selected, 0) }
      const d: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] }
      if (d[k]) { e.preventDefault(); if (editable(selected)) bump(d[k][0] * stepOf, d[k][1] * stepOf, 0); onMove(selected, d[k][0] * stepOf, d[k][1] * stepOf) }
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [selected, onRotate, onMove, onPick, stepOf, editable])

  const snapTo = (v: number) => (snap ? Math.round(v / snap) * snap : v)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const tgt = e.target as Element
    const compEl = tgt.closest("[data-comp]") as HTMLElement | null
    const netEl = tgt.closest("[data-net]") as HTMLElement | null
    const port = (tgt.closest("[data-port]") as HTMLElement | null)?.dataset.port || undefined
    const w = toWorld(e.clientX, e.clientY)
    const base = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.cx, vy: viewRef.current.cy, moved: false }
    if (e.button === 0 && compEl) {
      const c = model.compByName.get(compEl.dataset.comp!)
      drag.current = { ...base, kind: "comp", comp: compEl.dataset.comp, key: netEl?.dataset.net || undefined, port, ox: w.x, oy: w.y }
      void c
    } else if (e.button === 0 && netEl) drag.current = { ...base, kind: "net", key: netEl.dataset.net, port }
    else drag.current = { ...base, kind: "pan" }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy)
    if (!d.moved && dist > 3) d.moved = true
    if (!d.moved) return
    if (d.kind === "pan" || d.kind === "net") {
      const s = viewRef.current.s
      userView.current = true
      setView((v) => ({ ...v, cx: d.vx - (e.clientX - d.sx) / s, cy: d.vy + (e.clientY - d.sy) / s }))
    } else if (d.kind === "comp" && d.comp && editable(d.comp)) {
      const c = model.compByName.get(d.comp)!
      const w = toWorld(e.clientX, e.clientY)
      const dx = snapTo(c.x + w.x - d.ox!) - c.x
      const dy = snapTo(c.y + w.y - d.oy!) - c.y
      setPending((p) => ({ ...p, [d.comp!]: { dx, dy, rot: p[d.comp!]?.rot ?? 0 } }))
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId) } catch {}
    if (d.kind === "comp" && d.comp) {
      if (d.moved) {
        const p = pending[d.comp]
        if (!editable(d.comp)) { onMove(d.comp, 0, 0); setPending({}) }
        else if (p && (p.dx || p.dy)) onMove(d.comp, p.dx, p.dy)
        else setPending({})
      } else onPick({ comp: d.comp, key: d.key ?? null, port: d.port })
    } else if (!d.moved) {
      if (d.kind === "net") onPick({ key: d.key, port: d.port })
      else onPick({ clear: true })
    }
  }

  const b = model.board
  const padFill = (p: Pad) => (netKey && p.key === netKey ? "#ffd23f" : p.layer === "bottom" ? BOT : TOP)
  const op = (key?: string) => (netKey && key !== netKey ? 0.18 : 1)
  const vw = size.w / view.s
  const vh = size.h / view.s
  const rot = (c: Comp) => pending[c.name]

  const renderPad = (p: Pad) => {
    const common = { fill: padFill(p), opacity: op(p.key), "data-net": p.key ?? "", "data-port": p.port ?? "" } as any
    const tf = p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : undefined
    const shape =
      p.kind === "circle" ? <circle cx={p.x} cy={p.y} r={p.w / 2} {...common} />
      : p.kind === "pill" ? <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={Math.min(p.w, p.h) / 2} transform={tf} {...common} />
      : <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} transform={tf} {...common} />
    return (
      <g key={p.id}>
        {shape}
        {p.hole ? <circle cx={p.x} cy={p.y} r={p.hole / 2} fill="#0b1a12" pointerEvents="none" /> : null}
      </g>
    )
  }

  const compGroup = (c: Comp) => {
    const pe = rot(c)
    const t = pe ? `translate(${pe.dx} ${pe.dy}) rotate(${pe.rot} ${c.x} ${c.y})` : undefined
    const sel = selected === c.name
    const dim = netKey && !model.pads.some((p) => p.comp === c.id && p.key === netKey)
    return (
      <g key={c.id} data-comp={c.name} transform={t} opacity={c.layer === "bottom" ? 0.55 : 1} style={{ cursor: editable(c.name) ? "grab" : "pointer" }}
        onPointerEnter={() => setHover(c.name)} onPointerLeave={() => setHover((h) => (h === c.name ? null : h))}>
        <rect x={c.cx - c.w / 2} y={c.cy - c.h / 2} width={c.w} height={c.h} fill={sel ? "rgba(76,201,240,.16)" : hover === c.name ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.02)"}
          stroke={sel ? "#4cc9f0" : hover === c.name ? "#ffffff99" : "none"} strokeWidth={sel ? 2 : 1} vectorEffect="non-scaling-stroke" strokeDasharray={editable(c.name) ? undefined : "4 3"} />
        <g opacity={dim ? 0.5 : 1}>
          {model.outlines.filter((o) => o.comp === c.id).map((o, i) => (
            <polyline key={i} points={o.pts.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="#e9e9e9" strokeWidth={0.12} opacity={0.8} pointerEvents="none" />
          ))}
          {model.pads.filter((p) => p.comp === c.id).map(renderPad)}
          {model.silk.filter((s) => s.comp === c.id).map((s) => (
            <text key={s.id} transform={`translate(${s.x} ${s.y}) scale(1 -1) rotate(${-s.rot})`} fontSize={s.size} fill="#fff" textAnchor="middle" dominantBaseline="middle" pointerEvents="none" fontFamily="monospace">{s.text}</text>
          ))}
        </g>
      </g>
    )
  }

  return (
    <div className="pcbedit" ref={box}>
      <svg width={size.w} height={size.h} viewBox={`${view.cx - vw / 2} ${-view.cy - vh / 2} ${vw} ${vh}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        style={{ touchAction: "none", cursor: drag.current?.moved ? "grabbing" : "default", display: "block" }}>
        <g transform="scale(1 -1)">
          <rect x={b.cx - b.w / 2} y={b.cy - b.h / 2} width={b.w} height={b.h} fill="#17402c" stroke="#caa84a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" rx={0.3} />
          {model.holes.map((h, i) => <circle key={i} cx={h.x} cy={h.y} r={h.d / 2} fill="#0b1a12" stroke="#caa84a" strokeWidth={0.1} />)}
          <g opacity={stale ? 0.35 : 1}>
            {model.traces.map((t) => (
              <polyline key={t.id} points={t.pts.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" strokeLinecap="round" strokeLinejoin="round"
                stroke={netKey && t.key === netKey ? "#ffd23f" : t.layer === "bottom" ? BOT : TOP} strokeWidth={t.width} opacity={t.layer === "bottom" ? op(t.key) * 0.7 : op(t.key)} data-net={t.key ?? ""} />
            ))}
            {model.traces.map((t) => (
              // fat invisible stroke so thin traces are easy to click
              <polyline key={`h${t.id}`} points={t.pts.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max(t.width, 6 / view.s)} data-net={t.key ?? ""} style={{ cursor: "pointer" }} />
            ))}
            {model.vias.map((v) => (
              <g key={v.id} data-net={v.key ?? ""} opacity={op(v.key)}>
                <circle cx={v.x} cy={v.y} r={v.d / 2} fill={netKey && v.key === netKey ? "#ffd23f" : "#9a9a9a"} />
                <circle cx={v.x} cy={v.y} r={v.hole / 2} fill="#0b1a12" />
              </g>
            ))}
          </g>
          {model.comps.map(compGroup)}
        </g>
      </svg>
      <div className="pcbedit-tools" onPointerDown={(e) => e.stopPropagation()}>
        <label className="small muted">Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            {SNAPS.map((s) => <option key={s} value={s}>{s ? `${s} mm` : "off"}</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => { userView.current = false; fit() }}>Fit</button>
      </div>
      <div className="pcbedit-hint small muted">Click part to select · drag to move · arrows nudge · R rotates · click pad/trace for net · Esc clears</div>
    </div>
  )
}
