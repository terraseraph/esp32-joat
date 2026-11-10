import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Small text under the label. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Shows the dash state (e.g. "some rows selected"); clicking selects all. */
  indeterminate?: boolean;
  className?: string;
}

/** Native checkbox with its label (the whole row is clickable). */
export function Checkbox({ checked, onChange, label, hint, disabled, indeterminate, className }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <label className={cx("check ui-check", disabled && "is-disabled", className)}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="hint ui-check-hint">{hint}</span>}
      </span>
    </label>
  );
}
