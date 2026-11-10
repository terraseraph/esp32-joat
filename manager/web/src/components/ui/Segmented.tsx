import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useFieldContext } from "./Field";
import { Tooltip } from "./Tooltip";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Why the option is unavailable (shown as a tooltip on hover/focus when disabled). */
  hint?: string;
}

export interface SegmentedProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible name; not needed inside a `Field` (its label is used). */
  "aria-label"?: string;
  className?: string;
}

/**
 * Radio-group segmented control. Arrow keys move and select (skipping disabled options), Home/End jump.
 * Disabled options stay focusable-by-pointer for their `hint` tooltip but cannot be chosen.
 */
export function Segmented<T extends string = string>({ value, onChange, options, className, "aria-label": ariaLabel }: SegmentedProps<T>) {
  const field = useFieldContext();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selected = options.findIndex((o) => o.value === value && !o.disabled);
  const tabbable = selected >= 0 ? selected : (enabled[0] ?? -1);

  const move = (from: number, dir: 1 | -1 | "first" | "last") => {
    if (enabled.length === 0) return;
    const first = enabled[0] ?? from;
    const last = enabled[enabled.length - 1] ?? from;
    const step = typeof dir === "number" ? (enabled[(enabled.indexOf(from) + dir + enabled.length) % enabled.length] ?? from) : from;
    const target = dir === "first" ? first : dir === "last" ? last : step;
    const opt = options[target];
    if (!opt) return;
    refs.current[target]?.focus();
    onChange(opt.value);
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(i, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(i, -1);
        break;
      case "Home":
        e.preventDefault();
        move(i, "first");
        break;
      case "End":
        e.preventDefault();
        move(i, "last");
        break;
    }
  };

  return (
    <div
      className={cx("seg ui-seg", className)}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : field?.labelId}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
    >
      {options.map((o, i) => {
        const on = i === selected;
        const btn = (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.disabled || undefined}
            tabIndex={i === tabbable ? 0 : -1}
            className={cx(on && "on", o.disabled && "is-disabled")}
            onClick={() => !o.disabled && onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.label}
          </button>
        );
        return o.disabled && o.hint ? (
          <Tooltip key={o.value} label={o.hint}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
