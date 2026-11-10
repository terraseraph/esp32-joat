import * as RS from "@radix-ui/react-slider";
import { cx } from "../../lib/cx";
import { useFieldContext } from "./Field";

export interface SliderProps {
  value: number;
  /** Fires continuously while dragging / on every key step. Use for the local display. */
  onChange: (value: number) => void;
  /** Fires once when the drag is released or a key step lands. Send the command to the device here. */
  onCommit?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Text of the value shown at the right, e.g. `(v) => `${Math.round(v / 10)}%``. Default is the raw number. */
  format?: (value: number) => string;
  /** Accessible name; not needed inside a `Field`. */
  "aria-label"?: string;
  /** Hide the value text (when the screen shows it elsewhere). */
  hideValue?: boolean;
  className?: string;
}

/** Single-thumb slider (Radix). Keyboard: arrows, PageUp/Down, Home/End; each key step also commits. */
export function Slider({ value, onChange, onCommit, min, max, step = 1, disabled, format, hideValue, className, "aria-label": ariaLabel }: SliderProps) {
  const field = useFieldContext();
  const text = format ? format(value) : String(value);
  return (
    <div className={cx("ui-slider", disabled && "is-disabled", className)}>
      <RS.Root
        className="ui-slider-root"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(v[0] ?? value)}
        onValueCommit={(v) => onCommit?.(v[0] ?? value)}
      >
        <RS.Track className="ui-slider-track">
          <RS.Range className="ui-slider-range" />
        </RS.Track>
        <RS.Thumb
          className="ui-slider-thumb"
          id={field?.id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : field?.labelId}
          aria-describedby={field?.describedBy}
          aria-valuetext={text}
        />
      </RS.Root>
      {!hideValue && (
        <span className="ui-slider-val num" aria-hidden="true">
          {text}
        </span>
      )}
    </div>
  );
}
