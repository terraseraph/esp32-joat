import type { Job, JobAction } from "@shared/api";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { applyRestore, planRestore, useBackups, type BackupApplyResult, type BackupInclude, type BackupMeta, type BackupPlan, type PlanRequest, type PlanSource } from "../../api/backups";
import { useDevices } from "../../api/devices";
import { runJobAction, useJob } from "../../api/jobs";
import { JobProgress } from "../../components/jobs/JobProgress";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { errorMessage, InlineError } from "../../components/ui/InlineError";
import { Select } from "../../components/ui/Select";
import { Sheet } from "../../components/ui/Sheet";
import { Spinner } from "../../components/ui/Spinner";
import { cx } from "../../lib/cx";
import { deviceTitle } from "../../lib/format";
import { DevicePicker } from "./DevicePicker";
import { PlanView, planHasWork } from "./PlanView";
import { defaultInclude, deviceUsability, formatTaken, notIncluded, stepSummaryText } from "./labels";

export type WizardStart = { mode: "restore"; backup: BackupMeta } | { mode: "clone" };

type Step = "source" | "targets" | "copy" | "review" | "apply";

const backupLabel = (b: BackupMeta) => `${b.name || b.source.name} · ${formatTaken(b.createdAt)}`;

function asResult(value: unknown): BackupApplyResult | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Partial<BackupApplyResult>;
  return typeof r.applied === "number" && typeof r.total === "number" ? { applied: r.applied, total: r.total, failedStep: r.failedStep } : null;
}

/** What happened on each target in words: "Greenhouse was only partly updated." */
function Outcome({ job, plans }: { job: Job; plans: BackupPlan[] | null }) {
  if (job.state !== "succeeded" && job.state !== "partial" && job.state !== "failed") return null;
  const rows = job.devices.map((d) => ({ d, r: asResult(d.result) }));
  const partly = rows.filter(({ d, r }) => d.state === "failed" && r && r.applied > 0);
  const untouched = rows.filter(({ d, r }) => d.state === "failed" && !(r && r.applied > 0));
  const done = rows.filter(({ d }) => d.state === "done").length;
  const stepSummary = (deviceId: string, stepId: string | undefined) => plans?.find((p) => p.targetId === deviceId)?.steps.find((s) => s.id === stepId)?.summary;
  return (
    <>
      {partly.length > 0 && (
        <Banner tone="warn" title={`${partly.map(({ d }) => d.name || d.deviceId).join(", ")} ${partly.length === 1 ? "was" : "were"} only partly updated.`}>
          {done} of {rows.length} {rows.length === 1 ? "device" : "devices"} finished. Devices don't support all-or-nothing changes, so a failure leaves a device partly updated. You can run the restore again.
        </Banner>
      )}
      {untouched.length > 0 && partly.length === 0 && (
        <Banner tone="bad" title={`${untouched.map(({ d }) => d.name || d.deviceId).join(", ")} ${untouched.length === 1 ? "was" : "were"} not changed.`}>
          {done} of {rows.length} {rows.length === 1 ? "device" : "devices"} finished.
        </Banner>
      )}
      <ul className="bk-results" aria-label="Steps applied">
        {rows.map(({ d, r }) =>
          r ? (
            <li key={d.deviceId}>
              <span className="strong">{d.name || d.deviceId}</span>
              <span className="mut">
                : {r.applied} of {r.total} {r.total === 1 ? "step" : "steps"} applied
              </span>
              {r.failedStep && <div className="t-bad">Stopped at: {stepSummaryText(stepSummary(d.deviceId, r.failedStep) ?? r.failedStep)}</div>}
            </li>
          ) : null,
        )}
      </ul>
    </>
  );
}

