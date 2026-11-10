import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref, SelectHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { useControlProps } from "./TextInput";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "children"> {
  value: string;
  /** Receives the chosen value. */
  onChange: (value: string) => void;
  /** Either `options` or `<option>` children. */
  options?: SelectOption[];
  children?: ReactNode;
  ref?: Ref<HTMLSelectElement>;
}

/** Native `<select>` with the house look (native popup: best keyboard and touch behaviour). */
export function Select({ value, onChange, options, children, className, ...rest }: SelectProps) {
  const a11y = useControlProps(rest);
  return (
    <div className={cx("ui-select", className)}>
      <select {...rest} {...a11y} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="i sm ui-select-chev" aria-hidden="true" />
    </div>
  );
}
