import type { Job, JobAction, JobDeviceState, JobState, JobStep, JobStepStatus } from "@shared/api";
import { Ban, Circle, CircleCheck, CircleMinus, CircleX, LoaderCircle, Pause, Play, RotateCcw, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState } from "react";
import { runJobAction } from "../../api/jobs";
import { cx } from "../../lib/cx";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Chip, type Tone } from "../ui/Chip";
import { errorMessage } from "../ui/InlineError";
import { ProgressBar } from "../ui/ProgressBar";
import "./jobs.css";

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "Waiting to start",
  running: "Running",
  paused: "Paused",
  cancelling: "Cancelling",
  succeeded: "Done",
  failed: "Failed",
  partial: "Partly done",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const JOB_STATE_TONE: Record<JobState, Tone | undefined> = {
  queued: "off",
  running: "acc",
  paused: "warn",
  cancelling: "warn",
  succeeded: "ok",
  failed: "bad",
  partial: "warn",
  cancelled: "off",
  interrupted: "warn",
};

export const DEVICE_STATE_LABEL: Record<JobDeviceState, string> = {
  queued: "Waiting",
  running: "Working",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
  reverted: "Reverted",
};

const DEVICE_STATE_TONE: Record<JobDeviceState, Tone | undefined> = {
  queued: "off",
  running: "acc",
  done: "ok",
  failed: "bad",
  skipped: "off",
  cancelled: "off",
  rolled_back: "warn",
  reverted: "warn",
};

