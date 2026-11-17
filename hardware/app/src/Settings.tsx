import { useCallback, useEffect, useState } from "react"
import { aiApi, type AiProvider } from "./api"
import { useToast } from "./toast"

type Models = { id: string; label: string }[]

function ProviderCard({ p, onChange }: { p: AiProvider; onChange: () => void }) {
  const toast = useToast()
  const [key, setKey] = useState("")
  const [model, setModel] = useState(p.model)
  const [models, setModels] = useState<Models>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setModel((m) => m || p.model) }, [p.model])

  const test = async () => {
    setBusy("test"); setNote(null)
    try {
      const r = await aiApi.models(p.id, key.trim() || undefined)
      setModels(r.models)
      setNote({ ok: true, text: `Connected. ${r.models.length} models available.` })
      if (!model && r.models[0]) setModel(r.models[0].id)
    } catch (e: any) { setNote({ ok: false, text: e.message }) } finally { setBusy("") }
  }
  const save = async () => {
    setBusy("save")
    try {
      await aiApi.configure(p.id, model.trim(), key.trim() || undefined)
      setKey("")
      toast("ok", `${p.label} saved`)
      onChange()
    } catch (e: any) { toast("err", e.message) } finally { setBusy("") }
  }
  const disconnect = async () => {
    setBusy("off")
    try { await aiApi.disconnect(p.id); setModel(""); setModels([]); setNote(null); toast("ok", `${p.label} disconnected`); onChange() } catch (e: any) { toast("err", e.message) } finally { setBusy("") }
  }
  const options = model && !models.some((m) => m.id === model) ? [{ id: model, label: model }, ...models] : models

  return (
    <section className="panel-card provider">
      <div className="row between">
        <h2>{p.label}</h2>
        <span className={`status-chip ${p.configured ? "s-ready" : "s-draft"}`}><i aria-hidden>{p.configured ? "✓" : "◌"}</i>{p.configured ? `Connected${p.source === "env" ? " (from environment)" : ""}` : "Not connected"}</span>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>API key</span>
          <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={p.configured ? "Key saved. Enter a new one to replace it" : "Paste your API key"} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="field">
          <span>Model</span>
          {options.length > 0 ? (
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          ) : (
            <input className="input" placeholder="Model ID, or test the connection to pick one" value={model} onChange={(e) => setModel(e.target.value)} />
          )}
        </label>
      </div>
      {note && <p className={`small ${note.ok ? "t-ok-text" : "t-bad-text"}`} role="status">{note.text}</p>}
      <div className="row">
        <button className="btn" onClick={test} disabled={!!busy || (!key.trim() && !p.configured)}>{busy === "test" ? "Testing…" : "Test connection"}</button>
        <button className="btn primary" onClick={save} disabled={!!busy || !model.trim() || (!key.trim() && !p.configured)}>{busy === "save" ? "Saving…" : "Save"}</button>
        <span className="grow" />
        {p.configured && p.source !== "env" && <button className="btn ghost" onClick={disconnect} disabled={!!busy}>Disconnect</button>}
      </div>
    </section>
  )
}

export default function Settings({ theme, toggleTheme }: { theme: "light" | "dark"; toggleTheme: () => void }) {
  const [providers, setProviders] = useState<AiProvider[] | null>(null)
  const [err, setErr] = useState("")
  const load = useCallback(() => { aiApi.providers().then(setProviders).catch((e) => setErr(e.message)) }, [])
  useEffect(load, [load])
  return (
    <div className="page-wrap narrow">
      <div className="page-head"><div><h1>Settings</h1><p className="muted">The same providers power the AI builder in every board.</p></div></div>

      <h2 className="section-title">AI providers</h2>
      <p className="muted small">An entered key is kept in the local API's memory only and is cleared when it restarts. To keep one, put it in <span className="mono">hardware/.env</span> (for example <span className="mono">ANTHROPIC_API_KEY</span>); that file is git-ignored.</p>
      {err && <div className="empty err">{err}</div>}
      {!providers && !err && <div className="empty">Loading…</div>}
      {providers?.map((p) => <ProviderCard key={p.id} p={p} onChange={load} />)}

      <h2 className="section-title">Appearance</h2>
      <section className="panel-card">
        <div className="row between">
          <div><b>Theme</b><div className="muted small">Currently {theme}. Follows your system until you change it.</div></div>
          <button className="btn" onClick={toggleTheme}>Switch to {theme === "dark" ? "light" : "dark"}</button>
        </div>
      </section>
    </div>
  )
}
