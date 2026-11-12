import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, iterApi, type BuildResult, type Design } from "./api"
import { useToast } from "./toast"
import Editor from "./Editor"
import Preview from "./Preview"
import Problems from "./Problems"
import Bom from "./Bom"
import Snapshots, { type ActiveDiff } from "./Snapshots"
import DiffView from "./DiffView"
import { useHistory } from "./useHistory"

function useSplit(initial: number, min: number, max: number, axis: "x" | "y", invert = false) {
  const [size, setSize] = useState(initial)
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const start = axis === "x" ? e.clientX : e.clientY
    const base = size
    const move = (ev: PointerEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - start
      setSize(Math.min(max, Math.max(min, base + (invert ? -d : d))))
    }
    const up = () => {
      removeEventListener("pointermove", move)
      removeEventListener("pointerup", up)
      document.body.classList.remove("dragging")
    }
    document.body.classList.add("dragging")
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
  }
  return { size, onPointerDown }
}

export type BuildState = { status: "idle" | "building" | "ok" | "error"; durationMs?: number; fatal?: string }

export default function Workspace({ name, onSaved }: { name: string; onSaved: () => void }) {
  const toast = useToast()
  const [design, setDesign] = useState<Design | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<Record<string, string>>({})
  const hist = useHistory({})
  const files = hist.files
  const [autosave, setAutosave] = useState(() => { try { return localStorage.getItem("autosave") !== "off" } catch { return true } })
  const [saving, setSaving] = useState(false)
  const [diff, setDiff] = useState<ActiveDiff | null>(null)
  const [diffFocus, setDiffFocus] = useState<string | null>(null)
  const [snapVersion, setSnapVersion] = useState(0)
  const [active, setActive] = useState("index.tsx")
  const [build, setBuild] = useState<BuildState>({ status: "idle" })
  const [result, setResult] = useState<BuildResult | null>(null)
  const [circuit, setCircuit] = useState<any[] | null>(null) // last good
  const [panel, setPanel] = useState<"problems" | "bom" | "history">("problems")
  const [panelOpen, setPanelOpen] = useState(true)
  const [bomVersion, setBomVersion] = useState(0)
  const buildSeq = useRef(0)
  const filesRef = useRef(files)
  filesRef.current = files

  const left = useSplit(Math.round(Math.min(560, innerWidth * 0.38)), 260, 900, "x")
  const bottom = useSplit(280, 120, 640, "y", true)

  const dirty = useMemo(() => Object.keys(files).some((k) => files[k] !== saved[k]), [files, saved])

  const runBuild = useCallback(async () => {
    const id = ++buildSeq.current
    setBuild((b) => ({ ...b, status: "building", fatal: undefined }))
    try {
      const r = await api.build(name, filesRef.current)
      if (id !== buildSeq.current) return
      setResult(r)
      if (r.circuitJson?.length && r.errors.length === 0) setCircuit(r.circuitJson)
      else if (r.circuitJson?.length) setCircuit((c) => c ?? r.circuitJson)
      setBuild({ status: r.errors.length ? "error" : "ok", durationMs: r.durationMs })
    } catch (e: any) {
      if (id !== buildSeq.current) return
      setBuild({ status: "error", fatal: e.message })
    }
  }, [name])

  useEffect(() => {
    api.design(name)
      .then((d) => {
        setDesign(d)
        setSaved(d.files)
        hist.reset(d.files)
        setActive(d.files["index.tsx"] !== undefined ? "index.tsx" : Object.keys(d.files)[0])
        filesRef.current = d.files
        runBuild()
      })
      .catch((e) => setLoadErr(e.message))
  }, [name, runBuild, hist.reset])

  // debounced rebuild on edits
  const first = useRef(true)
  useEffect(() => {
    if (!design) return
    if (first.current) { first.current = false; return }
    const t = setTimeout(runBuild, 1000)
    return () => clearTimeout(t)
  }, [files, design, runBuild])

  const savedRef = useRef(saved)
  savedRef.current = saved
  const save = useCallback(async (quiet = false): Promise<boolean> => {
    try {
      const changed: Record<string, string> = {}
      for (const k of Object.keys(filesRef.current)) if (filesRef.current[k] !== savedRef.current[k]) changed[k] = filesRef.current[k]
      if (!Object.keys(changed).length) return true
      setSaving(true)
      await api.save(name, changed)
      savedRef.current = { ...savedRef.current, ...changed }
      setSaved(savedRef.current)
      setBomVersion((v) => v + 1)
      if (!quiet) toast("ok", "Saved")
      onSaved()
      return true
    } catch (e: any) {
      toast("err", `Save failed: ${e.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [name, toast, onSaved])

  // autosave: debounced after the last change
  useEffect(() => {
    if (!autosave || !dirty || !design) return
    const t = setTimeout(() => save(true), 1500)
    return () => clearTimeout(t)
  }, [autosave, dirty, files, design, save])
  const saveRef = useRef(save)
  saveRef.current = save
  const autosaveRef = useRef(autosave)
  autosaveRef.current = autosave
  // flush pending edits when leaving the design; warn when closing the tab with unsaved edits
  useEffect(() => () => { if (autosaveRef.current) saveRef.current(true) }, [])
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => { if (Object.keys(filesRef.current).some((k) => filesRef.current[k] !== savedRef.current[k])) e.preventDefault() }
    addEventListener("beforeunload", on)
    return () => removeEventListener("beforeunload", on)
  }, [])
  const toggleAutosave = () => setAutosave((a) => { try { localStorage.setItem("autosave", a ? "off" : "on") } catch {} return !a })

  const edit = useCallback((k: string, v: string) => hist.push((f) => ({ ...f, [k]: v }), { key: "editor:" + k }), [hist.push])
  const onRestore = useCallback((f: Record<string, string>) => {
    savedRef.current = f
    setSaved(f)
    hist.push(() => f)
    setBomVersion((v) => v + 1)
    setSnapVersion((v) => v + 1)
    onSaved()
  }, [hist.push, onSaved])
  const newVariant = async () => {
    try {
      if (!(await save(true))) return toast("err", "Variant not created: save failed")
      const v = await iterApi.variant(name)
      toast("ok", `Created ${v.name} (rev ${v.revision})`)
      onSaved()
      location.hash = `#/design/${encodeURIComponent(v.name)}`
    } catch (e: any) { toast("err", e.message) }
  }

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === "s") { e.preventDefault(); save() }
      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: the code editor keeps its own undo; this covers everywhere else
      else if ((k === "z" || k === "y") && !(e.target as HTMLElement)?.closest?.(".cm-editor, input, textarea, select")) {
        e.preventDefault()
        if (k === "y" || e.shiftKey) hist.redo(); else hist.undo()
      }
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [save, hist.undo, hist.redo])

  if (loadErr) return <div className="empty err">Could not load "{name}": {loadErr}</div>
  if (!design) return <div className="empty">Loading…</div>

  const errCount = result?.errors.length ?? 0
  const warnCount = result?.warnings.length ?? 0
  const hasErrors = build.status === "error"

  const doExport = () => {
    if (dirty) toast("info", "Export uses saved files; you have unsaved edits")
    if (hasErrors) toast("err", "Last build had errors; export may be incomplete")
    const a = document.createElement("a")
    a.href = api.exportUrl(name)
    a.download = `${name}.zip`
    a.click()
  }

  return (
    <div className="workspace">
      <div className="toolbar">
        <div className={`status ${build.status}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={build.status + (build.status === "error" ? errCount : "")}
              className="status-inner"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={{ duration: 0.14 }}
            >
              <span className={`dot ${build.status === "building" ? "pulse" : build.status === "ok" ? "good" : build.status === "error" ? "bad" : ""}`} />
              {build.status === "building" && "Building…"}
              {build.status === "ok" && `Built in ${((build.durationMs ?? 0) / 1000).toFixed(1)}s`}
              {build.status === "error" && (build.fatal ? `Build failed` : `${errCount} error${errCount === 1 ? "" : "s"}`)}
              {build.status === "idle" && "Idle"}
              {build.status === "error" && circuit && <span className="muted"> · showing last good</span>}
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="grow" />
        <button className="icon-btn" onClick={hist.undo} disabled={!hist.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
        </button>
        <button className="icon-btn" onClick={hist.redo} disabled={!hist.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
        </button>
        <label className="autosave" title="Save automatically a moment after you stop typing">
          <input type="checkbox" checked={autosave} onChange={toggleAutosave} /> Autosave
        </label>
        <span className="muted small" aria-live="polite">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
        <button className="btn" onClick={() => { setPanel("history"); setPanelOpen(true) }} title="Open snapshots">Snapshots</button>
        <button className="btn" onClick={newVariant} title="Copy this design to a new revision folder">New variant</button>
        <button className="btn" onClick={runBuild} disabled={build.status === "building"}>Build</button>
        <button className="btn" onClick={() => save()} disabled={!dirty}>Save</button>
        <button className="btn primary" onClick={doExport} title={hasErrors ? "Last build had errors" : "Download JLCPCB zip"}>
          {hasErrors && <span className="dot bad" />}Export
        </button>
      </div>

      <div className="panes">
        <section className="pane editor-pane" style={{ width: left.size }}>
          <Editor files={files} saved={saved} active={active} setActive={setActive} onChange={edit} />
        </section>
        <div className="gutter x" onPointerDown={left.onPointerDown} />
        <div className="right">
          <section className="pane preview-pane">
            {diff ? <DiffView diff={diff.result} label={diff.label} focus={diffFocus} onFocus={setDiffFocus} onClose={() => { setDiff(null); setDiffFocus(null) }} /> : <Preview circuitJson={circuit} building={build.status === "building"} />}
          </section>
          <div className="gutter y" onPointerDown={panelOpen ? bottom.onPointerDown : undefined} />
          <section className="pane bottom" style={{ height: panelOpen ? bottom.size : 38 }}>
            <div className="tabs small">
              {(["problems", "bom", "history"] as const).map((t) => (
                <button key={t} className={`tab ${panel === t ? "on" : ""}`} onClick={() => { setPanel(t); setPanelOpen(true) }}>
                  {panel === t && <motion.span layoutId="bottab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
                  <span className="tab-label">
                    {t === "problems" ? "Problems" : t === "bom" ? "BOM & cost" : "Snapshots & diff"}
                    {t === "problems" && (errCount > 0 || warnCount > 0) && (
                      <span className="counts">
                        {errCount > 0 && <span className="cnt bad">{errCount}</span>}
                        {warnCount > 0 && <span className="cnt warn">{warnCount}</span>}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              <div className="grow" />
              <button className="icon-btn" onClick={() => setPanelOpen((o) => !o)} aria-label="Toggle panel" title={panelOpen ? "Collapse" : "Expand"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: panelOpen ? "none" : "rotate(180deg)", transition: "transform .15s" }}>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
            {panelOpen && (
              <div className="panel-body">
                {panel === "problems" ? (
                  <Problems result={result} fatal={build.fatal} />
                ) : panel === "history" ? (
                  <Snapshots name={name} files={files} version={snapVersion} diff={diff} focus={diffFocus} onFocus={setDiffFocus} onDiff={setDiff} onRestore={onRestore} />
                ) : (
                  <Bom name={name} version={bomVersion} dirty={dirty} />
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
