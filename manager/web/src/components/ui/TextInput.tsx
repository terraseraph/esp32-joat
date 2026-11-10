import { Eye, EyeOff, Search, X } from "lucide-react";
import { useState, type AriaAttributes, type InputHTMLAttributes, type Ref } from "react";
import { cx } from "../../lib/cx";
import { Button } from "./Button";
import { useFieldContext } from "./Field";

/** id / aria wiring from the enclosing `Field`; explicit props win. */
export function useControlProps(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: AriaAttributes["aria-invalid"]; "aria-labelledby"?: string }) {
  const f = useFieldContext();
  return {
    id: props.id ?? f?.id,
    "aria-describedby": props["aria-describedby"] ?? f?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (f?.invalid ? true : undefined),
    "aria-required": f?.required ? true : undefined,
    "aria-labelledby": props["aria-labelledby"],
  };
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: string;
  /** Receives the new text (not the event). */
  onChange: (value: string) => void;
  type?: "text" | "email" | "url" | "tel";
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** Single-line text field. Put it inside `<Field>` for label, hint and error wiring. */
export function TextInput({ value, onChange, mono, className, type = "text", ...rest }: TextInputProps) {
  const a11y = useControlProps(rest);
  return <input {...rest} {...a11y} type={type} className={cx("input", mono && "mono", className)} value={value} onChange={(e) => onChange(e.target.value)} />;
}

export interface PasswordInputProps extends Omit<TextInputProps, "type" | "mono" | "defaultValue"> {
  /** Default "new-password" so browsers do not autofill saved credentials into device settings. */
  autoComplete?: string;
}

/** Password field with a show/hide toggle. Never prefill it from a device (the firmware does not return secrets). */
export function PasswordInput({ value, onChange, className, autoComplete = "new-password", ...rest }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  const a11y = useControlProps(rest);
  return (
    <div className={cx("ui-affix ui-password", className)}>
      <input
        {...rest}
        {...a11y}
        type={shown ? "text" : "password"}
        className="input"
        autoComplete={autoComplete}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button variant="ghost" iconOnly size="sm" className="ui-affix-btn" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        {shown ? <EyeOff className="i sm" aria-hidden="true" /> : <Eye className="i sm" aria-hidden="true" />}
      </Button>
    </div>
  );
}

export interface SearchInputProps extends Omit<TextInputProps, "type" | "mono" | "type"> {
  /** Accessible name (there is usually no visible label). */
  "aria-label": string;
}

/** Search box with a leading icon and a clear button (Esc also clears). */
export function SearchInput({ value, onChange, className, placeholder = "Search", ...rest }: SearchInputProps) {
  return (
    <div className={cx("search", className)}>
      <Search className="i sm" aria-hidden="true" />
      <input
        {...rest}
        type="text"
        inputMode="search"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <Button variant="ghost" iconOnly size="sm" className="ui-search-clear" aria-label="Clear search" onClick={() => onChange("")}>
          <X className="i sm" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max" | "step"> {
  /** `undefined` shows an empty box. */
  value: number | undefined;
  /** Called with a finite number while typing, or `undefined` when the box is empty / not a number. Clamped to min/max on blur. */
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Suffix shown inside the box, e.g. "ms", "Hz", "%". */
  unit?: string;
  ref?: Ref<HTMLInputElement>;
}

const toText = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "" : String(n));
const parse = (s: string): number | undefined => {
  const t = s.trim();
  if (t === "" || t === "-" || t === ".") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** Numeric field with optional unit suffix. Typing is free-form; the value is clamped to min/max on blur. */
export function NumberInput({ value, onChange, min, max, step, unit, className, onBlur, ...rest }: NumberInputProps) {
  const a11y = useControlProps(rest);
  const [text, setText] = useState(toText(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (parse(text) !== value) setText(toText(value));
  }
  return (
    <div className={cx("ui-affix", className)}>
      <input
        {...rest}
        {...a11y}
        type="number"
        inputMode={step !== undefined && step < 1 ? "decimal" : "numeric"}
        className="input num"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          setSeen(n);
          onChange(n);
        }}
        onBlur={(e) => {
          const n = parse(text);
          if (n !== undefined) {
            let c = n;
            if (min !== undefined) c = Math.max(min, c);
            if (max !== undefined) c = Math.min(max, c);
            if (c !== n) {
              setText(String(c));
              setSeen(c);
              onChange(c);
            }
          }
          onBlur?.(e);
        }}
      />
      {unit && (
        <span className="ui-affix-unit mut" aria-hidden="true">
          {unit}
        </span>
      )}
    </div>
  );
}
