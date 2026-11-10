import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface KeyValueItem {
  label: ReactNode;
  /** null/undefined/"" render as a dash. */
  value: ReactNode;
  mono?: boolean;
}

/** Definition grid for info cards (`dl.kv` from the tokens). */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx("kv", className)}>
      {items.map((it, i) => (
        <div key={i} className="ui-kv-row">
          <dt>{it.label}</dt>
          <dd className={cx(it.mono && "mono")}>{it.value === null || it.value === undefined || it.value === "" ? <span className="mut">-</span> : it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
