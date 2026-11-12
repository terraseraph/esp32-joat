import { useEffect, useMemo, useState } from "react"
import { api, type Explain as ExplainT, type PartInfo } from "./api"

/** rects drawn over the PCB viewer (graphics-debug format) */
export type Highlight = { rects: { center: { x: number; y: number }; width: number; height: number; fill: string; stroke: string; label?: string }[] }

export function highlightFor(parts: PartInfo[], refs: string[]): Highlight | null {
  const set = new Set(refs)
  const rects = parts
    .filter((p) => set.has(p.ref) && p.x !== null && p.y !== null)
    .map((p) => ({
      center: { x: p.x!, y: p.y! },
      width: (p.width ?? 2) + 3,
      height: (p.height ?? 2) + 3,
      fill: "rgba(255, 200, 0, 0.5)",
      stroke: "#ffc800",
      label: p.ref,
    }))
  return rects.length ? { rects } : null
}

export default function Explain({ name, version, onHighlight }: { name: string; version: number; onHighlight: (h: Highlight | null) => void }) {
  const [data, setData] = useState<ExplainT | null>(null)
  const [parts, setParts] = useState<PartInfo[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setErr(null)
    Promise.all([api.explain(name), api.parts(name)])
      .then(([e, c]) => { if (live) { setData(e); setParts(c) } })
      .catch((e) => live && setErr(e.message))
    return () => { live = false }
  }, [name, version])
  useEffect(() => () => onHighlight(null), [onHighlight])

  const pick = (key: string, refs: string[]) => {
    const next = sel === key ? null : key
    setSel(next)
    onHighlight(next ? highlightFor(parts, refs) : null)
  }
  const bySource = useMemo(() => new Map(parts.map((p) => [p.ref, p.source?.file ?? ""])), [parts])

  if (err) return <div className="empty err">{err}</div>
  if (!data) return <div className="empty">Reading the board…</div>
  return (
    <div className="explain">
      <div className="summary">{data.summary} <span className="small">(from the last saved build; click a line to highlight its parts on the PCB)</span></div>
      {data.groups.map((g) => (
        <div className="ex-group" key={g.id}>
          <h4>{g.title}</h4>
          {g.sentences.map((s, i) => {
            const key = `${g.id}:${i}`
            return (
              <button key={key} className={`ex-sent ${sel === key ? "on" : ""} ${s.refs.length ? "" : "static"}`} onClick={() => s.refs.length && pick(key, s.refs)} title={s.refs.length ? [...new Set(s.refs.map((r) => bySource.get(r)).filter(Boolean))].join(", ") : undefined}>
                {s.text}
                <span className="chips">{s.refs.slice(0, 12).map((r) => <span className="chip" key={r}>{r}</span>)}{s.refs.length > 12 && <span className="chip">+{s.refs.length - 12}</span>}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
