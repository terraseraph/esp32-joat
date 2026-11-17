import { useEffect, useRef, useState } from "react"
import { aiApi, api, type AiProvider, type AiState } from "./api"
import { isPremiumModel, isUsable, loadPrefs, modelLabel, pickProvider, savePrefs, useAiPrefs } from "./aiPrefs"
import { clearChat, registerAbsorb, sendMessage, setDraft, stopRequest, useChat } from "./aiChat"
import AiProgress from "./AiProgress"
import Markdown from "./Markdown"
import PlanStrip from "./PlanStrip"
import AiSelectionBar from "./AiSelectionBar"
import { AiIcon } from "./ui"
import AiThinking from "./AiThinking"
import { contextOf, NO_SELECTION, type AiSelection } from "./selection"

/** onFiles: the design's files changed on disk (the assistant edited the working draft, or a run was rolled back). */
export default function AiAssistant({ name, dirty, selected, selection = NO_SELECTION, onSelection = () => {}, onProposal, onFiles }: { name: string; dirty: boolean; selected: string | null; selection?: AiSelection; onSelection?: (n: { parts?: string[]; net?: null; region?: null }) => void; onProposal: () => void; onFiles: (files: Record<string, string>) => void }) {
  const [snapshot, setSnapshot] = useState<"pcb" | "schematic" | null>(null)
  const [info, setInfo] = useState(false)
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
  // the chat and any running request live in a store that outlives this panel (see aiChat.ts)
  const chat = useChat(name)
  const { turns, busy } = chat
  const text = chat.draft
  const setText = (v: string) => setDraft(name, v)
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }) }, [turns.length, busy, chat.live?.tools.length])
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
  /** Take what the assistant did (whether or not the request finished) into the workspace. */
  const absorb = async (s: AiState) => {
    if (s.proposalId) onProposal()
    if (s.edited) onFiles((await api.design(name)).files)
  }
  const absorbRef = useRef(absorb)
  absorbRef.current = absorb
  useEffect(() => registerAbsorb(name, (r) => absorbRef.current(r)), [name])
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
  // the model list for the quick switcher; failures are ignored because the current model is always listed
  useEffect(() => {
    if (!ready) return
    let live = true
    aiApi.models(provider).then((r) => { if (live) setModels(r.models) }).catch(() => {})
    return () => { live = false }
  }, [provider, ready, current?.model])
  const applyModel = async (id: string) => {
    setSwitching(true); setError(""); setPendingModel(null)
    try { await aiApi.configure(provider, id); await load() }
    catch (e: any) { setError(e.message) }
    finally { setSwitching(false) }
  }
  const changeModel = (id: string) => {
    if (!current || id === current.model) return
    if (isPremiumModel(id) && !isPremiumModel(current.model)) setPendingModel(id)
    else void applyModel(id)
  }
  const fetchModels = async () => {
    const id = ++modelRequest.current
    setLoadingModels(true); setError("")
    try {
      const r = await aiApi.models(provider, key.trim() || undefined)
      if (!mounted.current || id !== modelRequest.current) return
      setModels(r.models)
      setModel((m) => r.models.some((x) => x.id === m) ? m : "")
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
  /** Send a ready-made request (the plan strip's "Do next") without going through the text box. */
  const askNow = (message: string) => {
    if (!ready || busy || dirty) return
    setError("")
    void sendMessage(name, { provider, message, selected: selected ?? undefined, context: contextOf(selection, { snapshot }) })
  }
  const send = () => {
    if (!text.trim() || !ready || busy || dirty) return
    setError("")
    void sendMessage(name, { provider, message: text.trim(), selected: selected ?? undefined, context: contextOf(selection, { snapshot }) })
  }
  return <section className="ai-assistant" aria-label="AI assistant">
    <header className="ai-head">
      <span className="ai-title">{AiIcon.spark}<b>AI builder</b></span>
      <select className="ai-provider" aria-label="AI provider" value={provider} disabled={busy || saving} onChange={(e) => { setProvider(e.target.value); setError("") }}>
        {(providers.some((p) => isUsable(p, prefs)) ? providers.filter((p) => isUsable(p, prefs) || p.id === provider) : providers).map((p) => <option key={p.id} value={p.id}>{p.configured && p.model ? `${p.label} · ${p.model}` : p.label}</option>)}
      </select>
      <button className={`icon-btn ${info ? "on" : ""}`} aria-label="How the AI builder works" aria-expanded={info} title="How it works" onClick={() => setInfo((v) => !v)}>{AiIcon.info}</button>
      {!!turns.length && <button className="icon-btn" aria-label="Clear chat" title="Clear chat" onClick={() => clearChat(name)} disabled={busy}>{AiIcon.trash}</button>}
      <button className={`icon-btn ${settings || !ready ? "on" : ""}`} aria-label="Provider key and model" aria-expanded={settings || !ready} title="Provider key and model" onClick={() => setSettings((v) => !v)} disabled={busy || saving}>{AiIcon.gear}</button>
    </header>
    {ready && current && (
      <div className="ai-model-row">
        <label className="muted small" htmlFor="ai-model-switch">Model</label>
        <select id="ai-model-switch" className="ai-model" aria-label="AI model in use" value={current.model} disabled={busy || switching} onChange={(e) => changeModel(e.target.value)}>
          {!models.some((m) => m.id === current.model) && <option value={current.model}>{modelLabel(current.model, current.model)}</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m.id, m.label)}</option>)}
        </select>
        {isPremiumModel(current.model) && <span className="chip premium-chip" title="Premium models cost noticeably more per request">premium</span>}
      </div>
    )}
    {pendingModel && (
      <div className="ai-confirm" role="alertdialog">
        <span><b>{pendingModel}</b> is a premium model and costs noticeably more per request. One request can make up to 20 model calls.</span>
        <span className="grow" />
        <button className="btn small-btn danger" onClick={() => applyModel(pendingModel)}>Use it</button>
        <button className="btn small-btn" onClick={() => setPendingModel(null)}>Cancel</button>
      </div>
    )}
    <PlanStrip name={name} disabled={!ready || busy || dirty} onDo={askNow} />
    {info && <p className="ai-info muted small">It works through the same tools as an agent in chat and sends your request, recent chat and what it reads (parts, nets, checks, source) to the chosen provider. Up to 20 AI calls and 8 builds per request; provider charges apply. Edits go to a working draft you keep or roll back. Manage providers in <a href="#/settings">Settings</a>.</p>}
    {(settings || !ready) && <div className="card ai-settings">
      <label>API key<input className="input" aria-label="AI API key" type="password" autoComplete="off" value={key} placeholder={current?.configured ? "Key configured; leave blank to keep it" : "Paste your provider API key"} onChange={(e) => { setKey(e.target.value); setModels([]); setModel(""); modelRequest.current++; setLoadingModels(false) }} disabled={saving} /></label>
      <label>Model<select className="input" aria-label="AI model" value={model} onChange={(e) => setModel(e.target.value)} disabled={saving || loadingModels || !models.length}>
        {!model && <option value="">{loadingModels ? "Loading models…" : "Load models using your API key"}</option>}
        {model && !models.some((m) => m.id === model) && <option value={model}>{model} (current)</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m.id, m.label === m.id ? m.id : `${m.label} · ${m.id}`)}</option>)}
      </select></label>
      <div className="row"><button className="btn small" disabled={saving || loadingModels || (!key.trim() && !current?.configured)} onClick={fetchModels}>{loadingModels ? "Loading models…" : models.length ? "Refresh models" : "Load models"}</button><button className="btn primary small" disabled={saving || loadingModels || !model.trim() || (!key.trim() && !current?.configured)} onClick={connect}>{saving ? "Saving…" : "Use this provider"}</button>
        {current?.configured && <button className="btn ghost small" disabled={saving} onClick={async () => { try { await aiApi.disconnect(provider); await load() } catch (e: any) { setError(e.message) } }}>Forget saved key</button>}
      </div>
      <p className="muted small">Keys are saved on this machine in hardware/.env (git-ignored){current?.source === "env" ? "; this one comes from your environment" : ""}. <a href="#/settings">More in Settings</a>.</p>
    </div>}
    <div className="ai-thread">
      {!turns.length && ready && <div className="ai-empty"><b>What should we change?</b><span className="muted small">Select parts on the board to attach them, then ask.</span></div>}
    {turns.map((t, i) => <article key={i} className={`card ai-turn ${t.role}`}>
      <strong>{t.role === "user" ? "You" : "Assistant"}</strong>
      {t.role === "assistant" ? <Markdown text={t.content} /> : <div className="ai-message">{t.content}</div>}
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
    {busy && chat.live && <AiProgress live={chat.live} model={current?.model} onStop={() => stopRequest(name)} />}
    <div ref={endRef} />
    </div>
    <div className="ai-composer">
      {(error || chat.error) && <p role="alert" className="ai-error">{error || chat.error}</p>}
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
          {busy
            ? <button className="btn danger send-btn" onClick={() => stopRequest(name)} title="Stop the request now; anything already changed stays on the working draft">Stop</button>
            : <button className="btn primary send-btn" disabled={!ready || dirty || !text.trim()} onClick={send}>Send {AiIcon.send}</button>}
        </div>
      </div>
    </div>
  </section>
}
