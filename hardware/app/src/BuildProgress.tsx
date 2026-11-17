import { useEffect, useState } from "react"
import { api, type BuildMode, type BuildStatus } from "./api"

/** Toolbar progress for a running build: phase, elapsed timer, progress bar, Cancel. Polls the API. */
export default function BuildProgress({ name, mode, onCancel }: { name: string; mode: BuildMode; onCancel: () => void }) {
  const [st, setSt] = useState<BuildStatus | null>(null)
  const [t0] = useState(() => Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let live = true
    const poll = () => api.buildStatus(name).then((s) => live && setSt(s)).catch(() => {})
    poll()
    const a = setInterval(poll, 500)
    const b = setInterval(() => setNow(Date.now()), 250)
    return () => { live = false; clearInterval(a); clearInterval(b) }
  }, [name])
  const elapsed = ((st?.state === "running" && st.elapsedMs != null ? Math.max(st.elapsedMs, now - t0) : now - t0) / 1000).toFixed(0)
  const pct = st?.progress != null ? Math.round(st.progress * 100) : null
  return (
    <span className="build-progress">
      {mode === "full" ? "Routing PCB" : mode.startsWith("schematic") ? "Updating schematic" : "Building"}
      {st?.phase && <span className="muted small bp-phase"> · {st.phase.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>}
      {st?.detail && <span className="muted small" title={st.detail}> · {st.detail}</span>}
      <span className="bp-bar"><span className={pct == null ? "indet" : ""} style={pct == null ? undefined : { width: `${pct}%` }} /></span>
      <span className="muted small" title={st?.phaseElapsedMs != null ? `${Math.round(st.phaseElapsedMs / 1000)}s in this phase` : undefined}>{elapsed}s{st?.timeoutMs ? ` / ${Math.round(st.timeoutMs / 1000)}s limit` : ""}</span>
      <button className="btn small" onClick={onCancel}>Cancel</button>
    </span>
  )
}