const STEP_LABEL: Record<JobStepStatus, string> = {
  pending: "Not started",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

const STEP_ICON: Record<JobStepStatus, LucideIcon> = {
  pending: Circle,
  running: LoaderCircle,
  done: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
  cancelled: Ban,
};

const ACTIONS: Record<JobAction, { label: string; icon: LucideIcon; variant?: "primary" | "danger" }> = {
  resume: { label: "Resume", icon: Play, variant: "primary" },
  retry: { label: "Retry", icon: RotateCcw, variant: "primary" },
  pause: { label: "Pause", icon: Pause },
  cancel: { label: "Cancel", icon: X },
};
const ACTION_ORDER: JobAction[] = ["resume", "retry", "pause", "cancel"];

const FINISHED: ReadonlySet<JobState> = new Set(["succeeded", "failed", "partial", "cancelled", "interrupted"]);
const BAR_TONE: Partial<Record<JobState, "ok" | "warn" | "bad">> = { succeeded: "ok", failed: "bad", partial: "warn", cancelled: "warn", interrupted: "warn", paused: "warn" };

export interface JobProgressProps {
  job: Job;
  /**
   * Called when an action button is pressed (also after `retry`: the result is usually a different job).
   * Without it the buttons call the generic job endpoints (`POST /api/jobs/:id/<action>`) and show a failure under the buttons.
   */
  onAction?(action: JobAction, job: Job): void | Promise<unknown>;
  /** Hide the per-device list (a parent shows its own table). */
  hideDevices?: boolean;
  className?: string;
}

function StepRow({ step }: { step: JobStep }) {
  const Icon = STEP_ICON[step.status];
  const pct = step.progress !== undefined ? Math.round(step.progress * 100) : null;
  return (
    <motion.li layout="position" className={cx("job-step", step.status)} aria-current={step.status === "running" ? "step" : undefined} data-status={step.status}>
      <span className="job-step-ico" aria-hidden="true">
        <Icon className={cx("i", step.status === "running" && "job-spin")} />
      </span>
      <div className="job-step-body">
        <div className="job-step-label">
          <span>{step.label}</span>
          <span className="sr">: {STEP_LABEL[step.status]}</span>
          {pct !== null && step.status === "running" && <span className="job-step-pct num mut">{pct}%</span>}
        </div>
        {step.detail && <div className="job-step-detail mut">{step.detail}</div>}
        {pct !== null && step.status === "running" && <ProgressBar className="job-step-bar" value={pct} label={`${step.label} progress`} />}
      </div>
    </motion.li>
  );
}

/**
 * The one place a job is drawn (setup, IP change, firmware update, applying a backup): title and state, overall progress,
 * a vertical list of steps, an optional per-device list, the error in plain words, and the buttons for what the job allows now.
 */
export function JobProgress({ job, onAction, hideDevices, className }: JobProgressProps) {
  const [busy, setBusy] = useState<JobAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const finished = FINISHED.has(job.state);
  const indeterminate = job.progress === null && !finished;
  const showBar = job.progress !== null || indeterminate;
  const pct = job.progress === null ? 0 : Math.round(job.progress * 100);
  const failedStep = job.error?.step ? job.steps.find((s) => s.id === job.error?.step) : undefined;
  const actions = ACTION_ORDER.filter((a) => job.actions.includes(a));

  const press = async (action: JobAction) => {
    setActionError(null);
    setBusy(action);
    try {
      if (onAction) await onAction(action, job);
      else await runJobAction(job.id, action);
    } catch (err) {
      if (!onAction) setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <section className={cx("job", job.state, className)} aria-label={job.title} data-state={job.state} data-kind={job.kind}>
        <header className="job-head">
          <h3 className="job-title">{job.title}</h3>
          <Chip tone={JOB_STATE_TONE[job.state]} className="job-state">
            {JOB_STATE_LABEL[job.state]}
          </Chip>
        </header>

        {showBar && (
          <div className="job-bar">
            <ProgressBar value={pct} indeterminate={indeterminate} tone={BAR_TONE[job.state]} label={`${job.title}: overall progress`} />
            {!indeterminate && <span className="job-pct num mut">{pct}%</span>}
          </div>
        )}
        {job.message && job.message.replace(/[.!s]+$/, "").toLowerCase() !== JOB_STATE_LABEL[job.state].toLowerCase() && (
          <p className="job-msg" role="status">
            {job.message}
          </p>
        )}

        {job.steps.length > 0 && (
          <ol className="job-steps" aria-label="Steps">
            {job.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ol>
        )}

        {!hideDevices && job.devices.length > 0 && (
          <ul className="job-devices" aria-label="Devices">
            <AnimatePresence initial={false}>
              {job.devices.map((d) => (
                <motion.li
                  key={d.deviceId}
                  layout="position"
                  className={cx("job-device", d.state)}
                  data-state={d.state}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="job-device-main">
                    <span className="job-device-name">{d.name || d.deviceId}</span>
                    {d.name && <span className="job-device-id mono mut">{d.deviceId}</span>}
                    <Chip tone={DEVICE_STATE_TONE[d.state]}>{DEVICE_STATE_LABEL[d.state]}</Chip>
                  </div>
                  {(d.error?.message || d.message) && (
                    <div className={cx("job-device-msg", d.error ? "t-bad" : "mut")}>{d.error?.message ?? d.message}</div>
                  )}
                  {d.state === "running" && d.progress !== undefined && <ProgressBar className="job-step-bar" value={Math.round(d.progress * 100)} label={`${d.name || d.deviceId} progress`} />}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}

        <AnimatePresence initial={false}>
          {job.error && (
            <motion.div key="error" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Banner tone="bad" title={job.error.message}>
                {failedStep ? `It stopped at: ${failedStep.label}.` : undefined}
              </Banner>
            </motion.div>
          )}
        </AnimatePresence>

        {(actions.length > 0 || actionError) && (
          <div className="job-actions">
            {actionError && (
              <p className="job-action-error t-bad" role="alert">
                {actionError}
              </p>
            )}
            <div className="job-buttons">
              {actions.map((a) => {
                const { label, icon: Icon, variant } = ACTIONS[a];
                return (
                  <Button key={a} size="sm" variant={variant} disabled={busy !== null} aria-busy={busy === a} onClick={() => void press(a)}>
                    <Icon className="i sm" aria-hidden="true" />
                    {label}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </MotionConfig>
  );
}
