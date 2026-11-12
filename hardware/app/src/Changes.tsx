import { useCallback, useEffect, useState } from "react"
import { api, type DesignRequest, type Proposal } from "./api"
import { useToast } from "./toast"

/** "Describe a change": the user files a request; Claude answers through the API with a proposal the user accepts or rejects. */
export default function Changes({ name, dirty, onAccepted }: { name: string; dirty: boolean; onAccepted: (files: Record<string, string>) => void }) {
  const toast = useToast()
  const [text, setText] = useState("")
  const [reqs, setReqs] = useState<DesignRequest[]>([])
  const [props, setProps] = useState<Proposal[]>([])

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([api.requests(name), api.proposals(name)])
      setReqs(r.filter((x) => x.status === "open"))
      setProps(p)
    } catch {}
  }, [name])
  useEffect(() => {
    load()
    const t = setInterval(load, 4000) // Claude submits proposals out-of-band
    return () => clearInterval(t)
  }, [load])

  const send = async () => {
    if (!text.trim()) return
    try { await api.addRequest(name, text.trim()); setText(""); toast("ok", "Request saved. Ask Claude to look at pending requests."); load() } catch (e: any) { toast("err", e.message) }
  }
  const accept = async (p: Proposal, force = false): Promise<void> => {
    if (dirty) return toast("err", "Save or discard your editor changes first, then accept")
    try { const r = await api.acceptProposal(name, p.id, force); toast("ok", "Change applied"); onAccepted(r.files); load() }
    catch (e: any) {
      if (/changed since/.test(e.message) && confirm(`${e.message}\n\nApply anyway and overwrite?`)) return accept(p, true)
      toast("err", e.message)
    }
  }
  const reject = async (p: Proposal) => { try { await api.rejectProposal(name, p.id); load() } catch (e: any) { toast("err", e.message) } }

  return (
    <div className="changes">
      <div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe a change, e.g. add a TVS diode on the 5 V input" onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send() }} />
        <div className="row end"><span className="muted small">Saved as a pending request; Claude replies with a proposal you review below.</span><div className="grow" /><button className="btn primary" onClick={send} disabled={!text.trim()}>Send request</button></div>
      </div>
      {reqs.map((r) => (
        <div className="card row between" key={r.id}>
          <span><span className="chip">pending</span>{r.text}</span>
          <button className="btn ghost" onClick={async () => { await api.resolveRequest(name, r.id, "dismissed"); load() }}>Dismiss</button>
        </div>
      ))}
      {props.map((p) => (
        <div className="card" key={p.id}>
          <div className="row between">
            <strong>{p.summary}</strong>
            <span className="row"><button className="btn ghost" onClick={() => reject(p)}>Reject</button><button className="btn primary" onClick={() => accept(p)} disabled={dirty} title={dirty ? "Save your editor changes first" : undefined}>Accept</button></span>
          </div>
          {p.stale.length > 0 && <div className="small" style={{ color: "var(--warn)" }}>Files changed since this was proposed: {p.stale.join(", ")}</div>}
          {p.diffs.map((d) => (
            <div key={d.file}>
              {d.shared && <div className="shared-warn">Shared block: this affects every design that imports it ({d.shared.length ? d.shared.join(", ") : "none found"}).</div>}
              <div className="diff-file">{d.file} <span className="muted">({d.status}, +{d.added} −{d.removed})</span></div>
              <div className="diff">{d.lines.map((l, i) => <div key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : ""}>{l.t} {l.s}</div>)}</div>
            </div>
          ))}
        </div>
      ))}
      {!reqs.length && !props.length && <div className="muted small">No pending requests or proposals.</div>}
    </div>
  )
}
