import { useEffect, useState } from "react"
import { api, type Cost } from "./api"
import "./cost.css"

const usd = (n: number) => `$${n.toFixed(2)}`

/** Always-visible per-board cost in the toolbar. Click opens the BOM tab. */
export default function CostChip({ name, qty, version, onOpen }: { name: string; qty: number; version: number; onOpen: () => void }) {
  const [cost, setCost] = useState<Cost | null>(null)
  const [err, setErr] = useState(false)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    let live = true
    setErr(false)
    api.cost(name, qty).then((c) => live && setCost(c)).catch(() => live && setErr(true))
    return () => { live = false }
  }, [name, qty, version])

  return (
    <div className="cost-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className={`cost-chip ${cost && cost.missingCount ? "warn" : ""}`} onClick={onOpen} title="Open BOM & cost">
        {cost ? (
          <>
            <b className="mono">{usd(cost.estimatedPerBoard)}</b>
            <span className="muted small">/board @ {qty}</span>
            <span className="est">est.</span>
          </>
        ) : (
          <span className="muted small">{err ? "Cost unavailable" : "Cost…"}</span>
        )}
      </button>
      {hover && cost && (
        <div className="cost-pop">
          <div className="row"><span>Parts</span><span className="mono">{usd(cost.partsCostPerBoard)}</span></div>
          <div className="row"><span>Extended fees ({cost.extendedTypes} × $3 ÷ {qty})</span><span className="mono">{usd(cost.extendedFeesPerBoard)}</span></div>
          <div className="row"><span>PCB fab (est.)</span><span className="mono">{usd(cost.fab.fabPerBoard)}</span></div>
          <div className="row"><span>Assembly (est.)</span><span className="mono">{usd(cost.fab.assemblyPerBoard)}</span></div>
          <div className="row total"><span>Total @ {qty} <span className="muted small">est.</span></span><span className="mono">{usd(cost.estimatedTotal)}</span></div>
          <div className="muted small" style={{ marginTop: 4 }}>
            Parts and fees come from jlcsearch; fab and assembly are a rough {cost.fab.layers}-layer list-price estimate (no shipping or tax).
            {cost.missingCount > 0 && ` ${cost.missingCount} part(s) unpriced.`}
          </div>
        </div>
      )}
    </div>
  )
}
