import { useEffect, useState } from "react"
import type { Live } from "./aiChat"

/** The assistant's turn while a request is running: what it is doing, how long it has been, and a Stop button. */
export default function AiProgress({ live, model, onStop }: { live: Live; model?: string; onStop: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const secs = Math.max(0, Math.round((now - live.startedAt) / 1000))
  return (
    <article className="card ai-turn assistant ai-working" role="status" aria-live="polite">
      <div className="ai-working-head">
        <span className="dot pulse" aria-hidden />
        <b>Working</b>
        <span className="muted small mono">{secs}s{live.step ? ` · model call ${live.step}` : ""}</span>
        <span className="grow" />
        <button className="btn small-btn danger" onClick={onStop} title="Stop the request now; anything already changed stays on the working draft">Stop</button>
      </div>
      <div className="muted small">{live.phase}{model ? ` · ${model}` : ""}</div>
      {live.tools.length > 0 && (
        <ul className="ai-working-tools">
          {live.tools.map((t, i) => <li key={i} className={t.ok ? "" : "bad"}><code>{t.tool}</code> <span className="muted">{t.summary}</span></li>)}
        </ul>
      )}
    </article>
  )
}
