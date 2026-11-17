import { STAGES, STATUS_LABEL, type Board, type Status } from "./boards"

const SHAPE: Record<Status, string> = { draft: "◌", failing: "✕", review: "◐", ready: "✓", ordered: "●", delivered: "✓" }

/** Status is never colour alone: each state also has a shape and a label. */
export function StatusChip({ status }: { status: Status }) {
  return <span className={`status-chip s-${status}`}><i aria-hidden>{SHAPE[status]}</i>{STATUS_LABEL[status]}</span>
}

/** Six-segment strip: filled = done, outlined = current, red = blocked here. */
export function StageStrip({ board }: { board: Board }) {
  return (
    <div className="strip" role="img" aria-label={`Stage: ${board.stage >= STAGES.length ? "all done" : STAGES[board.stage]}`}>
      {STAGES.map((s, i) => (
        <span key={s} title={s} className={i < board.stage ? "done" : i === board.stage ? (board.status === "failing" ? "bad" : "now") : ""} />
      ))}
    </div>
  )
}

/** The order pipeline. `done[i]` marks finished steps; the first unfinished one is current. */
export function Stepper({ steps, done, note }: { steps: readonly string[]; done: boolean[]; note?: (i: number) => string | undefined }) {
  const cur = done.findIndex((d) => !d)
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s} className={done[i] ? "done" : i === cur ? "now" : ""} aria-current={i === cur ? "step" : undefined}>
          <span className="step-dot" aria-hidden>{done[i] ? "✓" : i + 1}</span>
          <span className="step-text"><b>{s}</b>{note?.(i) && <small>{note(i)}</small>}</span>
        </li>
      ))}
    </ol>
  )
}

export const Icon = {
  projects: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></svg>,
  overview: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13h4l2-7 4 12 2-5h4" /></svg>,
  workspace: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="7.5" cy="9.5" r="1" /><circle cx="16.5" cy="14.5" r="1" /><path d="M7.5 9.5h5l2 5h2" /></svg>,
  order: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" /></svg>,
  orders: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></svg>,
  settings: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  sun: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
}
