import type { Job, JobAction } from "@shared/api";
import { runJobAction, useJob } from "../../api/jobs";
import { JobProgress } from "../../components/jobs";
import { Banner } from "../../components/ui/Banner";
import { errorMessage, InlineError } from "../../components/ui/InlineError";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { isRollbackJob, jobTally, rowVersions } from "./logic";
import "./firmware.css";

/** One line for what happened to a single device, once its job has finished. */
function OutcomeBanner({ job }: { job: Job }) {
  const row = job.devices[0];
  if (!row || job.devices.length !== 1) return null;
  const v = rowVersions(row.result);
  if (row.state === "done" && isRollbackJob(job)) {
    return (
      <Banner tone="ok" title={v.to ? `Rolled back to ${v.to}` : "Rolled back to the previous firmware"}>
        {v.to ? (
          <>
            The device is running <span className="mono">{v.to}</span> again{v.from ? (
              <>
                {" "}(it ran <span className="mono">{v.from}</span> before)
              </>
            ) : null}.
          </>
        ) : (
          "The device came back and is running the firmware it ran before."
        )}
      </Banner>
    );
  }
  if (row.state === "done") {
    return (
      <Banner tone="ok" title="Update finished">
        {v.from && v.to ? (
          <>
            The device now runs <span className="mono">{v.to}</span> (it ran <span className="mono">{v.from}</span> before).
          </>
        ) : (
          "The device came back and is running the new firmware."
        )}
      </Banner>
    );
  }
  if (row.state === "rolled_back") {
    return (
      <Banner tone="warn" title="The device went back to its previous firmware">
        {row.message ?? "The new firmware did not pass its health check, so the device undid the update."}
        {v.from && (
          <>
            {" "}It is running <span className="mono">{v.from}</span> again.
          </>
        )}
      </Banner>
    );
  }
  return null;
}

export interface OtaJobViewProps {
  jobId: string;
  /** Called with the new job's id after Retry (the server starts a new job for the devices that did not finish). */
  onFollow?(jobId: string): void;
  className?: string;
}

/** A firmware job (update, roll back or bulk) with its buttons, plus the plain tally and outcome. */
export function OtaJobView({ jobId, onFollow, className }: OtaJobViewProps) {
  const { job, loading, error } = useJob(jobId);
  const toast = useToast();

  if (!job) {
    if (loading) return <Skeleton variant="block" height={96} />;
    return <InlineError message={error?.code === "not_found" ? "The Manager no longer lists this job." : (error?.message ?? "This job could not be loaded.")} />;
  }

  const act = async (action: JobAction, j: Job) => {
    try {
      const next = await runJobAction(j.id, action);
      if (action === "retry" && next.id !== j.id) onFollow?.(next.id);
    } catch (err) {
      toast({ tone: "bad", title: `Could not ${action} the update`, description: errorMessage(err) });
    }
  };

  const tally = job.devices.length > 1 ? jobTally(job) : "";
  return (
    <div className={className}>
      <div className="fw-job-top">
        {tally && <strong>{tally}</strong>}
        <JobProgress job={job} onAction={act} hideDevices={job.devices.length === 1 && job.steps.length > 0} />
        {(job.state === "succeeded" || job.state === "partial" || job.state === "failed") && <OutcomeBanner job={job} />}
      </div>
    </div>
  );
}
