import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";

export type Tone = "ok" | "warn" | "bad" | "off" | "acc";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic colour with a leading dot; omit for a neutral chip. */
  tone?: Tone;
  mono?: boolean;
  /** Leading icon (14px); use when the meaning is not a status. */
  icon?: LucideIcon;
}

export function Chip({ tone, mono, icon: Icon, className, children, ...rest }: ChipProps) {
  return (
    <span className={cx("chip", tone, mono && "mono", className)} {...rest}>
      {Icon && <Icon className="i" aria-hidden="true" />}
      {children}
    </span>
  );
}
