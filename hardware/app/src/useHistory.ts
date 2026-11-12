import { useCallback, useRef, useState } from "react"

export type Files = Record<string, string>
type Entry = { files: Files; key: string | null; t: number }
const MAX = 200
const COALESCE_MS = 1000

/**
 * Undo/redo stack over a design's whole file set. Every edit source (code editor, a future property
 * panel, snapshot restore, Claude-driven changes) goes through `push`; entries are whole file maps
 * (strings are shared, so this is cheap). Edits with the same `key` inside COALESCE_MS merge into one
 * step, so typing in the editor undoes by burst rather than by keystroke.
 */
export function useHistory(initial: Files = {}) {
  const ref = useRef<{ stack: Entry[]; i: number }>({ stack: [{ files: initial, key: null, t: 0 }], i: 0 })
  const [files, setFiles] = useState<Files>(initial)
  const [, bump] = useState(0)

  const publish = () => { setFiles(ref.current.stack[ref.current.i].files); bump((n) => n + 1) }

  /** Replace the whole history (e.g. after loading a design). */
  const reset = useCallback((f: Files) => { ref.current = { stack: [{ files: f, key: null, t: 0 }], i: 0 }; publish() }, [])

  const push = useCallback((update: (f: Files) => Files, opts?: { key?: string }) => {
    const h = ref.current
    const cur = h.stack[h.i]
    const next = update(cur.files)
    const same = Object.keys(next).length === Object.keys(cur.files).length && Object.keys(next).every((k) => next[k] === cur.files[k])
    if (same) return
    const now = Date.now()
    const key = opts?.key ?? null
    const merge = key !== null && cur.key === key && now - cur.t < COALESCE_MS && h.i > 0
    h.stack = h.stack.slice(0, h.i + 1)
    if (merge) h.stack[h.i] = { files: next, key, t: now }
    else { h.stack.push({ files: next, key, t: now }); if (h.stack.length > MAX) h.stack.shift(); h.i = h.stack.length - 1 }
    publish()
  }, [])

  const undo = useCallback(() => { const h = ref.current; if (h.i > 0) { h.i--; h.stack[h.i] = { ...h.stack[h.i], key: null }; publish() } }, [])
  const redo = useCallback(() => { const h = ref.current; if (h.i < h.stack.length - 1) { h.i++; publish() } }, [])

  return { files, push, reset, undo, redo, canUndo: ref.current.i > 0, canRedo: ref.current.i < ref.current.stack.length - 1 }
}
