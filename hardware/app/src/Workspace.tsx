import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type BuildResult, type Design } from "./api"
import { useToast } from "./toast"
import Editor from "./Editor"
import Preview from "./Preview"
import Problems from "./Problems"
import Bom from "./Bom"
import Shortcuts from "./Shortcuts"

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
  const [files, setFiles] = useState<Record<string, string>>({})
  const [active, setActive] = useState("index.tsx")
  const [build, setBuild] = useState<BuildState>({ status: "idle" })
  const [result, setResult] = useState<BuildResult | null>(null)
  const [circuit, setCircuit] = useState<any[] | null>(null) // last good
  const [panel, setPanel] = useState<"problems" | "bom">("problems")
  const [panelOpen, setPanelOpen] = useState(true)
  const [bomVersion, setBomVersion] = useState(0)
  const [help, setHelp] = useState(false)
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
        setFiles(d.files)
        setActive(d.files["index.tsx"] !== undefined ? "index.tsx" : Object.keys(d.files)[0])
        filesRef.current = d.files
        runBuild()
      })
      .catch((e) => setLoadErr(e.message))
  }, [name, runBuild])

  // debounced rebuild on edits
  const first = useRef(true)
  useEffect(() => {
    if (!design) return
    if (first.current) { first.current = false; return }
    const t = setTimeout(runBuild, 1000)
    return () => clearTimeout(t)
  }, [files, design, runBuild])

  const save = useCallback(async () => {
    try {
      const changed: Record<string, string> = {}
      for (const k of Object.keys(filesRef.current)) if (filesRef.current[k] !== saved[k]) changed[k] = filesRef.current[k]
      if (!Object.keys(changed).length) return
      await api.save(name, changed)
      setSaved((s) => ({ ...s, ...changed }))
      setBomVersion((v) => v + 1)
      toast("ok", "Saved")
      onSaved()
    } catch (e: any) {
      toast("err", `Save failed: ${e.message}`)
    }
  }, [name, saved, toast, onSaved])

  const runBuildRef = useRef(runBuild)
  runBuildRef.current = runBuild
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === "s") { e.preventDefault(); save(); return }
      if (mod && e.key === "Enter") { e.preventDefault(); runBuildRef.current(); return }
      const t = e.target as HTMLElement
      const typing = t.closest("input, textarea, select, .cm-editor, [contenteditable=true]")
      if (e.key === "Escape" && typing && t.closest(".cm-editor")) { (t as HTMLElement).blur(); return }
      if (typing || mod || e.altKey) return
      if (e.key === "?") { e.preventDefault(); setHelp((o) => !o) }
      else if (k === "1" || k === "2" || k === "3") dispatchEvent(new CustomEvent("hw-preview-tab", { detail: ["schematic", "pcb", "3d"][+k - 1] }))
      else if (k === "j") setPanelOpen((o) => !o)
      else if (k === "e") { e.preventDefault(); document.querySelector<HTMLElement>(".cm-content")?.focus() }
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [save])

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
      <Shortcuts open={help} onOpenChange={setHelp} />
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
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className="icon-btn" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
        <button className="btn" onClick={runBuild} disabled={build.status === "building"} title="Build (Ctrl+Enter)">Build</button>
        <button className="btn" onClick={save} disabled={!dirty} title="Save (Ctrl+S)">Save</button>
        <button className="btn primary" onClick={doExport} title={hasErrors ? "Last build had errors" : "Download JLCPCB zip"}>
          {hasErrors && <span className="dot bad" />}Export
        </button>
      </div>

      <div className="panes">
        <section className="pane editor-pane" style={{ width: left.size }}>
          <Editor files={files} saved={saved} active={active} setActive={setActive} onChange={(k, v) => setFiles((f) => ({ ...f, [k]: v }))} />
        </section>
        <div className="gutter x" onPointerDown={left.onPointerDown} />
        <div className="right">
          <section className="pane preview-pane">
            <Preview circuitJson={circuit} building={build.status === "building"} />
          </section>
          <div className="gutter y" onPointerDown={panelOpen ? bottom.onPointerDown : undefined} />
          <section className="pane bottom" style={{ height: panelOpen ? bottom.size : 38 }}>
            <div className="tabs small">
              {(["problems", "bom"] as const).map((t) => (
                <button key={t} className={`tab ${panel === t ? "on" : ""}`} onClick={() => { setPanel(t); setPanelOpen(true) }}>
                  {panel === t && <motion.span layoutId="bottab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
                  <span className="tab-label">
                    {t === "problems" ? "Problems" : "BOM & cost"}
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