function ApplyStep({ jobId, onJob, plans, onRerun, rerunning, rerunError }: { jobId: string; onJob(id: string): void; plans: BackupPlan[] | null; onRerun(ids: string[]): void; rerunning: boolean; rerunError: string | null }) {
  const { job, loading, error } = useJob(jobId);
  const [actionError, setActionError] = useState<string | null>(null);
  if (!job) return error ? <InlineError message={error.message} /> : loading ? <Spinner label="Loading" /> : null;

  const onAction = async (action: JobAction) => {
    setActionError(null);
    try {
      const next = await runJobAction(job.id, action);
      if (next.id !== job.id) onJob(next.id); // a retry is a new job
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };
  const failed = job.devices.filter((d) => d.state === "failed").map((d) => d.deviceId);
  const finished = job.state === "succeeded" || job.state === "failed" || job.state === "partial" || job.state === "cancelled" || job.state === "interrupted";
  return (
    <div className="stack">
      <JobProgress job={job} onAction={onAction} />
      {actionError && <InlineError message={actionError} />}
      <Outcome job={job} plans={plans} />
      {finished && failed.length > 0 && (
        <div>
          <Button onClick={() => onRerun(failed)} disabled={rerunning} aria-busy={rerunning || undefined}>
            <RefreshCw className="i sm" aria-hidden="true" />
            {failed.length === 1 ? "Run again for the device that failed" : `Run again for the ${failed.length} devices that failed`}
          </Button>
        </div>
      )}
      {rerunError && <InlineError message={rerunError} />}
    </div>
  );
}

/** Restore a saved backup, or clone a device: Source → Targets → What to copy → Review plan → Apply. */
export function BackupWizard({ start, onClose }: { start: WizardStart; onClose(): void }) {
  const clone = start.mode === "clone";
  const { list: devices } = useDevices();
  const { list: backups } = useBackups();

  const steps = useMemo<{ key: Step; label: string }[]>(
    () => [...(clone ? [{ key: "source" as const, label: "Source" }] : []), { key: "targets", label: "Targets" }, { key: "copy", label: "What to copy" }, { key: "review", label: "Review plan" }, { key: "apply", label: "Apply" }],
    [clone],
  );
  const [step, setStep] = useState<Step>(steps[0]?.key ?? "targets");

  const usable = useMemo(() => devices.filter((d) => deviceUsability(d).ok), [devices]);
  const [sourceKind, setSourceKind] = useState<"device" | "backup">("device");
  const [pickedDevice, setPickedDevice] = useState<string | null>(null);
  const [pickedBackup, setPickedBackup] = useState<string | null>(null);
  const sourceDeviceId = pickedDevice && usable.some((d) => d.id === pickedDevice) ? pickedDevice : (usable[0]?.id ?? null);
  const sourceBackup = backups.find((b) => b.id === pickedBackup) ?? backups[0] ?? null;

  let source: PlanSource | null = null;
  if (start.mode === "restore") source = { kind: "backup", backupId: start.backup.id };
  else if (sourceKind === "device" && sourceDeviceId) source = { kind: "device", deviceId: sourceDeviceId };
  else if (sourceKind === "backup" && sourceBackup) source = { kind: "backup", backupId: sourceBackup.id };
  const sourceName =
    start.mode === "restore"
      ? `${start.backup.name || start.backup.source.name} (backup from ${formatTaken(start.backup.createdAt)})`
      : sourceKind === "device"
        ? `${deviceTitle(devices.find((d) => d.id === sourceDeviceId) ?? { id: "", label: "", name: "", hostname: "" })} (fresh backup)`
        : sourceBackup
          ? `${sourceBackup.name || sourceBackup.source.name} (backup from ${formatTaken(sourceBackup.createdAt)})`
          : "";

  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const [include, setInclude] = useState<Required<BackupInclude>>(() => defaultInclude(clone));
  const [saveSnapshot, setSaveSnapshot] = useState(false);

  const targetChoices = devices.filter((d) => !(source?.kind === "device" && d.id === source.deviceId));
  const chosen = targetChoices.filter((d) => targets.has(d.id) && deviceUsability(d).ok);

  // The device the setup came from: copying its name back onto itself is not a clash.
  const sourceDeviceOwnId = start.mode === "restore" ? start.backup.source.id : sourceKind === "device" ? sourceDeviceId : (sourceBackup?.source.id ?? null);

  const [plans, setPlans] = useState<BackupPlan[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const request = (ids: string[]): PlanRequest | null => (source ? { source, targetIds: ids, include } : null);

  const review = async () => {
    const req = request(chosen.map((d) => d.id));
    if (!req) return;
    setStep("review");
    setPlans(null);
    setPlanError(null);
    setPlanning(true);
    try {
      setPlans(await planRestore(req));
    } catch (err) {
      setPlanError(errorMessage(err));
    } finally {
      setPlanning(false);
    }
  };

  const apply = async (ids: string[]) => {
    const req = request(ids);
    if (!req) return;
    setStarting(true);
    setApplyError(null);
    try {
      const job = await applyRestore(req, { saveSnapshot });
      setJobId(job.id);
      setStep("apply");
    } catch (err) {
      setApplyError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const idx = steps.findIndex((s) => s.key === step);
  const back = () => setStep(steps[Math.max(0, idx - 1)]?.key ?? "targets");
  const next = () => setStep(steps[Math.min(steps.length - 1, idx + 1)]?.key ?? "apply");

  const work = (plans ?? []).filter(planHasWork);
  const anyInclude = Object.values(include).some(Boolean);
  const setInc = (k: keyof BackupInclude, v: boolean) => setInclude((p) => ({ ...p, [k]: v }));
  const toggleTarget = (id: string, on: boolean) =>
    setTargets((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  let footer;
  if (step === "source") {
    footer = (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!source} onClick={next}>
          Next
        </Button>
      </>
    );
  } else if (step === "targets") {
    footer = (
      <>
        {idx > 0 ? <Button onClick={back}>Back</Button> : <Button onClick={onClose}>Cancel</Button>}
        <Button variant="primary" disabled={chosen.length === 0} onClick={next}>
          Next
        </Button>
      </>
    );
  } else if (step === "copy") {
    footer = (
      <>
        <Button onClick={back}>Back</Button>
        <Button variant="primary" disabled={!anyInclude} onClick={() => void review()}>
          Review plan
        </Button>
      </>
    );
  } else if (step === "review") {
    footer = (
      <>
        <Button onClick={back} disabled={starting}>
          Back
        </Button>
        {plans && work.length === 0 ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button variant="primary" disabled={planning || work.length === 0 || starting} aria-busy={starting || undefined} onClick={() => void apply(work.map((p) => p.targetId))}>
            {work.length === 1 ? "Apply to 1 device" : `Apply to ${work.length} devices`}
          </Button>
        )}
      </>
    );
  } else {
    footer = (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  }

  const skipped = notIncluded(include);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={clone ? "Clone a device" : `Restore ${start.mode === "restore" ? start.backup.name || start.backup.source.name : ""}`} width={640} footer={footer}>
      <ol className="steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s.key} className={cx(i < idx && "done", i === idx && "on")} aria-current={i === idx ? "step" : undefined}>
            {s.label}
          </li>
        ))}
      </ol>

      {step === "source" && (
        <div className="stack">
          <p className="strong">Where should the setup come from?</p>
          <label className="check">
            <input type="radio" name="bk-src" checked={sourceKind === "device"} onChange={() => setSourceKind("device")} /> A device (takes a fresh backup now)
          </label>
          <div className="field">
            <label htmlFor="bk-src-dev">Device</label>
            <Select
              id="bk-src-dev"
              value={sourceDeviceId ?? ""}
              onChange={setPickedDevice}
              disabled={sourceKind !== "device" || usable.length === 0}
              options={usable.length === 0 ? [{ value: "", label: "No online devices" }] : usable.map((d) => ({ value: d.id, label: `${deviceTitle(d)} · ${d.host}` }))}
            />
            <div className="hint">Only online devices are listed.</div>
          </div>
          <label className="check">
            <input type="radio" name="bk-src" checked={sourceKind === "backup"} onChange={() => setSourceKind("backup")} disabled={backups.length === 0} /> A saved backup
          </label>
          <div className="field">
            <label htmlFor="bk-src-bk">Backup</label>
            <Select
              id="bk-src-bk"
              value={sourceBackup?.id ?? ""}
              onChange={setPickedBackup}
              disabled={sourceKind !== "backup" || backups.length === 0}
              options={backups.length === 0 ? [{ value: "", label: "No saved backups yet" }] : backups.map((b) => ({ value: b.id, label: backupLabel(b) }))}
            />
          </div>
        </div>
      )}

      {step === "targets" && (
        <div className="stack">
          <p className="strong">Which devices should receive it?</p>
          {targetChoices.length === 0 ? (
            <p className="mut">There are no other devices to copy to.</p>
          ) : (
            <DevicePicker devices={targetChoices} selected={targets} onToggle={toggleTarget} label="Devices to receive the setup" />
          )}
          <div className="hint">Offline and unreachable devices can't be selected.</div>
        </div>
      )}

      {step === "copy" && (
        <div className="stack">
          <p className="strong">What should be copied?</p>
          <Checkbox checked={include.pins} onChange={(v) => setInc("pins", v)} label="Pins" />
          <Checkbox checked={include.modules} onChange={(v) => setInc("modules", v)} label="Add-ons" />
          <Checkbox checked={include.rules} onChange={(v) => setInc("rules", v)} label="Rules" />
          <Checkbox checked={include.mqtt} onChange={(v) => setInc("mqtt", v)} label="MQTT broker" hint="The MQTT login is never in a backup. A device keeps the login it already has." />
          <Checkbox checked={include.name} onChange={(v) => setInc("name", v)} label="Also copy the device name" hint="Off by default: each device keeps its own name." />
          {include.name && chosen.some((d) => d.id !== sourceDeviceOwnId) && <Banner tone="warn">Two devices with the same name share MQTT topics.</Banner>}
          {source?.kind === "device" && <Checkbox checked={saveSnapshot} onChange={setSaveSnapshot} label="Also keep the fresh backup in your list" />}
        </div>
      )}

      {step === "review" && (
        <div className="stack">
          <p>
            <span className="strong">{sourceName}</span> → <span className="strong">{chosen.map(deviceTitle).join(", ")}</span>
          </p>
          <Banner tone="info">This is a dry run. Nothing has been changed yet. Steps are applied in this order.</Banner>
          {planning && (
            <p className="mut" role="status">
              <Spinner /> Checking each device…
            </p>
          )}
          {planError && <InlineError message={planError} onRetry={() => void review()} retrying={planning} />}
          {plans?.map((p) => <PlanView key={p.targetId} plan={p} />)}
          {plans && work.length === 0 && plans.every((p) => p.reachable) && plans.length > 1 && <Banner tone="ok">Everything already matches. Nothing to apply.</Banner>}
          {skipped && plans && <p className="hint">Not changed: {skipped}.</p>}
          {applyError && <InlineError message={applyError} />}
        </div>
      )}

      {step === "apply" && jobId && <ApplyStep jobId={jobId} onJob={setJobId} plans={plans} onRerun={(ids) => void apply(ids)} rerunning={starting} rerunError={applyError} />}
    </Sheet>
  );
}
