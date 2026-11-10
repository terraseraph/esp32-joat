import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** No padding, children clip to the rounded corners (tables, lists). */
  flush?: boolean;
}

export function Card({ flush, className, ...rest }: CardProps) {
  return <section className={cx("card", flush && "flush", className)} {...rest} />;
}

export function CardHead({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-head">
      <h2>{title}</h2>
      {actions}
    </div>
  );
}
