import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect } from "react";
import { cx } from "../../lib/cx";

export interface AnimatedNumberProps {
  value: number;
  /** Text for the current (tweened) number; default rounds to an integer. */
  format?: (n: number) => string;
  className?: string;
}

const round = (n: number) => String(Math.round(n));

function Tween({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, format);
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.45, ease: "easeOut" });
    return () => controls.stop();
  }, [mv, value]);
  return <motion.span className={cx("num", className)}>{text}</motion.span>;
}

/** Numeric text that tweens between values (tabular numerals). Instant under reduced motion. */
export function AnimatedNumber({ value, format = round, className }: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={cx("num", className)}>{format(value)}</span>;
  return <Tween value={value} format={format} className={className} />;
}
