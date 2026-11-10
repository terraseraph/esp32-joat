import { useMemo, useState } from "react";
import { backupDevices } from "../../api/backups";
import { useDevices } from "../../api/devices";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Chip, type Tone } from "../../components/ui/Chip";
import { Sheet } from "../../components/ui/Sheet";
import { Spinner } from "../../components/ui/Spinner";
import { deviceTitle } from "../../lib/format";
import { DevicePicker } from "./DevicePicker";
import { backupErrorMessage, countsText, deviceUsability } from "./labels";

type RowState = { state: "running" | "done" | "failed"; message: string };
const STATE_LABEL: Record<RowState["state"], string> = { running: "Working", done: "Done", failed: "Failed" };
const STATE_TONE: Record<RowState["state"], Tone> = { running: "acc", done: "ok", failed: "bad" };

/** "Back up devices…": pick online devices, read each one and save a backup. */
export function BackupNowSheet({ onClose, initialSelected }: { onClose(): void; initialSelected?: readonly string[] }) {
  const { list, loaded } = useDevices();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialSelected));
  const [rows, setRows] = useState<Record<string, RowState> | null>(null);
  const [running, setRunning] = useState(false);

  const usable = useMemo(() => list.filter((d) => deviceUsability(d).ok), [list]);
  const picked = useMemo(() => list.filter((d) => selected.has(d.id) && deviceUsability(d).ok), [list, selected]);
  const safeMode = picked.filter((d) => d.safe_mode);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const start = async () => {
    const targets = picked.map((d) => ({ id: d.id, name: deviceTitle(d) }));
    setRunning(true);
    setRows(Object.fromEntries(targets.map((t) => [t.id, { state: "running", message: "" } satisfies RowState])));
    await backupDevices(targets, (o) =>
      setRows((prev) => ({
        ...prev,
        [o.id]: o.meta ? { state: "done", message: countsText(o.meta.counts) } : { state: "failed", message: backupErrorMessage(o.error, o.name) },
      })),
    );
    setRunning(false);
  };

  const failedIds = rows ? Object.entries(rows).filter(([, r]) => r.state === "failed").map(([id]) => id) : [];
  const n = picked.length;

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Back up devices"
      width={560}
      locked={running}
      footer={
        rows === null ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={n === 0} onClick={() => void start()}>
              {n === 1 ? "Back up 1 device" : `Back up ${n} devices`}
            </Button>
          </>
        ) : (
          <>
            {failedIds.length > 0 && !running && (
              <Button
                onClick={() => {
                  setSelected(new Set(failedIds));
                  setRows(null);
                }}
              >
                Pick again
              </Button>
            )}
            <Button variant="primary" onClick={onClose} disabled={running}>
              Done
            </Button>
          </>
        )
      }
    >
      {rows === null ? (
        <>
          <p className="mut">The Manager reads each device's pins, add-ons, rules and MQTT broker and saves them on this PC. Only online devices can be picked.</p>
          {loaded && list.length === 0 ? (
            <p className="mut">No devices yet. Add one from Discover.</p>
          ) : (
            <>
              {usable.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(usable.map((d) => d.id)))}>
                  Pick all online devices
                </Button>
              )}
              <DevicePicker devices={list} selected={selected} onToggle={toggle} label="Devices to back up" />
            </>
          )}
          {safeMode.length > 0 && (
            <Banner tone="warn">
              {safeMode.map(deviceTitle).join(", ")} {safeMode.length === 1 ? "is" : "are"} in safe mode, so the I/O configuration was not applied. A backup of {safeMode.length === 1 ? "it" : "them"} will be incomplete.
            </Banner>
          )}
        </>
      ) : (
        <>
          <ul className="bk-results" aria-label="Backup progress">
            {list
              .filter((d) => rows[d.id])
              .map((d) => {
                const r = rows[d.id] as RowState;
                return (
                  <li key={d.id}>
                    <div className="bk-result-main">
                      <span className="strong">{deviceTitle(d)}</span>
                      <Chip tone={STATE_TONE[r.state]}>
                        {r.state === "running" && <Spinner size={12} />}
                        {STATE_LABEL[r.state]}
                      </Chip>
                    </div>
                    {r.message && <div className={r.state === "failed" ? "t-bad" : "mut"}>{r.message}</div>}
                  </li>
                );
              })}
          </ul>
          {!running && failedIds.length === 0 && <Banner tone="ok">Saved on this PC. They are in the backup list.</Banner>}
        </>
      )}
    </Sheet>
  );
}
