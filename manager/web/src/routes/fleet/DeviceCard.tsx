import type { DeviceSummary } from "@shared/api";
import { CircleAlert, Clock, Download, MoreHorizontal, Power, RefreshCw, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { memo, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useDeviceUpdate } from "../../api/firmware";
import { Button, ButtonLink, Chip, Menu, ProgressBar, Spinner } from "../../components/ui";
import { cx } from "../../lib/cx";
import { deviceSubtitle, deviceTitle, formatUptime } from "../../lib/format";
import { attentionText, isOffline } from "./logic";
import { devicePageUrl, FirmwareChip, HealthChip, LinkChip, MemoryChip, MqttChip, RssiChip } from "./parts";
import type { FleetActions } from "./useFleetActions";

export interface DeviceCardProps {
  summary: DeviceSummary;
  selected: boolean;
  now: number;
  onSelect: (id: string, selected: boolean) => void;
  onOpen: (id: string) => void;
  actions: FleetActions;
}

/** Clicks on these (or anything inside them) must not open the device. */
const INTERACTIVE = "a, button, input, label, select, textarea, [role='menu'], [role='menuitem']";

export const DeviceCard = memo(function DeviceCard({ summary: d, selected, now, onSelect, onOpen, actions }: DeviceCardProps) {
  const [retrying, setRetrying] = useState(false);
  const navigate = useNavigate();
  const update = useDeviceUpdate(d.id);
  const title = deviceTitle(d);
  const offline = isOffline(d);
  const attn = attentionText(d, now);
  const busy = d.queue > 0 || d.ota.busy === true;

  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    onOpen(d.id);
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await actions.refresh([d]);
    } finally {
      setRetrying(false);
    }
  };

  const meta: string[] = [];
  if (!offline && d.uptime_s !== null) meta.push(`Uptime ${formatUptime(d.uptime_s)}`);
  if (!offline && d.io_count !== null) meta.push(`${d.io_count} I/O`);
  if (!offline && d.module_count) meta.push(`${d.module_count} ${d.module_count === 1 ? "add-on" : "add-ons"}`);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      className={cx("card dev fleet-card", selected && "sel", offline && "is-offline")}
      data-device-id={d.id}
      onClick={open}
    >
      <div className="dev-top">
        <label className="check sel-box">
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(d.id, e.target.checked)} aria-label={`Select ${title}`} />
        </label>
        <div className="dev-id">
          <h3 className="dev-name">
            <Link to={`/devices/${encodeURIComponent(d.id)}/live`} className="fleet-title-link">
              {title}
            </Link>
          </h3>
          <div className="mono mut">{deviceSubtitle(d)}</div>
        </div>
        <HealthChip health={d.health} />
      </div>

      <p className={cx("attn", attn.tone)}>
        {attn.icon === "alert" && <CircleAlert className="i sm" aria-hidden="true" />}
        {attn.icon === "clock" && <Clock className="i sm" aria-hidden="true" />}
        <span>{attn.text}</span>
      </p>

      {update?.running && (
        <div className="fleet-updating" role="status">
          <span className="mut">{update.message ?? "Updating firmware"}</span>
          <ProgressBar
            value={Math.round((update.progress ?? 0) * 100)}
            indeterminate={update.progress === null}
            label={`${title} firmware update`}
          />
        </div>
      )}

      <div className="chips">
        {offline ? (
          <>
            <FirmwareChip d={d} />
            <Chip>Cached values</Chip>
          </>
        ) : (
          <>
            <RssiChip rssi={d.rssi} />
            <MqttChip d={d} />
            <MemoryChip d={d} />
            <FirmwareChip d={d} />
            <LinkChip link={d.link} />
          </>
        )}
        {busy && <Chip tone="acc" title="The Manager is talking to this device, new requests wait their turn">Busy{d.queue > 1 ? ` · ${d.queue} queued` : ""}</Chip>}
      </div>

      {meta.length > 0 && (
        <div className="dev-meta mut">
          {meta.map((m) => (
            <span key={m} className="num">
              {m}
            </span>
          ))}
        </div>
      )}

      <div className="dev-actions" onClick={(e) => e.stopPropagation()}>
        <ButtonLink to={`/devices/${encodeURIComponent(d.id)}/live`} variant="primary" size="sm">
          Open
        </ButtonLink>
        <ButtonLink href={devicePageUrl(d.host)} size="sm" aria-label={`Open device page for ${title}`}>
          Open device page ↗
        </ButtonLink>
        {offline && (
          <Button size="sm" onClick={() => void retry()} disabled={retrying} aria-busy={retrying || undefined}>
            {retrying ? <Spinner size={14} /> : <RefreshCw className="i sm" aria-hidden="true" />}
            Retry
          </Button>
        )}
        <span className="spacer" />
        <Menu
          trigger={
            <Button size="sm" variant="ghost" iconOnly aria-label={`More actions for ${title}`}>
              <MoreHorizontal className="i" aria-hidden="true" />
            </Button>
          }
          items={[
            { label: "Refresh", icon: RefreshCw, onSelect: () => void actions.refresh([d]) },
            { label: "Reboot", icon: Power, onSelect: () => void actions.reboot([d]), disabled: offline },
            { label: "Update firmware…", icon: Download, onSelect: () => navigate(`/firmware?devices=${encodeURIComponent(d.id)}`), disabled: offline },
            "separator",
            { label: "Forget", icon: Trash2, tone: "danger", onSelect: () => void actions.forget([d]) },
          ]}
        />
      </div>
    </motion.article>
  );
});
