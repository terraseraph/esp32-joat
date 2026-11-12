import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import type { BuildResult, Issue } from "./api"

function Row({ issue, kind, i }: { issue: Issue; kind: "bad" | "warn"; i: number }) {
  const [open, setOpen] = useState(false)
  return (
    <motion.div
      className="issue"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay: Math.min(i, 10) * 0.02 }}
    >
      <button className="issue-head" onClick={() => issue.stack && setOpen((o) => !o)}>
        <span className={`dot ${kind}`} />
        <span className="issue-type mono">{issue.type}</span>
        <span className="issue-msg">{issue.message}</span>
        {issue.stack && <span className="muted small">{open ? "hide" : "stack"}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && issue.stack && (
          <motion.pre
            className="stack mono"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {issue.stack}
          </motion.pre>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default function Problems({ result, fatal }: { result: BuildResult | null; fatal?: string }) {
  const errors = result?.errors ?? []
  const warnings = result?.warnings ?? []
  if (!fatal && !errors.length && !warnings.length)
    return <div className="empty small">{result ? "No problems." : "Waiting for a build."}</div>
  return (
    <div className="issues">
      {fatal && <Row issue={{ type: "build_failed", message: fatal }} kind="bad" i={0} />}
      {errors.map((e, i) => <Row key={"e" + i + e.message} issue={e} kind="bad" i={i} />)}
      {warnings.map((w, i) => <Row key={"w" + i + w.message} issue={w} kind="warn" i={i + errors.length} />)}
    </div>
  )
}
