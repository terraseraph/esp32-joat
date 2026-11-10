import { Download, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useDevices } from "../api/devices";
import { activeUpdateIds, startBulkUpdate, uploadFirmware, useFirmware, type FirmwareImage } from "../api/firmware";
import { useJobs } from "../api/jobs";
import { Banner } from "../components/ui/Banner";
import { Button } from "../components/ui/Button";
import { Card, CardHead } from "../components/ui/Card";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { errorMessage } from "../components/ui/InlineError";
import { PageHeader } from "../components/ui/PageHeader";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { deviceTitle } from "../lib/format";
import { DevicesCard } from "./firmware/DevicesCard";
import "./firmware/firmware.css";
import { History, JobPanel } from "./firmware/JobPanel";
import { buildRows, countRows, defaultSelection, deviceCountLabel, imageBuilt, type DeviceRow } from "./firmware/logic";
import { TargetCard } from "./firmware/TargetCard";
import { useParallelUpdates } from "./firmware/useDefaultParallel";

const PARALLEL = ["1", "2", "3", "4"].map((v) => ({ value: v, label: v }));
const FAILURES = [
  { value: "1", label: "after the first failure" },
  { value: "2", label: "after 2 failures" },
  { value: "3", label: "after 3 failures" },
];

/** Ids from `?devices=a,b` (the Fleet bulk bar sends the selected devices this way). */
function idsFromQuery(value: string | null): Set<string> | null {
  if (!value) return null;
  const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

/** `/firmware`: image library, the target, a fleet comparison, and the bulk update with live progress. */
export function FirmwarePage() {
  const toast = useToast();
  const fw = useFirmware();
  const { list: devices, loaded: devicesLoaded } = useDevices();
  const { jobs: activeJobs } = useJobs({ kind: "ota", active: true });
  const [params, setParams] = useSearchParams();
  const queryDevices = params.get("devices");
  // The selection comes from the query string, or once from the default (the devices that differ); nothing else.
  const [picked, setPicked] = useState<Set<string> | null>(() => idsFromQuery(queryDevices));
  const seeded = useRef(picked !== null);
  const lastQuery = useRef(queryDevices);
  const [concurrency, setConcurrency] = useParallelUpdates();
  const [stopAfter, setStopAfter] = useState("1");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [followed, setFollowed] = useState<string | null>(null);
  /** What the confirm dialog shows and what a confirm starts: frozen when the user clicked, so it cannot change underneath them. */
  const [plan, setPlan] = useState<{ rows: DeviceRow[]; target: FirmwareImage } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const busyIds = useMemo(() => activeUpdateIds(activeJobs), [activeJobs]);
  const rows = useMemo(() => buildRows(devices, busyIds), [devices, busyIds]);
  const counts = useMemo(() => countRows(rows), [rows]);
  const target = fw.target;

  const writeQuery = useCallback(
    (ids: ReadonlySet<string>) => {
      const value = [...ids].join(",");
      lastQuery.current = value || null;
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          if (value) next.set("devices", value);
          else next.delete("devices");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // A different `?devices=` arriving from outside (a link from the Fleet) replaces the selection.
  useEffect(() => {
    if (queryDevices === lastQuery.current) return;
    lastQuery.current = queryDevices;
    seeded.current = true;
    setPicked(idsFromQuery(queryDevices) ?? new Set());
  }, [queryDevices]);

  // The default selection (devices that differ and can be updated) is applied once per visit, when the data first arrives.
  useEffect(() => {
    if (seeded.current || !devicesLoaded || !target) return;
    seeded.current = true;
    setPicked(defaultSelection(rows));
  }, [devicesLoaded, target, rows]);

  const selected = useMemo(() => {
    const base = picked ?? new Set<string>();
    return new Set(rows.filter((r) => r.elig.ok && base.has(r.device.id)).map((r) => r.device.id));
  }, [picked, rows]);
  const choose = (next: Set<string>) => {
    seeded.current = true;
    setPicked(next);
    writeQuery(next);
  };
  const chosen = rows.filter((r) => selected.has(r.device.id));
  const reinstall = (plan?.rows ?? []).filter((r) => r.cls === "same").length;

  const goLabel = !target ? "Choose a target firmware first" : chosen.length === 0 ? "Choose devices to update" : `Update ${deviceCountLabel(chosen.length)}`;
  const goDisabled = !target || chosen.length === 0;

  const askConfirm = () => {
    if (!target) return;
    setPlan({ rows: chosen, target });
    setConfirmOpen(true);
  };

  const startBulk = async () => {
    if (!plan) return;
    const job = await startBulkUpdate({
      deviceIds: plan.rows.map((r) => r.device.id),
      firmwareId: plan.target.id,
      concurrency: Number(concurrency),
      stopOnFailures: Number(stopAfter),
      skipSame: false,
    });
    setConfirmOpen(false);
    setFollowed(job.id);
    // The job has started: nothing stays ticked (it never widens to other devices) and the URL no longer lists them.
    seeded.current = true;
    setPicked(new Set());
    writeQuery(new Set());
  };

  const quickUpload = async (files: FileList | null) => {
    const f = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    try {
      const { image, existing } = await uploadFirmware(f);
      toast({ tone: "ok", title: existing ? `${image.version} is already in your library` : `Added firmware ${image.version}`, description: image.filename });
    } catch (err) {
      toast({ tone: "bad", title: `${f.name} was not accepted`, description: errorMessage(err) });
    }
  };

  const noDevices = devicesLoaded && devices.length === 0;
  return (
    <>
      <PageHeader
        title="Firmware"
        description="Choose a target image and update devices over Wi-Fi"
        actions={
          <>
            <Button onClick={() => fileInput.current?.click()}>
              <Upload className="i" aria-hidden="true" />
              Upload .bin…
            </Button>
            <input ref={fileInput} className="sr" type="file" accept=".bin" tabIndex={-1} aria-label="Upload a firmware .bin file" onChange={(e) => void quickUpload(e.target.files)} />
          </>
        }
      />

      <div className="fw-stack">
        <TargetCard fw={fw} differing={target && devicesLoaded ? counts.differs : null} total={devices.length} />

        {noDevices ? (
          <Banner tone="info" title="No devices in your fleet yet">
            Add devices from Discover, then come back to update them.
          </Banner>
        ) : (
          <DevicesCard rows={rows} counts={counts} target={target} selected={selected} onSelectedChange={choose} />
        )}

        <Card aria-labelledby="fw-opt-h">
          <CardHead title={<span id="fw-opt-h">Options</span>} />
          <div className="fw-options">
            <div className="field">
              <label htmlFor="fw-parallel">Parallel updates</label>
              <Select id="fw-parallel" value={concurrency} onChange={setConcurrency} options={PARALLEL} />
              <div className="hint">Devices updated at the same time.</div>
            </div>
            <div className="field">
              <label htmlFor="fw-stop">When something goes wrong</label>
              <Select id="fw-stop" value={stopAfter} onChange={setStopAfter} options={FAILURES.map((f) => ({ value: f.value, label: `Pause ${f.label}` }))} />
              <div className="hint">The update waits for you instead of carrying on.</div>
            </div>
          </div>
          <div className="fw-go">
            <Button variant="primary" disabled={goDisabled} onClick={askConfirm}>
              <Download className="i" aria-hidden="true" />
              {goLabel}
            </Button>
            <span className="mut" style={{ fontSize: "var(--fs-sm)" }}>
              Devices restart during the update and are offline for about 30 seconds each.
            </span>
          </div>
        </Card>

        <JobPanel followed={followed} onFollow={setFollowed} />
        <History onView={setFollowed} />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Update ${deviceCountLabel(plan?.rows.length ?? 0)}?`}
        confirmLabel={`Update ${deviceCountLabel(plan?.rows.length ?? 0)}`}
        body={
          plan ? (
            <div className="fw-sheet">
              <ul className="fw-kvl">
                <li>
                  <span className="mut">Target firmware</span>
                  <span>
                    <span className="mono strong">{plan.target.version}</span> · built {imageBuilt(plan.target)}
                  </span>
                </li>
                <li>
                  <span className="mut">Parallel updates</span>
                  <span className="strong" data-testid="confirm-parallel">
                    {Math.min(Number(concurrency), plan.rows.length)}
                    {plan.rows.length < Number(concurrency) && <span className="mut"> (limit {concurrency}, fewer devices)</span>}
                  </span>
                </li>
                <li>
                  <span className="mut">When something goes wrong</span>
                  <span className="strong">Pause {FAILURES.find((f) => f.value === stopAfter)?.label}</span>
                </li>
              </ul>
              <ul className="fw-kvl" aria-label="Devices to update">
                {plan.rows.map((r) => (
                  <li key={r.device.id}>
                    <span className="strong">{deviceTitle(r.device)}</span>
                    <span className="mono mut">
                      {r.device.app_version ?? "unknown"} → {plan.target.version}
                    </span>
                  </li>
                ))}
              </ul>
              {reinstall > 0 && (
                <p className="hint">
                  {reinstall} {reinstall === 1 ? "device already runs" : "devices already run"} {plan.target.version} and will be reinstalled.
                </p>
              )}
            </div>
          ) : null
        }
        onConfirm={startBulk}
      />
    </>
  );
}
