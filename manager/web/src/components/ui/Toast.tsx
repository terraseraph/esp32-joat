import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Button } from "./Button";

export type ToastTone = "ok" | "warn" | "bad" | "info";

export interface ToastInput {
  tone: ToastTone;
  title: string;
  /** Second line; mono-friendly for device error strings (shown verbatim). */
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Override the auto-dismiss delay in ms (default 5000, 9000 for `bad`). 0 keeps it until dismissed. */
  durationMs?: number;
}

export interface ToastFn {
  (t: ToastInput): string;
  dismiss: (id: string) => void;
}

interface ToastItemData extends ToastInput {
  id: string;
}

const MAX_TOASTS = 4;
let toastSeq = 0;
const ICONS = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, info: Info } as const;

const noop: ToastFn = Object.assign(() => "", { dismiss: () => {} });
const ToastContext = createContext<ToastFn>(noop);

/** `const toast = useToast(); toast({ tone: "ok", title: "Saved" })`. Outside a provider it does nothing. */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}

function ToastItem({ toast, onDismiss }: { toast: ToastItemData; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = ICONS[toast.tone];
  const delay = toast.durationMs ?? (toast.tone === "bad" ? 9000 : 5000);
  useEffect(() => {
    if (paused || delay <= 0) return;
    const t = setTimeout(() => onDismiss(toast.id), delay);
    return () => clearTimeout(t);
  }, [paused, delay, toast.id, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 32, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className={cx("toast", toast.tone !== "info" && toast.tone)}
      role={toast.tone === "bad" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="i" aria-hidden="true" />
      <div className="txt">
        <strong>{toast.title}</strong>
        {toast.description && <div className="mut mono ui-toast-desc">{toast.description}</div>}
        {toast.action && (
          <Button
            size="sm"
            className="ui-toast-action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </Button>
        )}
      </div>
      <Button variant="ghost" iconOnly size="sm" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <X className="i sm" aria-hidden="true" />
      </Button>
    </motion.div>
  );
}

/** Mount once near the root (App does). Stacks toasts bottom-right; auto-dismiss pauses on hover/focus. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItemData[]>([]);
  
  const dismiss = useCallback((id: string) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const toast = useMemo<ToastFn>(
    () =>
      Object.assign(
        (t: ToastInput) => {
          const id = `toast-${++toastSeq}`;
          setItems((list) => [...list, { ...t, id }].slice(-MAX_TOASTS));
          return id;
        },
        { dismiss },
      ),
    [dismiss],
  );

  return (
    <ToastContext value={toast}>
      {children}
      <div className="toasts" aria-live="polite" aria-label="Notifications">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext>
  );
}
