import { useMemo, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import type { BuildResult, CheckIssue, Issue } from "./api"

const SEV_DOT = { error: "bad", warning: "warn", info: "" } as const
const SEV_LABEL = { error: "Errors", warning: "Warnings", info: "Hints" } as const

/** Fallback when the server sent no explained checks (older API or crashed check run). */
const legacy = (issues: Issue[], sev: "error" | "warning"): CheckIssue[] =>
  issues.map((e, i) => ({ id: `${sev}-${i}`, severity: sev, source: "build", rule: e.type, title: e.type.replace(/_/g, " "), message: e.message, why: "" }))

function Row({ issue, i, onLocate, stack }: { issue: CheckIssue; i: number; onLocate?: (i: CheckIssue) => void; stack?: string }) {
  const [open, setOpen] = useState(false)
  const canLocate = !!issue.where && !!onLocate
  const hasMore = !!(issue.why || issue.fix || stack)
  return (
    <motion.div className="issue" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, delay: Math.min(i, 10) * 0.02 }}>
      <div className="issue-head">
        <span className={`dot ${SEV_DOT[issue.severity]}`} />
        <button className="issue-main" onClick={() => (canLocate ? onLocate!(issue) : hasMore && setOpen((o) => !o))} title={canLocate ? "Show on the board" : undefined}>
          <span className="issue-title">{issue.title}</span>
          <span className="issue-msg muted">{issue.message}</span>
          {issue.refs && <span className="issue-refs">{issue.refs.slice(0, 4).map((r) => <span className="chip mono" key={r}>{r}</span>)}</span>}
        </button>
        {canLocate && <button className="btn ghost sm" onClick={() => onLocate!(issue)}>Show</button>}
        {hasMore && <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Less" : "Why?"}</button>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="issue-more" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            {issue.why && <p><b>Why it matters.</b> {issue.why}</p>}
            {issue.fix && <p><b>How to fix.</b> {issue.fix}</p>}
            <p className="muted small mono">{issue.rule}{issue.where?.layer ? ` · ${issue.where.layer}` : ""}</p>
            {stack && <pre className="stack mono">{stack}</pre>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default function Problems({ result, fatal, onLocate }: { result: BuildResult | null; fatal?: string; onLocate?: (i: CheckIssue) => void }) {
  const [showInfo, setShowInfo] = useState(false)
  const issues = useMemo<CheckIssue[]>(() => result?.checks?.issues ?? [...legacy(result?.errors ?? [], "error"), ...legacy(result?.warnings ?? [], "warning")], [result])
  const stackOf = (i: CheckIssue) => result?.errors.find((e) => e.message === i.message)?.stack
  const groups = (["error", "warning", "info"] as const).map((s) => ({ s, list: issues.filter((i) => i.severity === s) }))
  const shown = groups.filter((g) => g.list.length && (g.s !== "info" || showInfo))
  const hidden = groups.find((g) => g.s === "info")!.list.length

  if (!fatal && !issues.length) return <div className="empty small">{result ? "No problems." : "Waiting for a build."}</div>
  let n = 0
  return (
    <div className="issues">
      {fatal && <Row issue={{ id: "fatal", severity: "error", source: "build", rule: "build_failed", title: "Build failed", message: fatal, why: "" }} i={0} />}
      {shown.map((g) => (
        <div key={g.s}>
          <div className="issue-group muted small">{SEV_LABEL[g.s]} · {g.list.length}</div>
          {g.list.map((i) => <Row key={i.id} issue={i} i={n++} onLocate={onLocate} stack={stackOf(i)} />)}
        </div>
      ))}
      {hidden > 0 && (
        <button className="btn ghost sm issue-toggle" onClick={() => setShowInfo((v) => !v)}>
          {showInfo ? "Hide" : "Show"} {hidden} tooling hint{hidden === 1 ? "" : "s"}
        </button>
      )}
    </div>
  )
}
