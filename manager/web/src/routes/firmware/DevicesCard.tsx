import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { FirmwareImage } from "../../api/firmware";
import { Card } from "../../components/ui/Card";
import { Chip } from "../../components/ui/Chip";
import { cx } from "../../lib/cx";
import { deviceSubtitle, deviceTitle } from "../../lib/format";
import { HealthChip } from "../fleet/parts";
import { matchesDeviceFilter, type DeviceFilter, type DeviceRow, type RowCounts } from "./logic";
import "./firmware.css";

const FILTERS: { value: DeviceFilter; label: string; count: (c: RowCounts) => number }[] = [
  { value: "all", label: "All", count: (c) => c.all },
  { value: "differs", label: "Differs", count: (c) => c.differs },
  { value: "same", label: "Up to date", count: (c) => c.same },
  { value: "cant", label: "Can't update", count: (c) => c.cant },
];

export interface DevicesCardProps {
  rows: readonly DeviceRow[];
  counts: RowCounts;
  target: FirmwareImage | null;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
}

/** Fleet comparison with the target: pick the devices to update. */
export function DevicesCard({ rows, counts, target, selected, onSelectedChange }: DevicesCardProps) {
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const visible = rows.filter((r) => matchesDeviceFilter(r, filter));
  const pickable = visible.filter((r) => r.elig.ok);
  const all = pickable.length > 0 && pickable.every((r) => selected.has(r.device.id));
  const some = !all && pickable.some((r) => selected.has(r.device.id));
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some;
  }, [some]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };
  const toggleAll = (on: boolean) => {
    const next = new Set(selected);
    for (const r of pickable) {
      if (on) next.add(r.device.id);
      else next.delete(r.device.id);
    }
    onSelectedChange(next);
  };
  const selectDiffering = () => onSelectedChange(new Set(rows.filter((r) => r.elig.ok && r.cls === "differs").map((r) => r.device.id)));

  return (
    <Card flush aria-labelledby="fw-dev-h">
      <div className="fw-head">
        <div className="card-head">
          <h2 id="fw-dev-h">Devices</h2>
          {target && counts.readyDiffer > 0 && (
            <button type="button" className="fw-linkbtn" onClick={selectDiffering}>
              Select all that differ
            </button>
          )}
        </div>
        <p className="fw-summary mut" role="status">
          <span>
            <strong className="t-ok">{counts.ready}</strong> can be updated
          </span>
          {target ? (
            <>
              <span>·</span>
              <span>
                {counts.differs} differ{counts.differs === 1 ? "s" : ""} from {target.version}
              </span>
              <span>·</span>
              <span>{counts.same} already up to date (can be reinstalled)</span>
            </>
          ) : (
            <>
              <span>·</span>
              <span>Choose a target firmware above to compare</span>
            </>
          )}
          <span>·</span>
          <span>{counts.cant} can't be updated right now</span>
        </p>
      </div>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter devices">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" className={cx("filter-chip", filter === f.value && "on")} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
              <span className="count">{f.count(counts)}</span>
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="mut" style={{ padding: "var(--s4) var(--s5)" }}>
          {rows.length === 0 ? "No devices yet. Add devices from Discover." : "No devices in this group."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table fw-table">
            <thead>
              <tr>
                <th className="sel">
                  <label className="check">
                    <input ref={box} type="checkbox" checked={all} disabled={pickable.length === 0} onChange={(e) => toggleAll(e.target.checked)} aria-label="Select all updatable devices shown" />
                  </label>
                </th>
                <th>Device</th>
                <th>Current</th>
                <th className="fw-col-status">Status</th>
                <th>Eligibility</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ device: d, cls, elig }) => {
                const title = deviceTitle(d);
                return (
                  <tr key={d.id} className={cx(!elig.ok && "cant", selected.has(d.id) && "sel")} data-device-id={d.id}>
                    <td className="sel">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={elig.ok && selected.has(d.id)}
                          disabled={!elig.ok}
                          onChange={(e) => toggle(d.id, e.target.checked)}
                          aria-label={elig.ok ? `Select ${title}` : `${title} can't be updated: ${elig.note.toLowerCase()}`}
                        />
                      </label>
                    </td>
                    <td>
                      <Link className="cell-main" to={`/devices/${encodeURIComponent(d.id)}/system`}>
                        {title}
                      </Link>
                      <span className="cell-sub">{deviceSubtitle(d)}</span>
                    </td>
                    <td>
                      <span className="ver">
                        {d.app_version ? (
                          <Chip mono tone={cls === "differs" ? "warn" : undefined}>
                            {d.app_version}
                          </Chip>
                        ) : (
                          <span className="mut">-</span>
                        )}
                        {cls === "differs" && <span className="t-warn strong" style={{ fontSize: "var(--fs-sm)" }}>Differs</span>}
                        {cls === "same" && <span className="mut" style={{ fontSize: "var(--fs-sm)" }}>Up to date</span>}
                      </span>
                    </td>
                    <td className="fw-col-status">
                      <HealthChip health={d.health} />
                    </td>
                    <td className={cx("elig", elig.tone === "ok" && "t-ok strong", elig.tone === "warn" && "t-warn", !elig.tone && "mut")}>{elig.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
