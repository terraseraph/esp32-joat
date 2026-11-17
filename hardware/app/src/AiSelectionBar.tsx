import type { AiSelection } from "./selection"
import { hasSelection, MAX_PARTS, MAX_PINS, unsendable } from "./selection"

type Change = { parts?: string[]; net?: null; region?: null }

/** What will be sent with the request: the selected parts, net and box (each removable), plus an optional picture of the view. */
export default function AiSelectionBar({ selection, onSelection, snapshot, setSnapshot, disabled }: {
  selection: AiSelection
  onSelection: (n: Change) => void
  snapshot: "pcb" | "schematic" | null
  setSnapshot: (s: "pcb" | "schematic" | null) => void
  disabled?: boolean
}) {
  const { parts, net, region } = selection
  const skip = unsendable(selection)
  return (
    <div className="ai-selbar" aria-label="Attached to your request">
      {hasSelection(selection) && <span className="muted small">Attached:</span>}
      {!hasSelection(selection) && <span className="muted small" title="Shift-click adds more parts, shift-drag boxes a region, clicking a pad adds its net">Click a part to attach it</span>}
      {parts.map((p) => (
        <span key={p} className="sel-chip mono">{p}<button disabled={disabled} aria-label={`Remove ${p}`} onClick={() => onSelection({ parts: parts.filter((x) => x !== p) })}>×</button></span>
      ))}
      {parts.length > MAX_PARTS && <span className="muted small">only the first {MAX_PARTS} are sent</span>}
      {skip.parts.length > 0 && <span className="muted small">{skip.parts.join(", ")} not sent (unusual name)</span>}
      {net && <span className="sel-chip net">Net {net.name} · {net.pins.length} pin{net.pins.length === 1 ? "" : "s"}{skip.net ? " (name not sent)" : net.pins.length > MAX_PINS ? ` (first ${MAX_PINS} sent)` : skip.pins.length ? ` (${skip.pins.length} not sent)` : ""}<button disabled={disabled} aria-label="Remove net" onClick={() => onSelection({ net: null })}>×</button></span>}
      {region && <span className="sel-chip">Box {region.w.toFixed(1)}×{region.h.toFixed(1)} mm<button disabled={disabled} aria-label="Remove box" onClick={() => onSelection({ region: null })}>×</button></span>}
      <label className="sel-snap small">Picture
        <select aria-label="Attach a picture of the view" value={snapshot ?? ""} disabled={disabled} onChange={(e) => setSnapshot((e.target.value || null) as "pcb" | "schematic" | null)}>
          <option value="">none</option>
          <option value="pcb">PCB view</option>
          <option value="schematic">Schematic view</option>
        </select>
      </label>
    </div>
  )
}
