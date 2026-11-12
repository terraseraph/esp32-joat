import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type BuildMode, type BuildResult, type BuildStatus, type Design, type PropValue, type SrcComponent } from "./api"
import { buildModel } from "./pcbModel"
import Properties from "./Properties"
import type { PcbPick } from "./PcbEdit"
import { useToast } from "./toast"
import Editor from "./Editor"
import Preview from "./Preview"
import Problems from "./Problems"
import Bom from "./Bom"
import BuildProgress from "./BuildProgress"

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
        setFiles(d.files)
        setActive(d.files["index.tsx"] !== undefined ? "index.tsx" : Object.keys(d.files)[0])
        filesRef.current = d.files
        // show the last good build from disk immediately while the rebuild runs
        api.cachedBuild(name).then((c) => {
          if (c?.circuitJson?.length) setCircuit((cur) => cur ?? c.circuitJson)
        })
        runBuild("quick")
      })
      .catch((e) => setLoadErr(e.message))
  }, [name, runBuild])

  // debounced rebuild on edits
  const first = useRef(true)
  useEffect(() => {
    if (!design) return
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => runBuild("quick"), 1000)
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
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className={`btn ${codeOpen ? "on" : ""}`} onClick={() => toggleCode(!codeOpen)} aria-pressed={codeOpen} title="Show or hide the source code">{"</>"} Code</button>
        <button className="btn" onClick={() => runBuild("quick")} disabled={build.status === "building"} title="Fast build: placement + ratsnest, no autorouting">Build</button>
        <button className="btn" onClick={() => runBuild("full")} disabled={build.status === "building"} title="Full build with autorouting (slow on big boards)">Route</button>
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
