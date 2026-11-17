import { useEffect, useRef, useState } from "react"
import { aiApi, api, type AgentRun, type AiProvider, type AiState } from "./api"

type Turn = { role: "user" | "assistant"; content: string; result?: AiState; failed?: boolean }
/** onFiles: the design's files changed on disk (the assistant edited the working draft, or a run was rolled back). */
export default function AiAssistant({ name, dirty, selected, onProposal, onFiles }: { name: string; dirty: boolean; selected: string | null; onProposal: () => void; onFiles: (files: Record<string, string>) => void }) {
  const [run, setRun] = useState<AgentRun | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [provider, setProvider] = useState("openai")
  const [model, setModel] = useState("")
  const [key, setKey] = useState("")
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const modelRequest = useRef(0)
  const [settings, setSettings] = useState(false)
  const [text, setText] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async () => {
    const list = await aiApi.providers()
    if (mounted.current) setProviders(list)
    return list
  }
  useEffect(() => { load().catch((e) => setError(e.message)) }, [])
  // An agent in chat (MCP) edits the same working draft, so the open run is polled rather than assumed.
  useEffect(() => {
    const poll = () => aiApi.run(name).then((r) => { if (mounted.current) setRun(r) }).catch(() => {})
    poll()
    const t = setInterval(poll, 4000)
    return () => clearInterval(t)
  }, [name])
  /** Take what the assistant did (whether or not the request finished) into the workspace. */
  const absorb = async (s: AiState) => {
    setRun(s.run)
    if (s.proposalId) onProposal()
    if (s.edited) onFiles((await api.design(name)).files)
  }
  const decide = async (keep: boolean) => {
    if (dirty && !keep) return setError("Save or discard your editor changes first, then roll back.")
    setDeciding(true); setError("")
    try {
      if (keep) await aiApi.acceptRun(name)
      else onFiles((await aiApi.rollbackRun(name)).files)
      if (mounted.current) setRun(null)
    } catch (e: any) { if (mounted.current) setError(e.message) }
    finally { if (mounted.current) setDeciding(false) }
  }
  useEffect(() => {
    setModel(providers.find((p) => p.id === provider)?.model ?? "")
    setKey("")
    setModels([])
    modelRequest.current++
    setLoadingModels(false)
  }, [provider, providers])
  const current = providers.find((p) => p.id === provider)
  const ready = !!current?.configured && !!current.model
  const fetchModels = async () => {
    const id = ++modelRequest.current
    setLoadingModels(true); setError("")
    try {
      const r = await aiApi.models(provider, key.trim() || undefined)
      if (!mounted.current || id !== modelRequest.current) return
      setModels(r.models)
      setModel((m) => r.models.some((x) => x.id === m) ? m : r.models[0]?.id ?? "")
      if (!r.models.length) setError("This key returned no available text models.")
    } catch (e: any) { if (mounted.current && id === modelRequest.current) setError(e.message) }
    finally { if (mounted.current && id === modelRequest.current) setLoadingModels(false) }
  }
  const connect = async () => {
    setSaving(true); setError("")
    try { await aiApi.configure(provider, model.trim(), key || undefined); setKey(""); await load(); setSettings(false) }
    catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }
  const send = async () => {
    if (!text.trim() || !ready || busy || dirty) return
    const message = text.trim(), history = turns.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 16000) }))
    setBusy(true); setError(""); setText("")
    try {
      const r = await aiApi.ask(name, provider, message, selected ?? undefined, history)
      if (!mounted.current) return
      setTurns((t) => [...t, { role: "user", content: message }, { role: "assistant", content: r.message, result: r }])
      await absorb(r)
    } catch (e: any) {
      if (!mounted.current) return
      setError(e.message)
      const state: AiState | undefined = e.state
      // a request that failed part-way may already have edited the draft: keep its steps on screen
      if (state?.trail.length) { setTurns((t) => [...t, { role: "user", content: message }, { role: "assistant", content: `Stopped: ${e.message}`, result: state, failed: true }]); await absorb(state).catch(() => {}) }
      else setText(message)
    }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="ai-assistant" aria-label="AI assistant">
    <div className="row ai-toolbar">
      <strong>Design assistant</strong>
      <label>Provider <select aria-label="AI provider" value={provider} disabled={busy || saving} onChange={(e) => { setProvider(e.target.value); setError("") }}>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select></label>
      <span className="muted small">{ready ? current?.model : "Set up a key and model to start"}</span>
      <button className="btn small" onClick={() => setSettings((s) => !s)} disabled={busy || saving}>AI settings</button>
      {!!turns.length && <button className="btn ghost small" onClick={() => setTurns([])} disabled={busy}>Clear chat</button>}
    </div>
    {(settings || !ready) && <div className="card ai-settings">
      <label>API key<input className="input" aria-label="AI API key" type="password" autoComplete="off" value={key} placeholder={current?.configured ? "Key configured; leave blank to keep it" : "Paste your provider API key"} onChange={(e) => { setKey(e.target.value); setModels([]); setModel(""); modelRequest.current++; setLoadingModels(false) }} disabled={saving} /></label>
      <label>Model<select className="input" aria-label="AI model" value={model} onChange={(e) => setModel(e.target.value)} disabled={saving || loadingModels || !models.length}>
        {!model && <option value="">{loadingModels ? "Loading models…" : "Load models using your API key"}</option>}
        {model && !models.some((m) => m.id === model) && <option value={model}>{model} (current)</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} · ${m.id}`}</option>)}
      </select></label>
      <div className="row"><button className="btn small" disabled={saving || loadingModels || (!key.trim() && !current?.configured)} onClick={fetchModels}>{loadingModels ? "Loading models…" : models.length ? "Refresh models" : "Load models"}</button><button className="btn primary small" disabled={saving || loadingModels || !model.trim() || (!key.trim() && !current?.configured)} onClick={connect}>{saving ? "Saving…" : "Use this provider"}</button>
        {current?.configured && <button className="btn ghost small" disabled={saving} onClick={async () => { try { await aiApi.disconnect(provider); await load() } catch (e: any) { setError(e.message) } }}>Forget entered key</button>}
      </div>
      <p className="muted small">Entered keys stay in this local server’s memory until restart. They are never saved in design files or browser storage. Keys and models set in the environment or in hardware/.env{current?.source === "env" ? " (in use now)" : ""} remain available after forgetting an entered key. Saving settings does not test the key.</p>
    </div>}
    <p className="muted small">The assistant reads and edits this design through the same tools as an agent in chat. It sends your request, recent chat and whatever it reads with those tools (parts, nets, checks, source) to the chosen provider. One request may use up to 20 AI calls and 8 builds or checks; provider charges apply. Part searches use JLC search.</p>
    {run && <div className="card ai-run" role="status">
      <strong>Working draft: {run.edits.length} edit{run.edits.length === 1 ? "" : "s"} since {new Date(run.startedAt).toLocaleTimeString()}</strong>
      <p className="muted small">These edits are already in the design files so builds and checks see them. Keep them, or roll back to the snapshot taken before the first one.</p>
      {!!run.edits.length && <details><summary>Edits in this run</summary>{run.edits.map((e, i) => <div className="small" key={i}><code>{e.tool}</code> {e.summary}</div>)}</details>}
      <div className="row"><button className="btn primary small" disabled={deciding || busy} onClick={() => decide(true)}>Keep edits</button><button className="btn small" disabled={deciding || busy} onClick={() => decide(false)}>Roll back</button></div>
    </div>}
    <div className="row ai-prompts">
      <button className="btn small" disabled={busy} onClick={() => setText(selected ? `Analyse ${selected}: explain its role, connections and compatibility checks.` : "Analyse this board. Explain what is missing and the next practical design steps.")}>Analyse {selected ?? "board"}</button>
      <button className="btn small" disabled={busy} onClick={() => setText("Find suitable parts for this design. Ask what function and electrical requirements I need first.")}>Find parts</button>
      <button className="btn small" disabled={busy} onClick={() => setText(selected ? `Suggest a better placement for ${selected} and propose the change, respecting connections and keepouts.` : "Review placement and propose one useful improvement, explaining the reason.")}>Suggest placement</button>
    </div>
    {turns.map((t, i) => <article key={i} className={`card ai-turn ${t.role}`}>
      <strong>{t.role === "user" ? "You" : "Assistant"}</strong>
      <div className="ai-message">{t.content}</div>
      {!!t.result?.trail.length && <details open={t.failed}><summary>{t.result.trail.length} tool step{t.result.trail.length === 1 ? "" : "s"}{t.result.trail.some((s) => !s.ok) ? ` (${t.result.trail.filter((s) => !s.ok).length} failed)` : ""}</summary>
        {t.result.trail.map((s, j) => <div className="small" key={j}><code>{s.tool}</code> {s.ok ? "" : "failed: "}{s.summary} <span className="muted">{s.args !== "{}" ? s.args : ""} · {s.ms} ms</span></div>)}
      </details>}
      {t.result?.searches.map((s, j) => <details key={j}><summary>Part search: {s.query} ({s.parts?.length ?? 0} matches)</summary>
        {s.error && <p>{s.error}</p>}
        {s.parts?.map((p) => <div className="ai-part" key={p.lcsc}><strong>{p.lcsc} · {p.mfr}</strong><span>{p.description}</span><span className="muted small">{p.package} · {p.tier} · Stock: {p.stock ?? "unknown"} · {p.price == null ? "price unknown" : `$${p.price} USD (catalogue)`}</span></div>)}
      </details>)}
      {t.result?.proposalId && <p className="small">Proposal created below. Review the diff before accepting; build and check the result before fabrication.</p>}
    </article>)}
    <textarea aria-label="Ask the design assistant" value={text} disabled={busy} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="Find a part, explain a circuit, or describe a placement or wiring change…" onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send() } }} />
    <div className="row end"><span className="muted small">{dirty ? "Save your changes before asking, so the assistant sees the latest design." : selected ? `Selected part: ${selected}` : "Edits go to a working draft you keep or roll back."}</span><div className="grow" /><button className="btn primary" disabled={busy || !ready || dirty || !text.trim()} onClick={send}>{busy ? "Working… (up to 5 min)" : "Send"}</button></div>
    {error && <p role="alert" className="ai-error">{error}</p>}
  </section>
}
