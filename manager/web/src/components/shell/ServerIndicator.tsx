import { useEffect } from "react";
import { refreshHealth, useServerStatus, type ServerStatus } from "../../api/serverStatus";
import { getBrowserWs } from "../../api/ws";
import { Chip } from "../ui/Chip";
import { Dot } from "../ui/Dot";
import { Tooltip } from "../ui/Tooltip";

export function serverLabel(s: ServerStatus): string {
  if (s.connection === "connected") return "Server connected";
  if (s.connection === "disconnected") return "Server offline";
  return s.reconnecting ? "Reconnecting…" : "Connecting…";
}

function formatUptime(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)} h`;
  return `${Math.round(sec / 86400)} d`;
}

function Details({ s }: { s: ServerStatus }) {
  return (
    <div className="tip-kv">
      <strong>{serverLabel(s)}</strong>
      {s.version && <span>Version {s.version}</span>}
      {s.dataDir && <span>Data: {s.dataDir}</span>}
      {s.uptime !== null && <span>Up {formatUptime(s.uptime)}</span>}
      {s.lan && <span>LAN access is on</span>}
    </div>
  );
}

/** Connection dot + text for the nav footer, with server details in a tooltip. */
export function ServerIndicator({ tooltipSide }: { tooltipSide: "right" | "bottom" }) {
  const status = useServerStatus();
  // LAN access can be switched at runtime (Settings, or another browser): the server pushes {t:"access"}, then the badge re-reads /api/health.
  useEffect(() => getBrowserWs().subscribe("access", () => void refreshHealth()), []);
  const tone = status.connection === "connected" ? "ok" : status.connection === "disconnected" ? "bad" : "warn";
  const label = serverLabel(status);
  return (
    <>
      <Tooltip label={<Details s={status} />} side={tooltipSide}>
        <div className="srv" role="status" aria-label={label} tabIndex={0} data-connection={status.connection}>
          <Dot tone={tone} />
          <span className="lbl">{label}</span>
        </div>
      </Tooltip>
      {status.lan && (
        <Chip tone="acc" className="lan-badge" title="LAN access is on: other devices on your network can open this Manager.">
          LAN
        </Chip>
      )}
    </>
  );
}
