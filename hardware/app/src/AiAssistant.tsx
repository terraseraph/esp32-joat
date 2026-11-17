import { useEffect, useRef, useState } from "react"
import { aiApi, api, type AgentRun, type AiProvider, type AiState } from "./api"
import { isUsable, loadPrefs, pickProvider, savePrefs, useAiPrefs } from "./aiPrefs"
import AiSelectionBar from "./AiSelectionBar"
import { AiIcon } from "./ui"
import AiThinking from "./AiThinking"
import { contextOf, NO_SELECTION, type AiSelection } from "./selection"

type Turn = { role: "user" | "assistant"; content: string; result?: AiState; failed?: boolean }
// The panel unmounts when you switch drawer tabs: keep each design's chat and unsent draft for the session.
const chats = new Map<string, Turn[]>()
const drafts = new Map<string, string>()
/** onFiles: the design's files changed on disk (the assistant edited the working draft, or a run was rolled back). */
export default function AiAssistant({ name, dirty, selected, selection = NO_SELECTION, onSelection = () => {}, onProposal, onFiles }: { name: string; dirty: boolean; selected: string | null; selection?: AiSelection; onSelection?: (n: { parts?: string[]; net?: null; region?: null }) => void; onProposal: () => void; onFiles: (files: Record<string, string>) => void }) {
  const [snapshot, setSnapshot] = useState<"pcb" | "schematic" | null>(null)
  const [info, setInfo] = useState(false)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [providers, setProviders] = useState<AiProvider[]>([])
  const prefs = useAiPrefs()
  const [provider, setProviderRaw] = useState(() => loadPrefs().provider ?? "openai")
  const setProvider = (p: string) => { setProviderRaw(p); savePrefs({ provider: p }) }
  const [model, setModel] = useState("")
  const [key, setKey] = useState("")
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const modelRequest = useRef(0)
  const [settings, setSettings] = useState(false)
  const [text, setText] = useState(() => drafts.get(name) ?? "")
  const [turns, setTurns] = useState<Turn[]>(() => chats.get(name) ?? [])
  useEffect(() => { chats.set(name, turns) }, [name, turns])
  useEffect(() => { drafts.set(name, text) }, [name, text])
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
  // default to a provider that has a key and a model and is switched on; follow Settings when that changes
  useEffect(() => {
    if (!providers.length) return
    const next = pickProvider(providers, prefs, provider)
    if (next !== provider) setProviderRaw(next)
    // remember a provider that works, so it is still the default after a restart clears its key
    if (providers.some((p) => p.id === next && isUsable(p, prefs)) && prefs.provider !== next) savePrefs({ provider: next })
  }, [providers, prefs])
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
      const r = await aiApi.ask(name, provider, message, selected ?? undefined, history, contextOf(selection, { snapshot }))
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
    <header className="ai-head">
      <span className="ai-title">{AiIcon.spark}<b>AI builder</b></span>
      <select className="ai-provider" aria-label="AI provider" value={provider} disabled={busy || saving} onChange={(e) => { setProvider(e.target.value); setError("") }}>
        {(providers.some((p) => isUsable(p, prefs)) ? providers.filter((p) => isUsable(p, prefs) || p.id === provider) : providers).map((p) => <option key={p.id} value={p.id}>{p.configured && p.model ? `${p.label} · ${p.model}` : p.label}</option>)}
      </select>
      <button className={`icon-btn ${info ? "on" : ""}`} aria-label="How the AI builder works" aria-expanded={info} title="How it works" onClick={() => setInfo((v) => !v)}>{AiIcon.info}</button>
      {!!turns.length && <button className="icon-btn" aria-label="Clear chat" title="Clear chat" onClick={() => setTurns([])} disabled={busy}>{AiIcon.trash}</button>}
      <button className={`icon-btn ${settings || !ready ? "on" : ""}`} aria-label="Provider key and model" aria-expanded={settings || !ready} title="Provider key and model" onClick={() => setSettings((v) => !v)} disabled={busy || saving}>{AiIcon.gear}</button>
    </header>
    {info && <p className="ai-info muted small">It works through the same tools as an agent in chat and sends your request, recent chat and what it reads (parts, nets, checks, source) to the chosen provider. Up to 20 AI calls and 8 builds per request; provider charges apply. Edits go to a working draft you keep or roll back. Manage providers in <a href="#/settings">Settings</a>.</p>}
    {(settings || !ready) && <div className="card ai-settings">
      <label>API key<input className="input" aria-label="AI API key" type="password" autoComplete="off" value={key} placeholder={current?.configured ? "Key configured; leave blank to keep it" : "Paste your provider API key"} onChange={(e) => { setKey(e.target.value); setModels([]); setModel(""); modelRequest.current++; setLoadingModels(false) }} disabled={saving} /></label>
      <label>Model<select className="input" aria-label="AI model" value={model} onChange={(e) => setModel(e.target.value)} disabled={saving || loadingModels || !models.length}>
        {!model && <option value="">{loadingModels ? "Loading models…" : "Load models using your API key"}</option>}
        {model && !models.some((m) => m.id === model) && <option value={model}>{model} (current)</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} · ${m.id}`}</option>)}
      </select></label>
      <div className="row"><button className="btn small" disabled={saving || loadingModels || (!key.trim() && !current?.configured)} onClick={fetchModels}>{loadingModels ? "Loading models…" : models.length ? "Refresh models" : "Load models"}</button><button className="btn primary small" disabled={saving || loadingModels || !model.trim() || (!key.trim() && !current?.configured)} onClick={connect}>{saving ? "Saving…" : "Use this provider"}</button>
        {current?.configured && <button className="btn ghost small" disabled={saving} onClick={async () => { try { await aiApi.disconnect(provider); await load() } catch (e: any) { setError(e.message) } }}>Forget saved key</button>}
      </div>
      <p className="muted small">Keys are saved on this machine in hardware/.env (git-ignored){current?.source === "env" ? "; this one comes from your environment" : ""}. <a href="#/settings">More in Settings</a>.</p>
    </div>}
    {run && <div className="card ai-run" role="status">
      <strong>Working draft: {run.edits.length} edit{run.edits.length === 1 ? "" : "s"} since {new Date(run.startedAt).toLocaleTimeString()}</strong>
      <p className="muted small">These edits are already in the design files so builds and checks see them. Keep them, or roll back to the snapshot taken before the first one.</p>
      {!!run.edits.length && <details><summary>Edits in this run</summary>{run.edits.map((e, i) => <div className="small" key={i}><code>{e.tool}</code> {e.summary}</div>)}</details>}
      <div className="row"><button className="btn primary small" disabled={deciding || busy} onClick={() => decide(true)}>Keep edits</button><button className="btn small" disabled={deciding || busy} onClick={() => decide(false)}>Roll back</button></div>
    </div>}
    <div className="ai-thread">
      {!turns.length && ready && <div className="ai-empty"><b>What should we change?</b><span className="muted small">Select parts on the board to attach them, then ask.</span></div>}
    {turns.map((t, i) => <article key={i} className={`card ai-turn ${t.role}`}>
      <strong>{t.role === "user" ? "You" : "Assistant"}</strong>
      <div className="ai-message">{t.content}</div>
      <AiThinking result={t.result} />
      {!!t.result?.trail.length && <details open={t.failed}><summary>{t.result.trail.length} tool step{t.result.trail.length === 1 ? "" : "s"}{t.result.trail.some((s) => !s.ok) ? ` (${t.result.trail.filter((s) => !s.ok).length} failed)` : ""}</summary>
        {t.result.trail.map((s, j) => <div className="small" key={j}><code>{s.tool}</code> {s.ok ? "" : "failed: "}{s.summary} <span className="muted">{s.args !== "{}" ? s.args : ""} · {s.ms} ms</span></div>)}
      </details>}
      {t.result?.searches.map((s, j) => <details key={j}><summary>Part search: {s.query} ({s.parts?.length ?? 0} matches)</summary>
        {s.error && <p>{s.error}</p>}
        {s.parts?.map((p) => <div className="ai-part" key={p.lcsc}><strong>{p.lcsc} · {p.mfr}</strong><span>{p.description}</span><span className="muted small">{p.package} · {p.tier} · Stock: {p.stock ?? "unknown"} · {p.price == null ? "price unknown" : `$${p.price} USD (catalogue)`}</span></div>)}
      </details>)}
      {t.result?.proposalId && <p className="small">Proposal created below. Review the diff before accepting; build and check the result before fabrication.</p>}
    </article>)}
    </div>
    <div className="ai-composer">
      {error && <p role="alert" className="ai-error">{error}</p>}
    <div className="ai-prompts">
      <button className="chip-btn" disabled={busy} onClick={() => setText(selected ? `Analyse ${selected}: explain its role, connections and compatibility checks.` : "Analyse this board. Explain what is missing and the next practical design steps.")}>Analyse {selected ?? "board"}</button>
      <button className="chip-btn" disabled={busy} onClick={() => setText("Find suitable parts for this design. Ask what function and electrical requirements I need first.")}>Find parts</button>
      <button className="chip-btn" disabled={busy} onClick={() => setText(selected ? `Suggest a better placement for ${selected} and propose the change, respecting connections and keepouts.` : "Review placement and propose one useful improvement, explaining the reason.")}>Suggest placement</button>
    </div>
      <div className="ai-box">
        <AiSelectionBar selection={selection} onSelection={onSelection} snapshot={snapshot} setSnapshot={setSnapshot} disabled={busy} />
    <textarea aria-label="Ask the design assistant" value={text} disabled={busy} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="Describe a change, or ask about the board…" onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send() } }} />
        <div className="ai-box-foot">
          <span className="muted small">{dirty ? "Save first so the assistant sees your latest changes." : "Ctrl+Enter to send"}</span>
          <div className="grow" />
          <button className="btn primary send-btn" disabled={busy || !ready || dirty || !text.trim()} onClick={send}>{busy ? "Working…" : <>Send {AiIcon.send}</>}</button>
        </div>
      </div>
    </div>
  </section>
}
