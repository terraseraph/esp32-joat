import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type BuildResult, type Design, type PropValue, type SrcComponent } from "./api"
import { buildModel } from "./pcbModel"
import Properties from "./Properties"
import type { PcbPick } from "./PcbEdit"
import { useToast } from "./toast"
import Editor from "./Editor"
import Preview from "./Preview"
import Problems from "./Problems"
import Bom from "./Bom"

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
  const buildSeq = useRef(0)
  const filesRef = useRef(files)
  filesRef.current = files

  const left = useSplit(Math.round(Math.min(560, innerWidth * 0.38)), 260, 900, "x")
  const bottom = useSplit(280, 120, 640, "y", true)

  const dirty = useMemo(() => Object.keys(files).some((k) => files[k] !== saved[k]), [files, saved])

  // --- click-on-board editing: selection, source components, code toggle ---
  const [codeOpen, setCodeOpen] = useState(() => { try { return localStorage.getItem("hw.codeOpen") === "1" } catch { return false } })
  const toggleCode = (open: boolean) => { setCodeOpen(open); try { localStorage.setItem("hw.codeOpen", open ? "1" : "0") } catch {} }
  const [snap, setSnapState] = useState(() => { try { return Number(localStorage.getItem("hw.snap") ?? 0.5) } catch { return 0.5 } })
  const setSnap = (s: number) => { setSnapState(s); try { localStorage.setItem("hw.snap", String(s)) } catch {} }
  const [selected, setSelected] = useState<string | null>(null)
  const [netKey, setNetKey] = useState<string | null>(null)
  const [srcComps, setSrcComps] = useState<SrcComponent[]>([])
  const model = useMemo(() => (circuit ? buildModel(circuit) : null), [circuit])
  const editChain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (!design) return
    const t = setTimeout(() => api.components(name, filesRef.current).then(setSrcComps).catch(() => {}), 300)
    return () => clearTimeout(t)
  }, [files, design, name])

  const srcOf = (n: string) => srcComps.find((c) => c.name === n)
  const isEditable = useCallback((n: string) => {
    const s = srcComps.find((c) => c.name === n)
    return !!s && !s.inLoop
  }, [srcComps])

  /** Rewrite the source for one component (serialised so quick edits never overwrite each other). */
  const applyProps = useCallback((comp: string, props: Record<string, PropValue>) => {
    editChain.current = editChain.current.then(async () => {
      try {
        const r = await api.patchComponent(name, comp, props, filesRef.current)
        filesRef.current = { ...filesRef.current, [r.file]: r.content }
        setFiles(filesRef.current)
        if (typeof props.name === "string") setSelected(props.name)
      } catch (e: any) {
        toast("err", e.message)
      }
    })
  }, [name, toast])

  const guard = (n: string) => {
    if (isEditable(n)) return true
    const s = srcOf(n)
    toast("info", s?.inLoop ? `${n} is made by a loop in the code; edit it there` : `${n} comes from a shared lib/ block, so it can't be moved from here`)
    return false
  }
  const onMove = useCallback((n: string, dx: number, dy: number) => {
    if (!guard(n)) return
    const s = srcOf(n)!
    const c = model?.compByName.get(n)
    const px = typeof s.props.pcbX === "number" ? s.props.pcbX : c?.x ?? 0
    const py = typeof s.props.pcbY === "number" ? s.props.pcbY : c?.y ?? 0
    if (s.dynamic.includes("pcbX") || s.dynamic.includes("pcbY")) { toast("info", `${n} has a computed position; edit it in the code`); return }
    applyProps(n, { pcbX: px + dx, pcbY: py + dy })
  }, [srcComps, model, applyProps]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRotate = useCallback((n: string, d: number) => {
    if (!guard(n)) return
    const s = srcOf(n)!
    const r = s.props.pcbRotation
    const cur = typeof r === "number" ? r : typeof r === "string" ? parseFloat(r) || 0 : 0
    applyProps(n, { pcbRotation: (((cur + d) % 360) + 360) % 360 })
  }, [srcComps, applyProps]) // eslint-disable-line react-hooks/exhaustive-deps
  const onPick = useCallback((p: PcbPick) => {
    if (p.clear) { setSelected(null); setNetKey(null); return }
    if (p.comp !== undefined) setSelected(p.comp)
    if (p.key !== undefined) setNetKey(p.key)
    else if (p.comp) setNetKey(null)
  }, [])
  useEffect(() => { setSelected(null); setNetKey(null) }, [name])

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

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save() }
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
        <button className={`btn ${codeOpen ? "on" : ""}`} onClick={() => toggleCode(!codeOpen)} aria-pressed={codeOpen} title="Show or hide the source code">{"</>"} Code</button>
        <button className="btn" onClick={runBuild} disabled={build.status === "building"}>Build</button>
        <button className="btn" onClick={save} disabled={!dirty}>Save</button>
        <button className="btn primary" onClick={doExport} title={hasErrors ? "Last build had errors" : "Download JLCPCB zip"}>
          {hasErrors && <span className="dot bad" />}Export
        </button>
      </div>

      <div className="panes">
        {codeOpen && (
          <>
            <section className="pane editor-pane" style={{ width: left.size }}>
              <Editor files={files} saved={saved} active={active} setActive={setActive} onChange={(k, v) => setFiles((f) => ({ ...f, [k]: v }))} />
            </section>
            <div className="gutter x" onPointerDown={left.onPointerDown} />
          </>
        )}
        <div className="right">
          <section className="pane preview-pane">
            <Preview circuitJson={circuit} building={build.status === "building"}
              canvas={model ? { model, fitKey: name, selected, netKey, editable: isEditable, snap, setSnap, onPick, onMove, onRotate } : undefined}
              overlay={model && selected && model.compByName.get(selected) ? (
                <Properties comp={model.compByName.get(selected)!} src={srcOf(selected)} model={model} netKey={netKey}
                  onChange={(p) => applyProps(selected, p)} onClose={() => { setSelected(null); setNetKey(null) }}
                  onClearNet={() => setNetKey(null)} onOpenCode={() => toggleCode(true)} />
              ) : model && netKey ? (
                <aside className="props"><div className="row between"><strong>Net {model.netName(netKey) ?? ""}</strong><button className="link small" onClick={() => setNetKey(null)}>clear</button></div>
                  <div className="small muted">{model.members(netKey).length} pins</div>
                  <div className="chips">{model.members(netKey).slice(0, 40).map((m) => <span key={m} className="chip mono">{m}</span>)}</div></aside>
              ) : null} />
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
