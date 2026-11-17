import type { AiState } from "./api"

/** The model's reasoning and running notes for one answer, collapsed by default. Says so when the model returned none. */
export default function AiThinking({ result }: { result?: AiState }) {
  if (!result) return null
  const items = result.thinking ?? []
  if (!items.length) return result.thinkingSupported === false ? <p className="muted small ai-no-thinking">This model did not return its reasoning.</p> : null
  const reasoning = items.filter((i) => i.kind === "reasoning").length
  const notes = items.length - reasoning
  return (
    <details className="ai-thinking">
      <summary>Thinking{reasoning ? ` (${reasoning} step${reasoning === 1 ? "" : "s"})` : ""}{notes ? `${reasoning ? " and" : ""} ${notes} note${notes === 1 ? "" : "s"}` : ""}</summary>
      {items.map((t, i) => (
        <div className="think-item" key={i}>
          <span className="muted small">Step {t.step + 1} · {t.kind === "reasoning" ? "reasoning" : "note"}</span>
          <div className="think-text">{t.text}</div>
        </div>
      ))}
    </details>
  )
}
