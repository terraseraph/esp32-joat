import { useEffect, useState } from "react"
import { motion } from "motion/react"
import { api, iterApi, newBoardJson, NEW_INDEX, type DesignSummary, type GitStatus } from "./api"
import { useToast } from "./toast"

export default function DesignList({ git }: { git: GitStatus | null }) {
  const [list, setList] = useState<DesignSummary[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const toast = useToast()

  useEffect(() => {
    api.designs().then(setList).catch((e) => setErr(e.message))
  }, [])

  const create = async () => {
    const n = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
    if (!n) return
    if (list?.some((d) => d.name === n)) return toast("err", `"${n}" already exists`)
    try {
      await api.save(n, { "index.tsx": NEW_INDEX, "board.json": newBoardJson(n) })
      location.hash = `#/design/${encodeURIComponent(n)}`
    } catch (e: any) {
      toast("err", e.message)
    }
  }

  const variant = async (e: React.MouseEvent, from: string) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      const v = await iterApi.variant(from)
      toast("ok", `Created ${v.name} (rev ${v.revision})`)
      location.hash = `#/design/${encodeURIComponent(v.name)}`
    } catch (err: any) { toast("err", err.message) }
  }

  return (
    <div className="list-page">
      <div className="list-head">
        <h1>Designs</h1>
        {creating ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); create() }}>
            <input autoFocus className="input" placeholder="design-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setCreating(false)} />
            <button className="btn primary" type="submit">Create</button>
            <button className="btn" type="button" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        ) : (
          <button className="btn primary" onClick={() => setCreating(true)}>+ New design</button>
        )}
      </div>
      {err && <div className="empty err">Could not reach the API: {err}</div>}
      {!list && !err && <div className="empty">Loading…</div>}
      {list && list.length === 0 && <div className="empty">No designs yet. Create one to get started.</div>}
      <div className="cards">
        {list?.map((d, i) => {
          const dirty = git?.files.some((f) => f.path.replace(/\\/g, "/").includes(`designs/${d.name}/`))
          return (
            <motion.a
              key={d.name}
              href={`#/design/${encodeURIComponent(d.name)}`}
              className="card"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03, ease: "easeOut" }}
              whileHover={{ y: -2 }}
            >
              <div className="card-top">
                <h3>{d.meta?.name || d.name}</h3>
                {d.meta?.revision && <span className="chip">rev {d.meta.revision}</span>}
              </div>
              <p>{d.meta?.description || <span className="muted">No description</span>}</p>
              <div className="card-foot mono">
                <span>{d.name}</span>
                {dirty && <span className="dirty-tag">uncommitted</span>}
                <button className="btn ghost" onClick={(e) => variant(e, d.name)} title="Copy to a new revision folder">New variant</button>
              </div>
            </motion.a>
          )
        })}
      </div>
    </div>
  )
}
