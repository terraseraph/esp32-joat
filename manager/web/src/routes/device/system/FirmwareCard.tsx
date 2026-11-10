import type { OtaProgress, OtaStatus } from "@shared/device-api";
import { Download, Undo2 } from "lucide-react";
import { animate } from "motion/react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useDeviceResource } from "../../../api/commands";
import { startRollback } from "../../../api/firmware";
import { isJobFinished, useJobs } from "../../../api/jobs";
import { Banner } from "../../../components/ui/Banner";
import { Button } from "../../../components/ui/Button";
import { Card, CardHead } from "../../../components/ui/Card";
import { Chip } from "../../../components/ui/Chip";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { InlineError } from "../../../components/ui/InlineError";
import { KeyValue } from "../../../components/ui/KeyValue";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { Sheet } from "../../../components/ui/Sheet";
import { Tooltip } from "../../../components/ui/Tooltip";
import { formatBytes } from "../../../lib/format";
import { OtaJobView } from "../../firmware/OtaJobView";
import { imageStateInfo } from "./helpers";
import { UpdateSheet } from "./UpdateSheet";

const SESSION_LABEL: Record<string, string> = {
  writing: "Receiving the new firmware",
  fetching: "Downloading the new firmware",
  rebooting: "Restarting on the new firmware",
  error: "The last update failed",
};

/** Progress of a running OTA session: the `ota/progress` event when one is running, else the status. */
export function otaProgress(ota: OtaStatus, progress: OtaProgress | null): { session: string; percent: number; bytes: number; total: number } {
  const p = progress && progress.session !== "idle" ? progress : ota;
  return { session: p.session, percent: p.percent, bytes: p.bytes, total: p.total };
}

/** A button that stays focusable and explains itself on hover when it is disabled. */
function WithReason({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip label={reason}>
      <span className="sys-tip" tabIndex={0}>
        {children}
      </span>
    </Tooltip>
  );
}

/** A whole-number percentage that eases to the new value over the same 0.3 s as the bar fill, so the label and the fill agree. */
function useEasedPercent(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const controls = animate(from.current, value, {
      duration: 0.3,
      ease: "easeOut",
      onUpdate: (v) => {
        from.current = v;
        setShown(Math.round(v));
      },
      onComplete: () => setShown(value),
    });
    return () => controls.stop();
  }, [value]);
  return shown;
}

