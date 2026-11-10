import type { DeviceSummary } from "@shared/api";
import { Zap } from "lucide-react";
import { attentionLabel, healthLabel, healthTone, linkLabel } from "../../lib/format";
import { Chip } from "../ui/Chip";
import { Spinner } from "../ui/Spinner";
import { Tooltip } from "../ui/Tooltip";
import "./deviceShell.css";

/** Status chips of the device header: health, link, needs attention, busy, firmware. */
export function DeviceChips({ summary: s }: { summary: DeviceSummary }) {
  return (
    <>
      <Chip tone={healthTone(s.health)} aria-label={`Health: ${healthLabel(s.health)}`}>
        {s.health === "rebooting" && <Spinner size={12} />}
        {healthLabel(s.health)}
      </Chip>
      {s.link !== "closed" && <Chip tone={s.link === "open" ? "ok" : "off"}>{linkLabel(s.link)}</Chip>}
      {s.attention.length > 0 && (
        <Tooltip
          label={
            <ul className="dev-attn-list">
              {s.attention.map((a) => (
                <li key={a}>{attentionLabel(a)}</li>
              ))}
            </ul>
          }
        >
          <Chip tone="warn" className="dev-attn" tabIndex={0}>
            Needs attention
          </Chip>
        </Tooltip>
      )}
      {s.queue > 0 && (
        <Chip tone="acc" icon={Zap} title="The Manager is talking to this device">
          Busy
        </Chip>
      )}
      {s.app_version && (
        <Chip mono title="Firmware version">
          {s.app_version}
        </Chip>
      )}
    </>
  );
}
