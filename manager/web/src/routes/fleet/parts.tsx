import type { DeviceSummary } from "@shared/api";
import { Chip, Spinner } from "../../components/ui";
import { formatBytes, formatRssi, healthLabel, healthTone, linkLabel } from "../../lib/format";
import { memoryInfo, mqttInfo } from "./logic";

/** Four ascending bars; `bars` of them are filled. */
export function SignalBars({ bars }: { bars: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <svg className="i fleet-signal" viewBox="0 0 16 16" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={1 + i * 4} y={12 - i * 3.5} width="2.5" height={3 + i * 3.5} rx="0.8" className={i < bars ? "on" : undefined} />
      ))}
    </svg>
  );
}

export function HealthChip({ health }: { health: DeviceSummary["health"] }) {
  if (health === "rebooting" || health === "updating") {
    return (
      <Chip tone="acc">
        <Spinner size={12} />
        {healthLabel(health)}
      </Chip>
    );
  }
  return <Chip tone={healthTone(health)}>{healthLabel(health)}</Chip>;
}

export function RssiChip({ rssi }: { rssi: number | null }) {
  if (rssi === null) return null;
  const r = formatRssi(rssi);
  return (
    <Chip title={r.label}>
      <SignalBars bars={r.bars} />
      {Math.round(rssi)} dBm
    </Chip>
  );
}

export function MqttChip({ d, short }: { d: DeviceSummary; short?: boolean }) {
  const m = mqttInfo(d);
  if (!m) return null;
  return <Chip tone={m.tone}>{short ? m.label : `MQTT ${m.label}`}</Chip>;
}

export function MemoryChip({ d, short }: { d: DeviceSummary; short?: boolean }) {
  const m = memoryInfo(d);
  if (!m) return null;
  const free = d.memory.free !== null ? ` · ${formatBytes(d.memory.free)}${short ? "" : " free"}` : "";
  return (
    <Chip tone={m.tone} title={d.memory.total !== null ? `${formatBytes(d.memory.free)} free of ${formatBytes(d.memory.total)}` : undefined}>
      {short ? "" : "Memory "}
      {m.label}
      {free}
    </Chip>
  );
}

export function LinkChip({ link }: { link: DeviceSummary["link"] }) {
  if (link === "closed") return null;
  return <Chip tone={link === "open" ? "ok" : link === "full" ? "warn" : "acc"}>{linkLabel(link)}</Chip>;
}

export function FirmwareChip({ d }: { d: DeviceSummary }) {
  if (!d.app_version) return null;
  const differs = d.fwMatchesTarget === false;
  return (
    <Chip mono tone={differs ? "warn" : undefined}>
      {d.app_version}
      {differs && " · differs"}
    </Chip>
  );
}

/** The address a user can open in a new tab (the Manager itself never calls it from the browser). */
export const devicePageUrl = (host: string) => `http://${host}/`;
