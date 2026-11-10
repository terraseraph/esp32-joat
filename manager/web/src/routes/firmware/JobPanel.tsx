import type { Job, JobState } from "@shared/api";
import { useEffect, useMemo } from "react";
import { isJobFinished, useJobs } from "../../api/jobs";
import { JOB_STATE_LABEL } from "../../components/jobs";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Card, CardHead } from "../../components/ui/Card";
import { Chip, type Tone } from "../../components/ui/Chip";
import { formatAgo } from "../../lib/format";
import { OtaJobView } from "./OtaJobView";
import "./firmware.css";

const TONE: Record<JobState, Tone | undefined> = {
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

export interface JobPanelProps {
  /** The job the user just started or picked from the history. */
  followed: string | null;
  onFollow: (id: string | null) => void;
}

/** The running (or just finished) firmware job, followed live; it keeps showing until dismissed. */
export function JobPanel({ followed, onFollow }: JobPanelProps) {
  const { jobs: active } = useJobs({ kind: "ota", active: true });
  const firstActive = active[0]?.id ?? null;
  // An update that started elsewhere (device page, another tab) is picked up and then kept until dismissed.
  useEffect(() => {
    if (followed === null && firstActive !== null) onFollow(firstActive);
  }, [followed, firstActive, onFollow]);
  const id = followed ?? firstActive;
  const { jobs } = useJobs({ kind: "ota" });
  const job = id ? jobs.find((j) => j.id === id) : undefined;
  if (!id) return null;
  const finished = job ? isJobFinished(job) : false;
  return (
    <Card aria-labelledby="fw-job-h">
      <CardHead
        title={<span id="fw-job-h">{finished ? "Last update" : "Update in progress"}</span>}
        actions={
          finished ? (
            <div className="actions">
              <ButtonLink to="/" size="sm">
                Back to Fleet
              </ButtonLink>
              <Button size="sm" variant="ghost" onClick={() => onFollow(null)}>
                Dismiss
              </Button>
            </div>
          ) : undefined
        }
      />
      <OtaJobView jobId={id} onFollow={onFollow} />
    </Card>
  );
}

/** Finished firmware jobs, newest first (the server keeps the last 20). */
export function History({ onView }: { onView: (id: string) => void }) {
  const { jobs } = useJobs({ kind: "ota", active: false });
  const rows = useMemo(() => jobs.slice(0, 20), [jobs]);
  return (
    <Card aria-label="Update history">
      <details className="fw-hist">
        <summary>
          History <span className="badge">{rows.length}</span>
        </summary>
        {rows.length === 0 ? (
          <p className="mut">Finished updates show up here.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: "var(--s3)" }}>
            <table className="table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th className="num">Devices</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((j: Job) => (
                  <tr key={j.id}>
                    <td>{formatAgo(j.finishedAt ?? j.createdAt)}</td>
                    <td>{j.title}</td>
                    <td className="num">{j.deviceIds.length}</td>
                    <td>
                      <Chip tone={TONE[j.state]}>{JOB_STATE_LABEL[j.state]}</Chip>
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" aria-label={`View ${j.title}`} onClick={() => onView(j.id)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: "var(--s2)" }}>
          The last 20 jobs are kept.
        </p>
      </details>
    </Card>
  );
}
