import { useEffect, useState } from "react"
import { api, type Cost, type Preflight } from "./api"
import "./cost.css"

const usd = (n: number) => `$${n.toFixed(2)}`

/** Pre-flight summary + CPL rotation preview, then the zip download and a link to the JLCPCB quote page. */
export default function ExportPanel({ name, qty, dirty, onClose }: { name: string; qty: number; dirty: boolean; onClose: () => void }) {
  const [pf, setPf] = useState<Preflight | null>(null)
  const [cost, setCost] = useState<Cost | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.preflight(name).then(setPf).catch((e) => setErr(e.message))
    api.cost(name, qty).then(setCost).catch(() => {})
  }, [name, qty])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    addEventListener("keydown", esc)
    return () => removeEventListener("keydown", esc)
  }, [onClose])

  const download = () => {
    const a = document.createElement("a")
    a.href = api.exportUrl(name)
    a.download = `${name}.zip`
    a.click()
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="export-modal" role="dialog" aria-label="Export for JLCPCB">
        <h3>Export for JLCPCB</h3>
        {dirty && <div className="small" style={{ color: "var(--warn)" }}>You have unsaved edits; the export uses the saved files.</div>}
        {err && <div className="empty err small">{err}</div>}
        {!pf && !err && <div className="muted">Checking design…</div>}
        {pf && (
          <>
            <ul className="checks">
              {pf.checks.map((c, i) => (
                <li key={i}>
                  <span className={`dot ${c.level === "ok" ? "good" : c.level === "bad" ? "bad" : ""}`} style={c.level === "warn" ? { background: "var(--warn)" } : undefined} />
                  {c.text}
                </li>
              ))}
              {cost && (
                <li>
                  <span className="dot good" />
                  About <b className="mono">{usd(cost.estimatedPerBoard)}</b>/board, <span className="mono">{usd(cost.estimatedTotal)}</span> for {qty} <span className="muted small">(estimate)</span>
                </li>
              )}
            </ul>
            <CplPreview pf={pf} />
          </>
        )}
        <div className="modal-actions">
          <a className="small" href="https://cart.jlcpcb.com/quote" target="_blank" rel="noreferrer">Open JLCPCB quote page ↗</a>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={download} disabled={!pf}>Download zip</button>
        </div>
      </div>
    </div>
  )
}

/** Parts on the board outline: pads, bounding box, pin-1 pad in red, a line along the CPL rotation. */
function CplPreview({ pf }: { pf: Preflight }) {
  const [hover, setHover] = useState<string | null>(null)
  const { board } = pf
  const pad = 3
  const cx = board.center.x
  const cy = board.center.y
  const viewBox = `${cx - board.width / 2 - pad} ${cy - board.height / 2 - pad} ${board.width + pad * 2} ${board.height + pad * 2}`
  const hov = hover ? pf.cpl.find((x) => x.ref === hover) : null
  return (
    <div>
      <div className="cpl-wrap">
        <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
          {/* board y points up, svg y points down: flip about the board centre */}
          <g transform={`matrix(1 0 0 -1 0 ${2 * cy})`}>
            {board.outline ? (
              <polygon points={board.outline.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--muted)" strokeWidth={0.4} />
            ) : (
              <rect x={cx - board.width / 2} y={cy - board.height / 2} width={board.width} height={board.height} fill="none" stroke="var(--muted)" strokeWidth={0.4} />
            )}
            {pf.cpl.map((c) => {
              const len = Math.max(c.w, c.h) * 0.6 + 0.5
              const a = (c.rotation * Math.PI) / 180
              const color = c.layer === "bottom" ? "#8b5cf6" : "var(--accent)"
              return (
                <g key={c.ref} onMouseEnter={() => setHover(c.ref)} onMouseLeave={() => setHover(null)} opacity={hover && hover !== c.ref ? 0.3 : 1}>
                  <rect x={c.x - c.w / 2} y={c.y - c.h / 2} width={c.w} height={c.h} fill="transparent" stroke={color} strokeWidth={0.15} />
                  {c.pads.map((p, i) =>
                    p.round ? (
                      <circle key={i} cx={p.x} cy={p.y} r={p.w / 2} fill={p.pin1 ? "var(--bad)" : color} opacity={0.8} />
                    ) : (
                      <rect key={i} x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} fill={p.pin1 ? "var(--bad)" : color} opacity={0.8} />
                    ),
                  )}
                  <line x1={c.x} y1={c.y} x2={c.x + Math.cos(a) * len} y2={c.y + Math.sin(a) * len} stroke="var(--text)" strokeWidth={0.25} />
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      <div className="cpl-legend">
        <span><span style={{ color: "var(--bad)" }}>●</span> pin 1 pad</span>
        <span>line = CPL rotation (0° points right)</span>
        <span style={{ color: "var(--accent)" }}>■ top</span>
        <span style={{ color: "#8b5cf6" }}>■ bottom</span>
        <span className="mono">{hov ? `${hov.ref}  ${hov.x}, ${hov.y} mm  ${hov.rotation}°  ${hov.layer}` : "hover a part for its CPL row"}</span>
      </div>
    </div>
  )
}
