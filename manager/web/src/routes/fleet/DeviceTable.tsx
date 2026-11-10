import type { DeviceSummary } from "@shared/api";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, type MouseEvent } from "react";
import { Link } from "react-router";
import { IpModeChip } from "../../components/device/IpModeChip";
import { useDeviceUpdate } from "../../api/firmware";
import { cx } from "../../lib/cx";
import { deviceTitle, formatAgo, formatUptime } from "../../lib/format";
import { isOffline, memoryInfo, mqttInfo, type FleetSort } from "./logic";
import { FirmwareChip, HealthChip, MemoryChip, MqttChip } from "./parts";

const INTERACTIVE = "a, button, input, label, select, textarea";

interface RowProps {
  summary: DeviceSummary;
  selected: boolean;
  now: number;
  onSelect: (id: string, selected: boolean) => void;
  onOpen: (id: string) => void;
}

const Row = memo(function Row({ summary: d, selected, now, onSelect, onOpen }: RowProps) {
  const title = deviceTitle(d);
  const offline = isOffline(d);
  const update = useDeviceUpdate(d.id);
  const dash = <span className="mut">—</span>;
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    onOpen(d.id);
  };
  return (
    <motion.tr
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={cx("fleet-row", selected && "sel", offline && "is-offline")}
      data-device-id={d.id}
      onClick={open}
    >
      <td className="sel">
        <label className="check">
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(d.id, e.target.checked)} aria-label={`Select ${title}`} />
        </label>
      </td>
      <td>
        <Link className="cell-main" to={`/devices/${encodeURIComponent(d.id)}/live`} title={title}>
          {title}
        </Link>
        <span className="cell-sub" title={d.hostname || d.id}>{d.hostname || d.id}</span>
      </td>
      <td className="fleet-col-health">
        <HealthChip health={d.health} />
        {update?.running && update.progress !== null && <span className="num mut fleet-updating-pct"> {Math.round(update.progress * 100)}%</span>}
      </td>
      <td className="mono fleet-col-ip" title={d.host}>
        {d.host} <IpModeChip mode={d.ip_mode} />
      </td>
      <td className="fleet-col-fw">{d.app_version ? <FirmwareChip d={d} /> : dash}</td>
      <td className="num fleet-col-uptime">{offline || d.uptime_s === null ? "—" : formatUptime(d.uptime_s)}</td>
      <td className="num fleet-col-rssi">{offline || d.rssi === null ? "—" : `${Math.round(d.rssi)} dBm`}</td>
      <td className="fleet-col-mqtt">{!offline && mqttInfo(d) ? <MqttChip d={d} short /> : dash}</td>
      <td className="fleet-col-memory">{!offline && memoryInfo(d) ? <MemoryChip d={d} short /> : dash}</td>
      <td className="mut fleet-col-seen">{formatAgo(d.lastSeen, now)}</td>
    </motion.tr>
  );
});

interface HeadProps {
  label: string;
  sortKey: FleetSort;
  sort: FleetSort;
  onSort: (s: FleetSort) => void;
  num?: boolean;
  className?: string;
}

function SortHead({ label, sortKey, sort, onSort, num, className }: HeadProps) {
  const active = sort === sortKey;
  return (
    <th className={cx(num && "num", "fleet-th", className)} aria-sort={active ? "ascending" : "none"}>
      <button type="button" className={cx("fleet-sort", active && "on")} onClick={() => onSort(sortKey)} aria-label={`Sort by ${label}`}>
        {label}
        {active && <span aria-hidden="true"> ↓</span>}
      </button>
    </th>
  );
}

export interface DeviceTableProps {
  devices: readonly DeviceSummary[];
  selected: ReadonlySet<string>;
  sort: FleetSort;
  now: number;
  onSort: (s: FleetSort) => void;
  onSelect: (id: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onOpen: (id: string) => void;
}

export function DeviceTable({ devices, selected, sort, now, onSort, onSelect, onSelectAll, onOpen }: DeviceTableProps) {
  const all = devices.length > 0 && devices.every((d) => selected.has(d.id));
  const some = !all && devices.some((d) => selected.has(d.id));
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some;
  }, [some]);

  return (
    <div className="table-wrap fleet-table-wrap">
      <table className="table fleet-table">
        <thead>
          <tr>
            <th className="sel">
              <label className="check">
                <input ref={box} type="checkbox" checked={all} onChange={(e) => onSelectAll(e.target.checked)} aria-label="Select all shown devices" />
              </label>
            </th>
            <SortHead label="Name" sortKey="name" sort={sort} onSort={onSort} />
            <SortHead label="Health" sortKey="health" sort={sort} onSort={onSort} className="fleet-col-health" />
            <th className="fleet-col-ip">IP</th>
            <th className="fleet-col-fw">Firmware</th>
            <SortHead label="Uptime" sortKey="uptime" sort={sort} onSort={onSort} num className="fleet-col-uptime" />
            <SortHead label="RSSI" sortKey="rssi" sort={sort} onSort={onSort} num className="fleet-col-rssi" />
            <th className="fleet-col-mqtt">MQTT</th>
            <th className="fleet-col-memory">Memory</th>
            <SortHead label="Last seen" sortKey="seen" sort={sort} onSort={onSort} className="fleet-col-seen" />
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {devices.map((d) => (
              <Row key={d.id} summary={d} selected={selected.has(d.id)} now={now} onSelect={onSelect} onOpen={onOpen} />
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}
