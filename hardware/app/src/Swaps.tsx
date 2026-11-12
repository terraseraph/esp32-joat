import { useEffect, useState } from "react"
import { api, type Swaps as SwapsT } from "./api"
import { useToast } from "./toast"
import "./cost.css"

const usd = (n: number, d = 2) => `$${n.toFixed(d)}`

/** "Swap to Basic" suggestions shown above the BOM table. */
export default function Swaps({ name, qty, version, dirty, onChanged }: {
  name: string; qty: number; version: number; dirty: boolean; onChanged: (changed: Record<string, string>) => void
}) {
  const toast = useToast()
  const [data, setData] = useState<SwapsT | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setErr(null)
    api.swaps(name, qty).then((d) => live && setData(d)).catch((e) => live && setErr(e.message))
    return () => { live = false }
  }, [name, qty, version])

  const apply = async (from: string, to: string) => {
    setBusy(from)
    try {
      const r = await api.applySwap(name, from, to)
      onChanged(r.changed)
      if (r.libFiles.length) toast("info", `Design parts swapped, but ${r.libFiles.join(", ")} still use ${from}: change it there too`)
      else toast("ok", `Swapped ${from} → ${to}`)
    } catch (e: any) {
      toast("err", e.message)
    } finally {
      setBusy(null)
    }
  }

  if (err) return <div className="swaps"><div className="swaps-head muted small">Swap suggestions unavailable: {err}</div></div>
  if (!data) return <div className="swaps"><div className="swaps-head muted small">Looking for Basic-part swaps…</div></div>
  const total = data.swaps.reduce((s, x) => s + x.savingTotal, 0)
  if (!data.swaps.length)
    return (
      <div className="swaps">
        <div className="swaps-head muted small">
          No Basic/Preferred swaps found{data.skipped.length ? ` (${data.skipped.length} part types can't be matched automatically)` : ""}.
        </div>
      </div>
    )

  return (
    <div className="swaps">
      <div className="swaps-head">
        <span>Swap to Basic</span>
        <span className="save-tag">save {usd(total)} @ {qty}</span>
        {dirty && <span className="muted small">Save your edits first to apply swaps</span>}
      </div>
      {data.swaps.map((s) => (
        <div className="swap-row" key={s.from}>
          <div className="grow">
            <div><span className="mono">{(s.canApply ? s.designRefs : s.refs).join(", ")}</span> <span className="muted small">{s.package}</span></div>
            <div className="small muted">
              <span className="mono">{s.from}</span> {s.current.mfr} ({usd(s.current.unitPrice, 4)}) → <span className="mono">{s.to}</span> {s.alternative.mfr} ({usd(s.alternative.unitPrice, 4)}, {s.alternative.basic ? "Basic" : "Preferred"})
            </div>
            {s.hint && <div className="small" style={{ color: "var(--warn)" }}>{s.hint}</div>}
          </div>
          <span className="save-tag">−{usd(s.savingTotal)}</span>
          <button className="btn" disabled={!s.canApply || dirty || busy === s.from} onClick={() => apply(s.from, s.to)}>
            {busy === s.from ? "Applying…" : "Swap"}
          </button>
        </div>
      ))}
    </div>
  )
}
