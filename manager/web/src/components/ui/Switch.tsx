import * as RS from "@radix-ui/react-switch";
import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label to the right. Without it pass `aria-label`. */
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

/** Toggle (Radix Switch, `role="switch"`), optionally with a clickable label and hint. */
export function Switch({ checked, onCheckedChange, label, hint, disabled, className, "aria-label": ariaLabel }: SwitchProps) {
  const id = useId();
  const control = <RS.Root id={id} className="switch" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label ? undefined : ariaLabel} />;
  if (!label) return control;
  return (
    <div className={cx("ui-switch-row", disabled && "is-disabled", className)}>
      {control}
      <label htmlFor={id} className="ui-switch-label">
        {label}
        {hint && <span className="hint ui-check-hint">{hint}</span>}
      </label>
    </div>
  );
}
