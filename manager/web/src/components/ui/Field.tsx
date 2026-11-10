import { CircleAlert } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface FieldContextValue {
  /** Id for the control (matches the label's `htmlFor`). */
  id: string;
  /** Id of the label element (for controls that cannot use `htmlFor`, e.g. Segmented, Slider). */
  labelId: string;
  /** Space-separated ids of the hint and error nodes that exist. */
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wiring a form control inherits from its enclosing `Field` (null outside one). */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text; also sets `aria-invalid` on the control. */
  error?: ReactNode;
  required?: boolean;
  /** Visually hide the label (it stays for screen readers). */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Label + control + hint + error. Controls rendered inside (`TextInput`, `NumberInput`, `PasswordInput`,
 * `Select`, `Segmented`, `Slider`) pick up `id`, `aria-describedby`, `aria-invalid` and `aria-required`
 * automatically; no props needed on the control itself.
 */
export function Field({ label, hint, error, required, hideLabel, children, className }: FieldProps) {
  const uid = useId();
  const id = `${uid}-ctl`;
  const labelId = `${uid}-lbl`;
  const hintId = hint ? `${uid}-hint` : undefined;
  const errId = error ? `${uid}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext value={{ id, labelId, describedBy, invalid: Boolean(error), required: Boolean(required) }}>
      <div className={cx("field", Boolean(error) && "err", className)}>
        <label id={labelId} htmlFor={id} className={cx(hideLabel && "sr")}>
          {label}
          {required && (
            <span className="ui-req" aria-hidden="true">
              {" "}
              *
            </span>
          )}
        </label>
        {children}
        {hint && (
          <div id={hintId} className="hint">
            {hint}
          </div>
        )}
        {error && (
          <div id={errId} className="msg" role="alert">
            <CircleAlert className="i sm" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </FieldContext>
  );
}