export function FirmwareCard({ id, ota, progress, disabled }: { id: string; ota: OtaStatus | null; progress: OtaProgress | null; disabled: boolean }) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackJob, setRollbackJob] = useState<string | null>(null);
  const { jobs: otaJobs } = useJobs({ kind: "ota" });
  const mine = otaJobs.filter((j) => j.deviceIds.includes(id));
  const updating = mine.some((j) => !isJobFinished(j));
  // Jobs are newest first. Once the newest one has finished, a leftover "restarting" report is history, not progress.
  const latest = mine[0];
  const latestFinished = latest !== undefined && isJobFinished(latest);
  const finishedKey = latestFinished ? latest.id : null;

  // After a job finishes, read the device again so the version row is current (the device may still be answering the old state).
  const fresh = useDeviceResource<OtaStatus>(id, "ota");
  const seenFinished = useRef(finishedKey);
  const [override, setOverride] = useState<{ base: OtaStatus | null; ota: OtaStatus } | null>(null);
  const reloadFresh = fresh.reload;
  useEffect(() => {
    if (finishedKey === null || seenFinished.current === finishedKey) return;
    seenFinished.current = finishedKey;
    reloadFresh();
    const t = setTimeout(reloadFresh, 5000);
    const t2 = setTimeout(reloadFresh, 10_000);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [finishedKey, reloadFresh]);
  const freshData = fresh.data;
  useEffect(() => {
    if (freshData && seenFinished.current !== null && finishedKey !== null) setOverride((o) => (o && o.ota === freshData ? o : { base: ota, ota: freshData }));
  }, [freshData, finishedKey, ota]);
  const current = override && override.base === ota ? override.ota : ota;
  const percentShown = useEasedPercent(current ? otaProgress(current, progress).percent : 0);

  if (!current) {
    return (
      <Card aria-labelledby="sys-fw-h">
        <CardHead title={<span id="sys-fw-h">Firmware</span>} />
        <p className="mut">No firmware information yet.</p>
      </Card>
    );
  }
  const state = imageStateInfo(current.image_state);
  const run = otaProgress(current, progress);
  const active = run.session !== "idle" && run.session !== "error" && !(latestFinished && !updating);
  const pending = current.image_state === "pending_verify";
  const updateReason = updating
    ? null
    : disabled
      ? "The device can't be reached right now."
      : pending
        ? "Wait until the device has finished verifying its current firmware."
        : current.busy
          ? "The device is busy with another update."
          : null;
  const rollbackReason = updating
    ? "Wait for the running update to finish."
    : disabled
      ? "The device can't be reached right now."
      : !current.rollback_possible
        ? "There is no previous firmware on this device to go back to."
        : null;
  return (
    <Card aria-labelledby="sys-fw-h" className={disabled ? "sys-off" : undefined}>
      <CardHead title={<span id="sys-fw-h">Firmware</span>} />
      {active && (
        <div className="stack" style={{ gap: "var(--s2)", marginBottom: "var(--s4)" }}>
          <div className="row">
            <strong>{SESSION_LABEL[run.session] ?? run.session}</strong>
            <span className="spacer" />
            <span className="mut num">
              {percentShown}%{run.total > 0 ? ` · ${formatBytes(run.bytes)} of ${formatBytes(run.total)}` : ""}
            </span>
          </div>
          <ProgressBar value={run.percent} label="Update progress" />
        </div>
      )}
      {current.last_error && <InlineError message={current.last_error} className="field-gap" />}
      <KeyValue
        items={[
          { label: "Version", value: <span className="mono">{current.app_version}</span> },
          { label: "Built", value: `${current.compile_date} ${current.compile_time}` },
          { label: "ESP-IDF", value: current.idf, mono: true },
          {
            label: "Runtime",
            value: (
              <>
                {current.fw}
                <div className="hint">Constant in this firmware; not used for comparison.</div>
              </>
            ),
          },
          {
            label: "Running slot",
            value: (
              <>
                <span className="mono">{current.running_partition}</span> <Chip tone={state.tone}>{state.label}</Chip>
              </>
            ),
          },
          { label: "Next slot", value: <span className="mono">{current.next_partition || "-"}</span> },
          { label: "Rollback possible", value: current.rollback_possible ? `Yes (${current.next_partition})` : "No" },
          ...(current.incoming_version ? [{ label: "Incoming version", value: <span className="mono">{current.incoming_version}</span> }] : []),
        ]}
      />
      {current.image_state === "pending_verify" && (
        <Banner tone="warn" title="This firmware is still being checked" className="kv-after">
          It becomes permanent once it has run without problems. If the device restarts before then, it goes back to the previous firmware.
        </Banner>
      )}
      <div className="sub">
        <h3>Update</h3>
        <div className="btns">
          <WithReason reason={updateReason}>
            <Button variant="primary" disabled={updateReason !== null} onClick={() => setUpdateOpen(true)}>
              <Download className="i" aria-hidden="true" />
              {updating ? "View update" : "Update…"}
            </Button>
          </WithReason>
          <WithReason reason={rollbackReason}>
            <Button disabled={rollbackReason !== null} onClick={() => setRollbackOpen(true)}>
              <Undo2 className="i" aria-hidden="true" />
              Roll back…
            </Button>
          </WithReason>
        </div>
        <p className="hint">
          {rollbackReason && current.rollback_possible === false
            ? "Roll back is available after an update: the device keeps the firmware it ran before."
            : "Install a firmware image from the Manager's library, or go back to the firmware the device ran before."}
        </p>
      </div>
      <UpdateSheet deviceId={id} open={updateOpen} onOpenChange={setUpdateOpen} />
      <ConfirmDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="Roll back to the previous firmware?"
        tone="danger"
        confirmLabel="Roll back"
        body={
          <>
            <p>
              The device switches back to the firmware it ran before the last update and restarts. It is offline for about 30 seconds.
            </p>
            <p className="hint">Its settings, pins, add-ons and rules are kept. The Manager checks that it comes back on the older firmware.</p>
          </>
        }
        onConfirm={async () => {
          const job = await startRollback(id);
          setRollbackJob(job.id);
        }}
      />
      <Sheet
        open={rollbackJob !== null}
        onOpenChange={(o) => {
          if (!o) setRollbackJob(null);
        }}
        title="Rolling back"
        width={520}
        footer={<Button onClick={() => setRollbackJob(null)}>Close</Button>}
      >
        {rollbackJob && <OtaJobView jobId={rollbackJob} />}
      </Sheet>
    </Card>
  );
}
