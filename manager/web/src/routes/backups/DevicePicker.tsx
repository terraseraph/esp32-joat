import type { DeviceSummary } from "@shared/api";
import { Chip } from "../../components/ui/Chip";
import { cx } from "../../lib/cx";
import { deviceTitle, healthLabel, healthTone } from "../../lib/format";
import { deviceUsability } from "./labels";

export interface DevicePickerProps {
  devices: readonly DeviceSummary[];
  selected: ReadonlySet<string>;
  onToggle(id: string, on: boolean): void;
  /** Group label for assistive technology. */
  label: string;
  /** "radio" lets exactly one device be chosen. */
  mode?: "checkbox" | "radio";
  disabled?: boolean;
}

/** Device rows with a check box; only online devices can be picked (the others show why not). */
export function DevicePicker({ devices, selected, onToggle, label, mode = "checkbox", disabled }: DevicePickerProps) {
  return (
    <div className="stack bk-picks" role="group" aria-label={label}>
      {devices.map((d) => {
        const use = deviceUsability(d);
        const off = !use.ok || disabled;
        const title = deviceTitle(d);
        return (
          <label key={d.id} className={cx("pick", off && "dis")}>
            <input
              type={mode}
              name={mode === "radio" ? "bk-pick" : undefined}
              checked={selected.has(d.id)}
              disabled={off}
              onChange={(e) => onToggle(d.id, e.target.checked)}
              aria-label={title}
            />
            <span className="grow">
              <span className="nm">{title}</span>
              <span className="sub">
                {d.id} · {d.host}
              </span>
            </span>
            {d.safe_mode ? <Chip tone="bad">Safe mode</Chip> : <Chip tone={healthTone(d.health)}>{healthLabel(d.health)}</Chip>}
          </label>
        );
      })}
    </div>
  );
}
