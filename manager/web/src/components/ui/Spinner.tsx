import { LoaderCircle } from "lucide-react";
import { cx } from "../../lib/cx";

export interface SpinnerProps {
  /** Pixel size, default 16. */
  size?: number;
  /** Accessible text; omit when a nearby label already says what is loading (the spinner is then decorative). */
  label?: string;
  className?: string;
}

/** Rotating loader (stops spinning under reduced motion, stays visible). */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <span className={cx("ui-spinner", className)} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <LoaderCircle width={size} height={size} aria-hidden="true" />
    </span>
  );
}
