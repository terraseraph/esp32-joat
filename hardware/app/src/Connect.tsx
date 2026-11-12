import { useMemo, useState } from "react"
import { api, type PinRefT } from "./api"
import { useToast } from "./toast"
import { suggestNetName, type CircuitIndex } from "../../shared/nets"

export type ConnectState = { on: boolean; picks: PinRefT[]; highlightNet: string | null }
export const NO_CONNECT: ConnectState = { on: false, picks: [], highlightNet: null }

type Props = {
  name: string
  index: CircuitIndex | null
  source: string
  onSource: (src: string) => void
  state: ConnectState
  setState: (f: (s: ConnectState) => ConnectState) => void
}

const label = (p?: PinRefT) => (p ? `${p.ref}.${p.pin}` : "click a pin…")
const netKey = (n: string) => (n.startsWith("net.") ? n : `net.${n}`)

/** Connect mode (click pin A, pin B, pick a net) + the nets list with highlight and rename. */
export default function Connect({ name, index, source, onSource, state, setState }: Props) {
  const toast = useToast()
  const [choice, setChoice] = useState("") // "" = existing-or-auto
  const [custom, setCustom] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [a, b] = state.picks

  const portNet = (p?: PinRefT) => (p && index ? index.components.find((c) => c.ref === p.ref)?.pins.find((x) => x.pin === p.pin)?.net : undefined)
  const named = (n?: string) => (n && !n.startsWith("(unnamed") ? n : undefined)
  const taken = useMemo(() => (index?.nets ?? []).map((n) => n.name), [index])
  const existing = named(portNet(a)) ?? named(portNet(b))
  const suggestion = a ? suggestNetName(a, b, taken) : ""
  const effective = custom.trim() || choice || existing || suggestion

  const setPick = (i: 0 | 1, ref: string, pin: string) =>
    setState((s) => {
      const picks = [...s.picks]
      picks[i] = { ref, pin }
      if (!ref || !pin) picks.length = Math.min(picks.length, i)
      return { ...s, picks }
    })

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true)
    try { return await fn() } catch (e: any) { toast("err", e.message); return null } finally { setBusy(false) }
  }

  const apply = async () => {
    if (!a) return
    const r = await run(() => api.connect(name, a, b, effective, source), "")
    if (!r) return
    if (!r.changed) return toast("info", `Already connected (${r.how})`)
    onSource(r.source)
    toast("ok", `${label(a)}${b ? ` ↔ ${label(b)}` : ""} on ${r.net}`)
    setState((s) => ({ ...s, picks: [] }))
    setChoice(""); setCustom("")
  }

  const rename = async () => {
    if (!renaming) return
    let r: any = null
    setBusy(true)
    try {
      r = await api.renameNet(name, renaming.from, renaming.to, source)
    } catch (e: any) {
      if (/force:true/.test(e.message) && confirm(`${e.message.split(" Pass force")[0]}\n\nRename only the index.tsx references anyway?`)) {
        try { r = await api.renameNet(name, renaming.from, renaming.to, source, true) } catch (e2: any) { toast("err", e2.message) }
      } else if (!/force:true/.test(e.message)) toast("err", e.message)
    } finally { setBusy(false) }
    if (!r) return
    onSource(r.source)
    toast("ok", `Renamed ${r.count} reference${r.count === 1 ? "" : "s"}`)
    setRenaming(null)
  }

  const comps = index?.components.filter((c) => c.pins.length) ?? []
  const picker = (i: 0 | 1, p?: PinRefT) => (
    <span className="pin-pick">
      <select className="input" value={p?.ref ?? ""} onChange={(e) => setPick(i, e.target.value, e.target.value ? index!.components.find((c) => c.ref === e.target.value)!.pins[0]?.pin ?? "" : "")}>
        <option value="">{i ? "B component" : "A component"}</option>
        {comps.map((c) => <option key={c.ref} value={c.ref}>{c.ref}</option>)}
      </select>
      <select className="input" disabled={!p?.ref} value={p?.pin ?? ""} onChange={(e) => p && setPick(i, p.ref, e.target.value)}>
        {(index?.components.find((c) => c.ref === p?.ref)?.pins ?? []).map((x) => <option key={x.pin + x.sourcePortId} value={x.pin}>{x.pin}{x.net ? ` (${x.net})` : ""}</option>)}
      </select>
    </span>
  )

  return (
    <div className="connect">
      <div className="connect-bar">
        <button className={`btn ${state.on ? "primary" : ""}`} onClick={() => setState((s) => ({ ...s, on: !s.on, picks: [] }))}>
          {state.on ? "Connect mode: on" : "Connect mode"}
        </button>
        <span className={`pick ${a ? "set" : ""}`}>A: {label(a)}</span>
        <span className="muted">→</span>
        <span className={`pick ${b ? "set" : ""}`}>B: {label(b)}</span>
        <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!a} title="Net to put the pins on">
          <option value="">{existing ? `Join ${existing}` : a ? `New net ${suggestion}` : "Net"}</option>
          {existing && <option value={suggestion}>New net {suggestion}</option>}
          {(index?.nets ?? []).filter((n) => n.name !== existing && !n.name.startsWith("(unnamed")).map((n) => <option key={n.key} value={n.name}>{n.name}</option>)}
        </select>
        <button className="btn primary" disabled={!a || busy} onClick={apply}>Connect</button>
        <button className="btn ghost" disabled={!state.picks.length} onClick={() => setState((s) => ({ ...s, picks: [] }))}>Clear</button>
        <span className="grow" />
        {state.on && <span className="muted small">Click pins in the schematic. Two clicks = a connection; one pin + a net = add to net.</span>}
      </div>
      <details className="connect-adv">
        <summary>Advanced: pick pins from lists, custom net name</summary>
        <div className="connect-adv-row">
          {picker(0, a)}
          {picker(1, b)}
          <input className="input mono" placeholder="custom net name" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^A-Za-z0-9_.]/g, ""))} />
        </div>
      </details>

      <div className="nets-head muted small">{index ? `${index.nets.length} nets` : "No build yet"} · click a net to highlight it in the schematic</div>
      <table className="bom-table nets-table">
        <thead><tr><th>Net</th><th className="r">Pins</th><th>Used by</th><th /></tr></thead>
        <tbody>
          {(index?.nets ?? []).map((n) => {
            const sel = state.highlightNet === n.name
            const unnamed = n.name.startsWith("(unnamed")
            return (
              <FragmentRow key={n.key}>
                <tr className={sel ? "sel" : ""} onClick={() => { setState((s) => ({ ...s, highlightNet: sel ? null : n.name })); setOpen(open === n.name ? null : n.name) }}>
                  <td className="mono">
                    {renaming?.from === n.name ? (
                      <span onClick={(e) => e.stopPropagation()} className="rename">
                        <input autoFocus className="input mono" value={renaming.to.replace(/^net\./, "")} onChange={(e) => setRenaming({ from: n.name, to: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                          onKeyDown={(e) => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(null) }} />
                        <button className="btn" disabled={busy || !renaming.to || renaming.to === n.name} onClick={rename}>Rename</button>
                        <button className="btn ghost" onClick={() => setRenaming(null)}>Cancel</button>
                      </span>
                    ) : n.name}
                    {n.isGround && <span className="chip">gnd</span>} {n.isPower && <span className="chip">power</span>}
                  </td>
                  <td className="r">{n.pins.length}</td>
                  <td className="muted small">{n.components.slice(0, 8).join(", ")}{n.components.length > 8 ? ` +${n.components.length - 8}` : ""}</td>
                  <td className="r nowrap">
                    {!unnamed && renaming?.from !== n.name && (
                      <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setRenaming({ from: n.name, to: n.name }) }}>Rename</button>
                    )}
                  </td>
                </tr>
                {open === n.name && (
                  <tr className="net-pins"><td colSpan={4}>
                    {n.pins.map((p) => (
                      <button key={p.sourcePortId} className="chip pin-chip" title="Use as pin A / B"
                        onClick={(e) => { e.stopPropagation(); setState((s) => ({ ...s, on: true, picks: s.picks.length >= 2 ? [{ ref: p.ref, pin: p.pin }] : [...s.picks, { ref: p.ref, pin: p.pin }] })) }}>
                        {p.ref}.{p.pin}
                      </button>
                    ))}
                  </td></tr>
                )}
              </FragmentRow>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</> }
export { netKey }
