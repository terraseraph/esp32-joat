import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, iterApi, type BuildMode, type BuildResult, type BuildStatus, type CheckIssue, type Design, type Meta, type PropValue, type SrcComponent } from "./api"
import { buildModel } from "./pcbModel"
import Properties from "./Properties"
import type { PcbPick } from "./PcbEdit"
import { useToast } from "./toast"
import Editor from "./Editor"
import Preview from "./Preview"
import Problems from "./Problems"
import Bom from "./Bom"
import BuildProgress from "./BuildProgress"
import Palette, { PALETTE_MIME } from "./Palette"
import Connect, { NO_CONNECT, type ConnectState } from "./Connect"
import Gpio from "./Gpio"
import { indexCircuit } from "../../shared/nets"
import Snapshots, { type ActiveDiff } from "./Snapshots"
import DiffView from "./DiffView"
import { useHistory } from "./useHistory"
import Review from "./Review"

function useSplit(initial: number, min: number, max: number, axis: "x" | "y", invert = false) {
  // clamp: innerWidth is 0 when the tab first renders in the background
  const [size, setSize] = useState(() => Math.min(max, Math.max(min, initial)))
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

export type BuildState = { status: "idle" | "building" | "ok" | "error"; durationMs?: number; fatal?: string; mode?: BuildMode; cached?: boolean }

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
  const [panel, setPanel] = useState<"problems" | "review" | "bom" | "nets" | "gpio" | "history">("problems")
  const [panelOpen, setPanelOpen] = useState(true)
  const [bomVersion, setBomVersion] = useState(0)
  const [dropId, setDropId] = useState<{ id: string; n: number } | null>(null)
  const knownNames = useMemo(() => (circuit ?? []).filter((e) => e.type === "source_component" && e.name).map((e) => String(e.name)), [circuit])
  const [conn, setConn] = useState<ConnectState>(NO_CONNECT)
  // read by the PCB view pick handler: in Connect mode a pad click picks that pin
  const connectRef = useRef<{ on: boolean; onPort: (portId: string) => void }>({ on: false, onPort: () => {} })
  const circuitIndex = useMemo(() => (circuit ? indexCircuit(circuit) : null), [circuit])
  const [focus, setFocus] = useState<{ where: NonNullable<CheckIssue["where"]>; nonce: number } | null>(null)
  const buildSeq = useRef(0)
  const filesRef = useRef(files)
  filesRef.current = files
  /** Every non-editor edit (properties panel, palette insert, connect, GPIO map) goes through history as one undo step. */
  const setFiles = useCallback((u: Record<string, string> | ((f: Record<string, string>) => Record<string, string>)) => {
    hist.push(typeof u === "function" ? u : () => u)
  }, [hist.push])

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

  const srcOf = (n: string) => (model?.dupNames.has(n) ? undefined : srcComps.find((c) => c.name === n))
  /** Part can be moved/rotated from the board: it has its own line, isn't in a loop, and has literal pcbX/pcbY. */
  const whyReadOnly = (n: string): string | null => {
    if (model?.dupNames.has(n)) return `${n} is ambiguous (the same name is used by a lib/ block part and a design element)`
    const s = srcComps.find((c) => c.name === n)
    if (!s) return `${n} comes from a shared lib/ block, so it can't be moved from here`
    if (s.inLoop) return `${n} is made by a loop in the code; edit it there`
    if (typeof s.props.pcbX !== "number" || typeof s.props.pcbY !== "number") return `${n} has no plain pcbX/pcbY number in the code (it is positioned by its group or an expression); edit it in the code`
    return null
  }
  const isEditable = useCallback((n: string) => whyReadOnly(n) === null, [srcComps, model]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Rewrite the source for one component. Serialised, and relative `delta`s are resolved by the server against the
   * text it patches, so quick repeated nudges/rotations never act on a stale value. If the user typed in the code
   * pane while the request was in flight, the patch is redone on the new text instead of overwriting it.
   */
  const applyProps = useCallback((comp: string, props: Record<string, PropValue>, delta?: Record<string, number>) => {
    editChain.current = editChain.current.then(async () => {
      try {
        for (let i = 0; i < 3; i++) {
          const snap = filesRef.current
          const r = await api.patchComponent(name, comp, props, snap, delta)
          if (filesRef.current[r.file] !== snap[r.file]) continue
          filesRef.current = { ...filesRef.current, [r.file]: r.content }
          setFiles(filesRef.current)
          if (typeof props.name === "string") setSelected(props.name)
          for (const w of r.warnings ?? []) toast("info", w)
          return
        }
        toast("err", "The code kept changing while applying the edit; try again")
      } catch (e: any) {
        toast("err", e.message)
      }
    })
  }, [name, toast])

  const guard = (n: string) => {
    const why = whyReadOnly(n)
    if (why) toast("info", why)
    return !why
  }
  const onMove = useCallback((n: string, dx: number, dy: number) => {
    if (!guard(n)) return
    applyProps(n, {}, { pcbX: dx, pcbY: dy })
  }, [srcComps, model, applyProps]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRotate = useCallback((n: string, d: number) => {
    if (!guard(n)) return
    if (d) applyProps(n, {}, { pcbRotation: d })
  }, [srcComps, model, applyProps]) // eslint-disable-line react-hooks/exhaustive-deps
  const onPick = useCallback((p: PcbPick) => {
    if (connectRef.current.on && p.port) { connectRef.current.onPort(p.port); return }
    if (p.clear) { setSelected(null); setNetKey(null); return }
    if (p.comp !== undefined) setSelected(p.comp)
    if (p.key !== undefined) setNetKey(p.key)
    else if (p.comp) setNetKey(null)
  }, [])
  useEffect(() => { setSelected(null); setNetKey(null) }, [name])

  const runBuild = useCallback(async (mode: BuildMode = "quick") => {
    const id = ++buildSeq.current
    setBuild((b) => ({ ...b, status: "building", fatal: undefined, mode }))
    try {
      const r = await api.build(name, filesRef.current, mode)
      if (id !== buildSeq.current) return
      if (r.cancelled) { setBuild((b) => ({ ...b, status: "idle" })); return }
      setResult(r)
      // design-rule errors still produce a board: show it; keep the last board only when nothing was produced
      if (r.circuitJson?.length) setCircuit(r.circuitJson)
      setBuild({ status: r.errors.length ? "error" : "ok", durationMs: r.durationMs, mode: r.mode ?? mode, cached: r.cached })
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
        // show the last good build from disk immediately while the rebuild runs
        api.cachedBuild(name).then((c) => {
          if (c?.circuitJson?.length) setCircuit((cur) => cur ?? c.circuitJson)
        })
        runBuild("quick")
      })
      .catch((e) => setLoadErr(e.message))
  }, [name, runBuild, hist.reset])

  // debounced rebuild on edits
  const first = useRef(true)
  useEffect(() => {
    if (!design) return
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => runBuild("quick"), 1000)
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

  const onPort = (schematicPortId: string) => {
    // the viewer reports either a schematic_port id or a source_port id
    const port = circuitIndex?.ports[circuitIndex.portBySchematic[schematicPortId] ?? schematicPortId]
    if (!port) return
    setConn((s) => ({ ...s, picks: s.picks.length >= 2 ? [{ ref: port.ref, pin: port.pin }] : [...s.picks, { ref: port.ref, pin: port.pin }] }))
  }
  connectRef.current = { on: conn.on, onPort }
  const highlightIds = (() => {
    const net = circuitIndex?.nets.find((n) => n.name === conn.highlightNet)
    return net ? net.pins.map((p) => circuitIndex!.ports[p.sourcePortId].schematicComponentId).filter((x): x is string => !!x) : []
  })()
  const setIndexSource = (src: string) => setFiles((f) => ({ ...f, "index.tsx": src }))

  // board.json is the single source for checklist + rules; Review patches it on disk through the API
  const boardMeta = useMemo<Meta>(() => { try { return JSON.parse(files["board.json"] ?? "null") } catch { return null } }, [files])
  const onMetaSaved = useCallback((text: string) => {
    setSaved((s) => ({ ...s, "board.json": text }))
    setFiles((f) => ({ ...f, "board.json": text }))
  }, [])
  const locate = useCallback((i: CheckIssue) => { if (i.where) setFocus({ where: i.where, nonce: Date.now() }) }, [])

  if (loadErr) return <div className="empty err">Could not load "{name}": {loadErr}</div>
  if (!design) return <div className="empty">Loading…</div>

  const errCount = result?.errors.length ?? 0
  const probErr = result?.checks?.counts.error ?? errCount // Problems badge includes design-rule checks
  const probWarn = result?.checks?.counts.warning ?? (result?.warnings.length ?? 0)
  const hasErrors = build.status === "error"
  const cancel = () => {
    buildSeq.current++
    setBuild((b) => ({ ...b, status: "idle" }))
    api.cancelBuild(name).catch(() => {})
  }

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
              {build.status === "building" && <BuildProgress name={name} mode={build.mode ?? "quick"} onCancel={cancel} />}
              {build.status === "ok" && `${build.mode === "full" ? "Routed" : "Quick preview"} in ${((build.durationMs ?? 0) / 1000).toFixed(1)}s${build.cached ? " (cached)" : ""}`}
              {build.status === "error" && (build.fatal ? `Build failed` : `${errCount} error${errCount === 1 ? "" : "s"}`)}
              {build.status === "idle" && "Idle"}
              {build.status === "error" && circuit && !result?.circuitJson?.length && <span className="muted"> · showing last good</span>}
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
        <button className={`btn ${codeOpen ? "on" : ""}`} onClick={() => toggleCode(!codeOpen)} aria-pressed={codeOpen} title="Show or hide the source code">{"</>"} Code</button>
        <button className="btn" onClick={() => { setPanel("history"); setPanelOpen(true) }} title="Open snapshots">Snapshots</button>
        <button className="btn" onClick={newVariant} title="Copy this design to a new revision folder">New variant</button>
        <button className="btn" onClick={() => runBuild("quick")} disabled={build.status === "building"} title="Fast build: placement + ratsnest, no autorouting">Build</button>
        <button className="btn" onClick={() => runBuild("full")} disabled={build.status === "building"} title="Full build with autorouting (slow on big boards)">Route</button>
        <button className="btn" onClick={() => save()} disabled={!dirty}>Save</button>
        <button className="btn primary" onClick={doExport} title={hasErrors ? "Last build had errors" : "Download JLCPCB zip"}>
          {hasErrors && <span className="dot bad" />}Export
        </button>
      </div>

      <div className="panes">
        <Palette name={name} getSource={() => filesRef.current["index.tsx"] ?? ""} knownNames={knownNames} dropId={dropId} onInsert={(src) => { setFiles((f) => ({ ...f, "index.tsx": src })); setActive("index.tsx") }} />
        <div className="gutter x" />
        {codeOpen && (
          <>
            <section className="pane editor-pane" style={{ width: left.size }}>
              <Editor files={files} saved={saved} active={active} setActive={setActive} onChange={edit} />
            </section>
            <div className="gutter x" onPointerDown={left.onPointerDown} />
          </>
        )}
        <div className="right">
          <section className="pane preview-pane"
            onDragOver={(e) => { if (e.dataTransfer.types.includes(PALETTE_MIME)) e.preventDefault() }}
            onDrop={(e) => { const id = e.dataTransfer.getData(PALETTE_MIME); if (id) { e.preventDefault(); setDropId({ id, n: Date.now() }) } }}>
            {diff ? <DiffView diff={diff.result} label={diff.label} focus={diffFocus} onFocus={setDiffFocus} onClose={() => { setDiff(null); setDiffFocus(null) }} /> : <Preview circuitJson={circuit} building={build.status === "building"} focus={focus} connect={{ on: conn.on, onPort, highlightIds }}
              canvas={model ? { model, fitKey: name, selected, netKey, editable: isEditable, snap, setSnap, onPick, onMove, onRotate } : undefined}
              overlay={model && selected && model.compByName.get(selected) ? (
                <Properties comp={model.compByName.get(selected)!} src={srcOf(selected)} model={model} netKey={netKey}
                  onChange={(p) => applyProps(selected, p)} onClose={() => { setSelected(null); setNetKey(null) }}
                  onClearNet={() => setNetKey(null)} onOpenCode={() => toggleCode(true)} />
              ) : model && netKey ? (
                <aside className="props"><div className="row between"><strong>Net {model.netName(netKey) ?? ""}</strong><button className="link small" onClick={() => setNetKey(null)}>clear</button></div>
                  <div className="small muted">{model.members(netKey).length} pins</div>
                  <div className="chips">{model.members(netKey).slice(0, 40).map((m) => <span key={m} className="chip mono">{m}</span>)}</div></aside>
              ) : null} />}
          </section>
          <div className="gutter y" onPointerDown={panelOpen ? bottom.onPointerDown : undefined} />
          <section className="pane bottom" style={{ height: panelOpen ? bottom.size : 38 }}>
            <div className="tabs small">
              {(["problems", "review", "bom", "nets", "gpio", "history"] as const).map((t) => (
                <button key={t} className={`tab ${panel === t ? "on" : ""}`} onClick={() => { setPanel(t); setPanelOpen(true) }}>
                  {panel === t && <motion.span layoutId="bottab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
                  <span className="tab-label">
                    {{ problems: "Problems", review: "Review", bom: "BOM & cost", nets: "Nets & connect", gpio: "GPIO map", history: "Snapshots & diff" }[t]}
                    {t === "problems" && (probErr > 0 || probWarn > 0) && (
                      <span className="counts">
                        {probErr > 0 && <span className="cnt bad">{probErr}</span>}
                        {probWarn > 0 && <span className="cnt warn">{probWarn}</span>}
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
                  <Problems result={result} fatal={build.fatal} onLocate={locate} />
                ) : panel === "review" ? (
                  <Review name={name} checklist={boardMeta?.checklist ?? []} notes={boardMeta?.notes ?? ""} rules={boardMeta?.rules} baseText={files["board.json"]} onMetaSaved={onMetaSaved} />
                ) : panel === "nets" ? (
                  <Connect name={name} index={circuitIndex} source={files["index.tsx"] ?? ""} onSource={setIndexSource} onFiles={(f) => setFiles((x) => ({ ...x, ...f }))} state={conn} setState={setConn} />
                ) : panel === "gpio" ? (
                  <Gpio name={name} source={files["index.tsx"] ?? ""} onSource={setIndexSource} />
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
