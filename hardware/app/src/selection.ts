import type { AiContext } from "./api"
import type { Region } from "./PcbEdit"

/** What is selected on the board right now: parts (click, shift-click, box), a highlighted net, and the box itself. */
export type AiSelection = {
  parts: string[]
  net: { name: string; pins: string[] } | null
  region: Region | null
}
export const NO_SELECTION: AiSelection = { parts: [], net: null, region: null }
export const hasSelection = (s: AiSelection) => s.parts.length > 0 || !!s.net || !!s.region

// the API caps these; trimming here keeps a big net or box from failing the whole request
export const MAX_PARTS = 20
export const MAX_PINS = 60
// the same shapes the API accepts: a name outside them would be a 400 for the whole request, so it is left out instead
const REF_RE = /^[A-Za-z][\w-]{0,39}$/
const PIN_RE = /^[A-Za-z][\w-]{0,39}\.[\w+-]{1,40}$/
const NET_RE = /^[\w.~/+-]{1,80}$/

/** Parts and pins that cannot be sent because of their names (so the UI can say so). */
export function unsendable(sel: AiSelection) {
  return { parts: sel.parts.filter((p) => !REF_RE.test(p)), pins: sel.net ? sel.net.pins.filter((p) => !PIN_RE.test(p)) : [], net: !!sel.net && !NET_RE.test(sel.net.name) }
}

/** The `context` the AI request carries. `snapshot` adds a picture of that view. */
export function contextOf(sel: AiSelection, include: { snapshot: "pcb" | "schematic" | null }): AiContext | undefined {
  const c: AiContext = {}
  const parts = sel.parts.filter((p) => REF_RE.test(p)).slice(0, MAX_PARTS)
  if (parts.length) c.parts = parts
  if (sel.net && NET_RE.test(sel.net.name)) c.net = { name: sel.net.name, pins: sel.net.pins.filter((p) => PIN_RE.test(p)).slice(0, MAX_PINS) }
  if (sel.region) c.region = { view: "pcb", ...sel.region, parts }
  if (include.snapshot) c.snapshot = include.snapshot
  return Object.keys(c).length ? c : undefined
}
