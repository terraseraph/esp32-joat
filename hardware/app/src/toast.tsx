import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

type Toast = { id: number; kind: "ok" | "err" | "info"; text: string }
const Ctx = createContext<(kind: Toast["kind"], text: string) => void>(() => {})
export const useToast = () => useContext(Ctx)

let seq = 0
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq
    setItems((l) => [...l.slice(-3), { id, kind, text }])
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === "err" ? 6000 : 3000)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              className={`toast ${t.kind}`}
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
              transition={{ type: "spring", visualDuration: 0.25, bounce: 0.1 }}
              onClick={() => setItems((l) => l.filter((x) => x.id !== t.id))}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  )
}
