import { useSyncExternalStore } from "react"
import { aiApi, type AiContext, type AiReply, type AiState } from "./api"
import { onFeed } from "./useChangeFeed"

export type Turn = { role: "user" | "assistant"; content: string; result?: AiState; failed?: boolean }
/** What a running request is doing right now, from the progress events the API pushes. */
export type Live = { startedAt: number; phase: string; step: number; tools: { tool: string; ok: boolean; summary: string }[] }
export type Chat = { turns: Turn[]; busy: boolean; live: Live | null; error: string; draft: string }

// The chat and any running request live here, not in the panel: switching drawer tabs unmounts the panel, and the
// answer to a request that is still running must not be thrown away when that happens.
const chats = new Map<string, Chat>()
const subs = new Set<() => void>()
const EMPTY: Chat = { turns: [], busy: false, live: null, error: "", draft: "" }
const controllers = new Map<string, AbortController>()
/** Called with each finished reply so a mounted panel can pull the assistant's edits into the workspace. */
const absorbers = new Map<string, (r: AiState) => Promise<void> | void>()

// The chat is also kept in localStorage per design, so a page reload (or a dev-server refresh) does not lose the conversation.
// A running request cannot survive a reload, so only the turns and the unsent draft are saved.
const KEY = (name: string) => `ai.chat.${name}`
const MAX_TURNS = 24
const MAX_BYTES = 400_000
function restore(name: string): Chat {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(name)) ?? "null")
    if (!raw || !Array.isArray(raw.turns)) return { ...EMPTY }
    const turns = raw.turns.filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string").slice(-MAX_TURNS)
    return { ...EMPTY, turns, draft: typeof raw.draft === "string" ? raw.draft : "" }
  } catch { return { ...EMPTY } }
}
function persist(name: string, chat: Chat) {
  try {
    let turns = chat.turns.slice(-MAX_TURNS)
    let json = JSON.stringify({ turns, draft: chat.draft })
    // keep the conversation but drop the bulky tool details of older turns if it grows too large
    if (json.length > MAX_BYTES) { turns = turns.map((t, i) => (i < turns.length - 4 ? { ...t, result: undefined } : t)); json = JSON.stringify({ turns, draft: chat.draft }) }
    if (!turns.length && !chat.draft) localStorage.removeItem(KEY(name))
    else localStorage.setItem(KEY(name), json)
  } catch { /* storage full or blocked: the chat just lasts until reload */ }
}
export const getChat = (name: string): Chat => {
  let c = chats.get(name)
  if (!c) { c = restore(name); chats.set(name, c) }
  return c
}
const set = (name: string, patch: Partial<Chat>) => {
  const before = getChat(name)
  const next = { ...before, ...patch }
  chats.set(name, next)
  if (next.turns !== before.turns || next.draft !== before.draft) persist(name, next)
  subs.forEach((f) => f())
}
export const useChat = (name: string): Chat => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => getChat(name))

export const setDraft = (name: string, draft: string) => set(name, { draft })
export const clearChat = (name: string) => set(name, { turns: [], error: "" })
export const registerAbsorb = (name: string, fn: (r: AiState) => Promise<void> | void) => { absorbers.set(name, fn); return () => { if (absorbers.get(name) === fn) absorbers.delete(name) } }

export type SendArgs = { provider: string; message: string; selected?: string; context?: AiContext }

export async function sendMessage(name: string, a: SendArgs) {
  const chat = getChat(name)
  if (chat.busy || !a.message.trim()) return
  const history = chat.turns.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 16000) }))
  // your message shows at once, with a live status under it, instead of nothing until the whole reply arrives
  set(name, { turns: [...chat.turns, { role: "user", content: a.message }], busy: true, error: "", draft: "", live: { startedAt: Date.now(), phase: "Starting", step: 0, tools: [] } })
  const controller = new AbortController()
  controllers.set(name, controller)
  const stopListening = onFeed((e) => {
    if (e.type !== "ai" || e.design !== name) return
    const live = getChat(name).live
    if (!live) return
    if (e.phase === "model") set(name, { live: { ...live, phase: e.summary ?? "Waiting for the model", step: (e.step ?? 0) + 1 } })
    else if (e.phase === "tool") set(name, { live: { ...live, phase: `Ran ${e.tool}`, tools: [...live.tools, { tool: e.tool ?? "tool", ok: e.ok !== false, summary: e.summary ?? "" }].slice(-6) } })
  })
  try {
    const r: AiReply = await aiApi.ask(name, a.provider, a.message, a.selected, history, a.context, controller.signal)
    set(name, { turns: [...getChat(name).turns, { role: "assistant", content: r.message, result: r }] })
    await absorbers.get(name)?.(r)
  } catch (e: any) {
    const state: AiState | undefined = e?.state
    if (e?.name === "AbortError") {
      set(name, { turns: [...getChat(name).turns, { role: "assistant", content: "Stopped.", failed: true }] })
    } else if (state?.trail?.length) {
      // a request that failed part-way may already have edited the draft: keep its steps on screen
      set(name, { turns: [...getChat(name).turns, { role: "assistant", content: `Stopped: ${e.message}`, result: state, failed: true }], error: e.message })
      try { await absorbers.get(name)?.(state) } catch { /* the steps are still shown */ }
    } else {
      // nothing happened: take the optimistic message back out and give the text back to the box
      const turns = getChat(name).turns
      set(name, { turns: turns.length && turns[turns.length - 1].role === "user" ? turns.slice(0, -1) : turns, draft: a.message, error: e?.message ?? "Request failed" })
    }
  } finally {
    stopListening()
    controllers.delete(name)
    set(name, { busy: false, live: null })
  }
}

/** Stop button: tell the API to abort the provider call; if it cannot be reached, drop the connection (the API stops on that too). */
export async function stopRequest(name: string) {
  try { await aiApi.cancel(name) } catch { controllers.get(name)?.abort() }
}
