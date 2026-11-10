import type { BootState } from "@shared/device-api";
import { Card, CardHead } from "../../../components/ui/Card";
import { Chip } from "../../../components/ui/Chip";
import { KeyValue } from "../../../components/ui/KeyValue";
import { formatUptime } from "../../../lib/format";
import { bootStateLabel, bootStateTone, resetReasonLabel, resetReasonTone } from "./helpers";
import { useTickingUptime } from "./useSystemData";

export interface UptimeCardProps {
  uptime_s: number | null;
  boot_count: number | null;
  reset_reason: number | null;
  boot_state: BootState | null;
  safe_mode: boolean | null;
  safe_reason: string;
  disabled: boolean;
}

export function UptimeCard({ uptime_s, boot_count, reset_reason, boot_state, safe_mode, safe_reason, disabled }: UptimeCardProps) {
  const uptime = useTickingUptime(disabled ? null : uptime_s);
  const resetTone = resetReasonTone(reset_reason);
  return (
    <Card aria-labelledby="sys-up-h" className={disabled ? "sys-off" : undefined}>
      <CardHead title={<span id="sys-up-h">Uptime &amp; resets</span>} />
      <KeyValue
        items={[
          { label: "Uptime", value: uptime === null ? "" : formatUptime(uptime) },
          { label: "Boot count", value: boot_count === null ? "" : String(boot_count) },
          { label: "Last reset", value: reset_reason === null ? "" : resetTone ? <span className="t-warn strong">{resetReasonLabel(reset_reason)}</span> : resetReasonLabel(reset_reason) },
          { label: "Boot state", value: boot_state ? <Chip tone={bootStateTone(boot_state)}>{bootStateLabel(boot_state)}</Chip> : "" },
          { label: "Safe mode", value: safe_mode === null ? "" : safe_mode ? <span className="t-bad strong">On{safe_reason ? `: ${safe_reason}` : ""}</span> : "Off" },
        ]}
      />
    </Card>
  );
}
