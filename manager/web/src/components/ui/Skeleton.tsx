import type { CSSProperties } from "react";
import { cx } from "../../lib/cx";

export interface SkeletonProps {
  /** `line` 12px, `title` 20px x 55%, `block` 72px card-ish, `circle` round (size via width). */
  variant?: "line" | "title" | "block" | "circle";
  width?: number | string;
  height?: number | string;
  className?: string;
}

/** Loading placeholder with shimmer (static under reduced motion). Decorative: hidden from assistive tech. */
export function Skeleton({ variant = "line", width, height, className }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (variant === "circle") {
    style.width ??= 40;
    style.height ??= style.width;
  }
  return <span className={cx("skeleton", variant === "circle" ? "ui-skel-circle" : variant, className)} style={style} aria-hidden="true" />;
}
