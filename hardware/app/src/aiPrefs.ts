import { useEffect, useState } from "react"
import type { AiProvider } from "./api"

/** Browser-side AI choices: the provider last used in the builder and any provider switched off in Settings. Keys never go here. */
export type AiPrefs = { provider: string | null; disabled: string[] }
const KEY = "ai.prefs"
const EVT = "ai-prefs"

function read(): AiPrefs {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null")
    return { provider: typeof r?.provider === "string" ? r.provider : null, disabled: Array.isArray(r?.disabled) ? r.disabled.filter((x: unknown) => typeof x === "string") : [] }
  } catch { return { provider: null, disabled: [] } }
}
let current: AiPrefs = read()

export const loadPrefs = (): AiPrefs => current
export function savePrefs(patch: Partial<AiPrefs>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage blocked: the choice lasts until reload */ }
  dispatchEvent(new Event(EVT))
}

export function useAiPrefs(): AiPrefs {
  const [prefs, setPrefs] = useState(loadPrefs)
  useEffect(() => {
    const on = () => { current = read(); setPrefs(current) }
    addEventListener(EVT, on)
    addEventListener("storage", on)
    return () => { removeEventListener(EVT, on); removeEventListener("storage", on) }
  }, [])
  return prefs
}

/** A provider can be used when it has a key and a model and has not been switched off. */
export const isUsable = (p: AiProvider, prefs: AiPrefs) => p.configured && !!p.model && !prefs.disabled.includes(p.id)

/** Keep the current choice while it is usable; otherwise the remembered one; otherwise the first usable one. */
export function pickProvider(list: AiProvider[], prefs: AiPrefs, now: string): string {
  const ok = (id: string | null) => !!id && list.some((p) => p.id === id && isUsable(p, prefs))
  if (ok(now)) return now
  if (ok(prefs.provider)) return prefs.provider!
  const first = list.find((p) => isUsable(p, prefs))
  if (first) return first.id
  // nothing usable (for example the key was cleared by a restart): keep the provider used last, so it is the one to re-key
  if (prefs.provider && list.some((p) => p.id === prefs.provider)) return prefs.provider
  return list.some((p) => p.id === now) ? now : list[0]?.id ?? now
}

/** Top-tier model families that cost noticeably more per request. A hint taken from the model id, not a price list. */
export const isPremiumModel = (id: string) => /(^|[-_/.])(opus|fable)([-_/.]|$)|-pro(-|$)/i.test(id)
export const modelLabel = (id: string, label: string) => (isPremiumModel(id) ? `${label} (premium)` : label)
