import { useCallback, useEffect, useState } from "react"
import { aiApi, type AiProvider } from "./api"
import { useToast } from "./toast"
import { isUsable, pickProvider, savePrefs, useAiPrefs } from "./aiPrefs"

type Models = { id: string; label: string }[]

function ProviderCard({ p, onChange }: { p: AiProvider; onChange: () => void }) {
  const toast = useToast()
  const prefs = useAiPrefs()
  const ready = p.configured && !!p.model
  const enabled = ready && !prefs.disabled.includes(p.id)
  const toggle = (on: boolean) => savePrefs({ disabled: on ? prefs.disabled.filter((x) => x !== p.id) : [...new Set([...prefs.disabled, p.id])] })
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
      const r = await aiApi.configure(p.id, model.trim(), key.trim() || undefined)
      setKey("")
      if (r?.saved === false) toast("err", `${p.label} works for now but could not be saved to disk (${r.saveError ?? "write failed"}). It will be lost when the API restarts.`)
      else toast("ok", `${p.label} saved on this machine`)
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
        <span className={`status-chip ${enabled ? "s-ready" : "s-draft"}`}><i aria-hidden>{enabled ? "✓" : p.configured ? "–" : "◌"}</i>{!p.configured ? "Not connected" : !ready ? "Needs a model" : enabled ? `In use${p.source === "env" ? " (from environment)" : p.source === "session" ? " (this session only)" : ""}` : "Switched off"}</span>
      </div>
      <label className={`switch-row ${ready ? "" : "off"}`}>
        <input type="checkbox" role="switch" checked={enabled} disabled={!ready} onChange={(e) => toggle(e.target.checked)} />
        <span><b>Use in the AI builder</b><small className="muted">{ready ? (enabled ? "Offered in the builder's provider list." : "Hidden from the builder until switched on.") : "Add a key and choose a model first; a provider without both cannot be used."}</small></span>
      </label>
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
        {p.configured && p.source !== "env" && <button className="btn ghost" onClick={disconnect} disabled={!!busy}>Forget key</button>}
      </div>
    </section>
  )
}

export default function Settings({ theme, toggleTheme }: { theme: "light" | "dark"; toggleTheme: () => void }) {
  const [providers, setProviders] = useState<AiProvider[] | null>(null)
  const [err, setErr] = useState("")
  const load = useCallback(() => { aiApi.providers().then(setProviders).catch((e) => setErr(e.message)) }, [])
  useEffect(load, [load])
  const prefs = useAiPrefs()
  const using = providers ? providers.find((p) => p.id === pickProvider(providers, prefs, prefs.provider ?? "") && isUsable(p, prefs)) : undefined
  return (
    <div className="page-wrap narrow">
      <div className="page-head"><div><h1>Settings</h1><p className="muted">The same providers power the AI builder in every board.</p></div></div>

      <h2 className="section-title">AI providers</h2>
      <p className="muted small">Keys you enter are saved on this machine in <span className="mono">hardware/.env</span>, which is git-ignored, so they survive restarts. “Forget key” removes one. A key set in your system environment is used as is and can only be removed there.</p>
      {providers && <p className="small" role="status">{using ? <>The AI builder will use <b>{using.label}</b> ({using.model}).</> : <span className="t-bad-text">No provider is ready, so the AI builder is off. Add a key and model to one below.</span>}</p>}
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
