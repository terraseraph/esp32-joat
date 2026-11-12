import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type Bom as BomT, type BomRow } from "./api"
import { useToast } from "./toast"

const QTYS = [5, 10, 30, 100]
const usd = (n: number, d = 2) => `$${(n ?? 0).toFixed(d)}`

function Badge({ r }: { r: BomRow }) {
  if (r.missing) return <span className="badge missing">Missing</span>
  if (r.basic) return <span className="badge basic">Basic</span>
  if (r.preferred) return <span className="badge preferred">Preferred</span>
  if (r.extended) return <span className="badge extended">Extended +$3</span>
  return <span className="badge">-</span>
}

export default function Bom({ name, version, dirty }: { name: string; version: number; dirty: boolean }) {
  const [qty, setQty] = useState(10)
  const [custom, setCustom] = useState("")
  const [bom, setBom] = useState<BomT | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toast = useToast()

  const load = (refresh = false) => {
    setLoading(true)
    api.bom(name, qty, refresh)
      .then((b) => { setBom(b); setErr(null); if (refresh) toast("ok", "Prices refreshed") })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [name, qty, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const isCustom = !QTYS.includes(qty)
  const s = bom?.summary

  return (
    <div className="bom">
      <div className="bom-bar">
        <span className="muted small">Quantity</span>
        <div className="seg">
          {QTYS.map((q) => (
            <button key={q} className={qty === q ? "on" : ""} onClick={() => { setQty(q); setCustom("") }}>{q}</button>
          ))}
          <input
            className={`seg-input mono ${isCustom ? "on" : ""}`}
            placeholder="custom"
            inputMode="numeric"
            value={custom}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "")
              setCustom(v)
              if (+v > 0) setQty(+v)
            }}
          />
        </div>
        <div className="grow" />
        {dirty && <span className="muted small">BOM reflects saved files</span>}
        <button className="btn" disabled={loading} onClick={() => load(true)}>{loading ? "Loading…" : "Refresh prices"}</button>
      </div>

      {err && <div className="empty err small">{err}</div>}
      {!bom && !err && <div className="empty small">Loading BOM…</div>}

      <AnimatePresence>
        {bom && s && (
          <motion.div key="bom" className="bom-body" initial={{ opacity: 0, y: 6 }} animate={{ opacity: loading ? 0.6 : 1, y: 0 }} transition={{ duration: 0.18 }}>
            <div className="summary">
              <Stat label="Parts / board" value={usd(s.partsCostPerBoard)} />
              <Stat label={`Extended ${s.extendedTypes} × ${usd(s.setupFeePerType, 0)}`} value={usd(s.setupFees)} warn={s.extendedTypes > 0} />
              <Stat label="Cost / board" value={usd(s.costPerBoard)} strong />
              <Stat label={`Total @ ${bom.qty}`} value={usd(s.totalAtQty)} strong />
              {s.missingCount > 0 && <Stat label="Missing parts" value={String(s.missingCount)} bad />}
            </div>
            <div className="table-wrap">
              <table className="bom-table">
                <thead>
                  <tr><th>Refs</th><th>Part</th><th>LCSC</th><th>Type</th><th className="r">Qty</th><th className="r">Unit</th><th className="r">Line</th><th className="r">Stock</th></tr>
                </thead>
                <tbody>
                  {bom.rows.map((r, i) => (
                    <motion.tr
                      key={r.lcsc || r.refs.join()}
                      className={r.missing ? "missing" : r.extended ? "extended" : ""}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.16, delay: Math.min(i, 12) * 0.02 }}
                    >
                      <td className="mono nowrap" title={r.refs.join(", ")}>{compactRefs(r.refs)}</td>
                      <td><div>{r.mfr || r.description}</div><div className="muted small">{r.package}</div></td>
                      <td className="mono">
                        {r.lcsc ? <a href={`https://jlcpcb.com/partdetail/${r.lcsc}`} target="_blank" rel="noreferrer">{r.lcsc}</a> : "-"}
                      </td>
                      <td><Badge r={r} /></td>
                      <td className="r mono">{r.qtyPerBoard}</td>
                      <td className="r mono">{r.missing ? "-" : usd(r.unitPrice, 4)}</td>
                      <td className="r mono">{r.missing ? "-" : usd(r.lineCostPerBoard, 3)}</td>
                      <td className={`r mono ${r.stock < bom.qty * r.qtyPerBoard ? "low" : ""}`}>{r.stock?.toLocaleString() ?? "-"}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
              {bom.rows.length === 0 && <div className="empty small">No parts on this board.</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Stat({ label, value, strong, warn, bad }: { label: string; value: string; strong?: boolean; warn?: boolean; bad?: boolean }) {
  return (
    <div className={`stat ${strong ? "strong" : ""} ${warn ? "warn" : ""} ${bad ? "bad" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
    </div>
  )
}

/** R1,R2,R3,R5 -> R1–R3, R5 */
function compactRefs(refs: string[]): string {
  const parsed = refs.map((r) => { const m = /^(.*?)(\d+)$/.exec(r); return m ? { p: m[1], n: +m[2], r } : { p: r, n: NaN, r } })
  parsed.sort((a, b) => a.p.localeCompare(b.p) || a.n - b.n)
  const out: string[] = []
  for (let i = 0; i < parsed.length; ) {
    let j = i
    while (j + 1 < parsed.length && parsed[j + 1].p === parsed[i].p && parsed[j + 1].n === parsed[j].n + 1) j++
    out.push(j - i >= 2 ? `${parsed[i].r}–${parsed[j].r}` : parsed.slice(i, j + 1).map((x) => x.r).join(", "))
    i = j + 1
  }
  return out.join(", ")
}
