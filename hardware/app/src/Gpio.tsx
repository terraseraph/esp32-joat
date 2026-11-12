import { useEffect, useMemo, useState } from "react"
import { api, type GpioMap } from "./api"
import { useToast } from "./toast"

/** display name: the Nets list and the rest of the UI show nets without the source `net.` prefix */
const shown = (n: string) => n.replace(/^net\./, "")

const NEW = "__new__"
const NONE = "__none__"

/** ESP32-S3 GPIO map: each module pin with its net, a dropdown to change it, and clash flags. */
export default function Gpio({ name, source, onSource }: { name: string; source: string; onSource: (s: string) => void }) {
  const toast = useToast()
  const [map, setMap] = useState<GpioMap | null | undefined>(undefined)
  const [filter, setFilter] = useState<"all" | "used" | "flagged">("used")
  const [editing, setEditing] = useState<{ pin: string; text: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      api.gpio(name, source).then((r) => { setMap(r.map); setErr(null) }).catch((e) => setErr(e.message))
    }, 250)
    return () => clearTimeout(t)
  }, [name, source])

  const assign = async (pin: string, net: string | null) => {
    try {
      const r = await api.assignGpio(name, pin, net, source)
      if (!r.changed) {
        setMap(r.map ?? null)
        toast("info", `${pin} not changed: ${r.how}`)
        return
      }
      onSource(r.source)
      setMap(r.map ?? null)
      setEditing(null)
    } catch (e: any) { toast("err", e.message) }
  }

  const flagged = useMemo(() => {
    const s = new Set<string>()
    map?.clashes.forEach((c) => c.pins.forEach((p) => s.add(p)))
    return s
  }, [map])

  if (err) return <div className="empty err">{err}</div>
  if (map === undefined) return <div className="empty">Loading…</div>
  if (!map) return <div className="empty">This design has no ESP32-S3 module (<code>Esp32S3Module</code>), so there is no GPIO map.</div>

  const nets = map.nets.filter((n) => !/^net\.(GND|V3_3)$/.test(n))
  const rows = map.rows.filter((r) => {
    if (filter === "all") return true
    if (filter === "used") return !!r.net
    return flagged.has(r.pin) || r.notes.some((n) => n.level !== "info")
  })

  return (
    <div className="gpio">
      <div className="bom-bar">
        <span className="muted small">{map.component}</span>
        <div className="seg">
          {(["used", "flagged", "all"] as const).map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
        <div className="grow" />
        {map.clashes.length === 0 ? <span className="muted small">No clashes</span> : <span className="cnt bad">{map.clashes.length} clash{map.clashes.length === 1 ? "" : "es"}</span>}
      </div>
      {map.clashes.length > 0 && (
        <ul className="gpio-clashes">{map.clashes.map((c, i) => <li key={i} className={c.level}>{c.text}</li>)}</ul>
      )}
      <div className="table-wrap">
        <table className="bom-table gpio-table">
          <thead><tr><th>Pin</th><th>Net</th><th>Notes</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const isIo = /^IO\d+$/.test(r.pin)
              const worst = r.notes.find((n) => n.level === "error") ? "error" : flagged.has(r.pin) ? "error" : r.notes.some((n) => n.level === "warn") ? "warn" : ""
              return (
                <tr key={r.pin} className={`gpio-${worst}`}>
                  <td className="mono nowrap"><b>{r.pin}</b> <span className="muted small">#{r.pinNumber}</span></td>
                  <td>
                    {!isIo ? (
                      <span className="mono" title={r.isDefault ? "Set by the module block in lib/, not editable here" : "Not a GPIO"}>{r.net ? shown(r.net) : <span className="muted">-</span>}{r.isDefault && <span className="muted small"> (module default)</span>}</span>
                    ) : editing?.pin === r.pin ? (
                      <span className="rename">
                        <input autoFocus className="input mono" placeholder="NET_NAME" value={editing.text}
                          onChange={(e) => setEditing({ pin: r.pin, text: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                          onKeyDown={(e) => { if (e.key === "Enter" && editing.text) assign(r.pin, editing.text); if (e.key === "Escape") setEditing(null) }} />
                        <button className="btn" disabled={!editing.text} onClick={() => assign(r.pin, editing.text)}>Set</button>
                        <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                      </span>
                    ) : (
                      <select className="input mono" value={r.net ?? NONE}
                        onChange={(e) => (e.target.value === NEW ? setEditing({ pin: r.pin, text: "" }) : assign(r.pin, e.target.value === NONE ? null : e.target.value))}>
                        <option value={NONE}>(unconnected)</option>
                        {r.net && !nets.includes(r.net) && <option value={r.net}>{shown(r.net)}</option>}
                        {nets.map((n) => <option key={n} value={n}>{shown(n)}</option>)}
                        <option value={NEW}>New net…</option>
                      </select>
                    )}
                  </td>
                  <td className="small">
                    {r.notes.map((n, i) => <div key={i} className={`gnote ${n.level}`}>{n.level === "error" ? "✖ " : n.level === "warn" ? "⚠ " : ""}{n.text}</div>)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
