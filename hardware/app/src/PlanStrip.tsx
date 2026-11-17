import { useCallback, useEffect, useState } from "react"
import { planApi, type Plan, type PlanItem, type PlanStatus } from "./api"
import { useChangeFeed } from "./useChangeFeed"
import { useToast } from "./toast"

const MARK: Record<PlanStatus, string> = { todo: "", doing: "◐", done: "✓", skipped: "–" }
const LABEL: Record<PlanStatus, string> = { todo: "To do", doing: "In progress", done: "Done", skipped: "Skipped" }

/** The saved build plan for this design: progress, the ordered items, and a way to send "work on this item" to the assistant. */
export default function PlanStrip({ name, disabled, onDo }: { name: string; disabled: boolean; onDo: (message: string) => void }) {
  const toast = useToast()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("ai.plan.open") === "1" } catch { return false } })
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { planApi.get(name).then(setPlan).catch(() => {}) }, [name])
  useEffect(() => { setPlan(null); setConfirmClear(false); load() }, [name, load])
  // the assistant (or an agent in chat) changes the plan as it works: follow it live
  useChangeFeed((e) => { if ((e.type === "plan" && e.design === name) || e.type === "resync") load() })

  if (!plan || plan.items.length === 0) return null
  const done = plan.items.filter((i) => i.status === "done").length
  const next = plan.items.find((i) => i.status === "doing") ?? plan.items.find((i) => i.status === "todo")
  const toggleOpen = () => setOpen((o) => { const v = !o; try { localStorage.setItem("ai.plan.open", v ? "1" : "0") } catch { /* just not remembered */ } return v })

  const setStatus = async (item: PlanItem, status: PlanStatus) => {
    setBusy(true)
    try { setPlan((await planApi.patch(name, item.id, { status })).plan) }
    catch (e: any) { toast("err", e.message) }
    finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true)
    try { await planApi.clear(name); setPlan(null) } catch (e: any) { toast("err", e.message) }
    finally { setBusy(false); setConfirmClear(false) }
  }
  const askFor = (item: PlanItem, n: number) => onDo(`Continue the plan: work on item ${n + 1}, "${item.title}", only (plan item id ${item.id}). Then stop and report.`)

  return (
    <section className="plan-strip" aria-label="Build plan">
      <button className="plan-head" onClick={toggleOpen} aria-expanded={open}>
        <span className="plan-title">Plan</span>
        <span className="plan-count mono">{done}/{plan.items.length}</span>
        <span className="plan-bar" aria-hidden><i style={{ width: `${(done / plan.items.length) * 100}%` }} /></span>
        <span className="plan-next muted small">{next ? `${next.status === "doing" ? "Now" : "Next"}: ${next.title}` : "All items handled"}</span>
        <span className="plan-chev" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="plan-body">
          <p className="small muted plan-goal">{plan.goal}</p>
          <ol className="plan-list">
            {plan.items.map((item, n) => (
              <li key={item.id} className={`plan-item st-${item.status}`}>
                <button
                  className="plan-check"
                  disabled={busy}
                  aria-label={`${item.title}: ${LABEL[item.status]}. ${item.status === "done" ? "Mark as to do" : "Mark as done"}`}
                  title={item.status === "done" ? "Mark as to do" : "Mark as done"}
                  onClick={() => setStatus(item, item.status === "done" ? "todo" : "done")}
                >{MARK[item.status]}</button>
                <div className="plan-item-text">
                  <span className="plan-item-title">{item.title}{item.lcsc && <span className="chip mono">{item.lcsc}</span>}</span>
                  {item.detail && <span className="small muted">{item.detail}</span>}
                  {item.refs.length > 0 && <span className="small muted mono">{item.refs.join(", ")}</span>}
                </div>
                <div className="plan-item-actions">
                  {(item.status === "todo" || item.status === "doing") && <button className="link small" disabled={disabled || busy} onClick={() => askFor(item, n)}>Do this</button>}
                  {item.status === "skipped"
                    ? <button className="link small" disabled={busy} onClick={() => setStatus(item, "todo")}>Restore</button>
                    : item.status !== "done" && <button className="link small" disabled={busy} onClick={() => setStatus(item, "skipped")}>Skip</button>}
                </div>
              </li>
            ))}
          </ol>
          <div className="row plan-actions">
            <button className="btn primary small-btn" disabled={disabled || busy || !next} onClick={() => next && askFor(next, plan.items.indexOf(next))} title="Send the next item to the assistant">Do next</button>
            <span className="grow" />
            {confirmClear
              ? <><span className="small muted">Delete the plan?</span><button className="btn danger small-btn" disabled={busy} onClick={clear}>Delete</button><button className="btn small-btn" onClick={() => setConfirmClear(false)}>Cancel</button></>
              : <button className="link small" onClick={() => setConfirmClear(true)}>Clear plan</button>}
          </div>
        </div>
      )}
    </section>
  )
}
