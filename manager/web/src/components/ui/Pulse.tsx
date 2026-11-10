import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface PulseProps {
  /** Any value; each change flashes the wrapper once (not on first render). */
  trigger: unknown;
  children: ReactNode;
  className?: string;
}

/** Briefly highlights its children when `trigger` changes (e.g. an input level). No-op under reduced motion. */
export function Pulse({ trigger, children, className }: PulseProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ backgroundColor: "var(--acc-bg)" }, { backgroundColor: "transparent" }], { duration: 700, easing: "ease-out" });
  }, [trigger]);
  return (
    <span ref={ref} className={cx("ui-pulse", className)}>
      {children}
    </span>
  );
}
