import { motion } from "motion/react";
import { cx } from "../../lib/cx";

export interface ProgressBarProps {
  /** 0 to 100. Ignored when `indeterminate`. */
  value?: number;
  indeterminate?: boolean;
  tone?: "ok" | "warn" | "bad";
  /** Accessible name (what is progressing). */
  label: string;
  className?: string;
}

/** Determinate bar (width tweens) or an indeterminate sliding stripe. */
export function ProgressBar({ value = 0, indeterminate, tone, label, className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      className={cx("progress", indeterminate && "ind", tone, className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      {indeterminate ? <i /> : <motion.i initial={false} animate={{ width: `${pct}%` }} transition={{ duration: 0.3, ease: "easeOut" }} />}
    </div>
  );
}
