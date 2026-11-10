import * as RT from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface TabItem {
  value: string;
  label: string;
  icon?: LucideIcon;
  /** Small count after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  /** Controlled value (use with `onValueChange`), or give `defaultValue`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  items: TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  /** `TabPanel`s. */
  children?: ReactNode;
  className?: string;
}

/** In-page tabs (not routes) with a sliding active indicator. Arrow keys move between tabs. */
export function Tabs({ value, defaultValue, onValueChange, items, label, children, className }: TabsProps) {
  const group = useId();
  const [inner, setInner] = useState(defaultValue ?? items[0]?.value);
  const current = value ?? inner;
  return (
    <RT.Root
      value={current}
      onValueChange={(v) => {
        setInner(v);
        onValueChange?.(v);
      }}
      className={cx("ui-tabs", className)}
    >
      <RT.List className="ui-tabs-list" aria-label={label}>
        {items.map((it) => {
          const Icon = it.icon;
          const active = current === it.value;
          return (
            <RT.Trigger key={it.value} value={it.value} disabled={it.disabled} className="ui-tab">
              {Icon && <Icon className="i sm" aria-hidden="true" />}
              {it.label}
              {it.badge !== undefined && <span className="badge">{it.badge}</span>}
              {active && <motion.span layoutId={`${group}-ind`} className="ui-tab-ind" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
            </RT.Trigger>
          );
        })}
      </RT.List>
      {children}
    </RT.Root>
  );
}

/** Content for one tab; only the active panel is mounted. */
export function TabPanel({ value, children, className }: { value: string; children?: ReactNode; className?: string }) {
  return (
    <RT.Content value={value} className={cx("ui-tab-panel", className)}>
      {children}
    </RT.Content>
  );
}
