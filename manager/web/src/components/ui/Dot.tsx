import { cx } from "../../lib/cx";

/** Small status dot; decorative (put the meaning in nearby text). */
export function Dot({ tone, className }: { tone?: "ok" | "warn" | "bad"; className?: string }) {
  return <span className={cx("dot", tone, className)} aria-hidden="true" />;
}
