import type { NetworkStatus } from "@shared/device-api";
import { useEffect, useRef, useState } from "react";
import { isJobFinished, useJob } from "../../../../api/jobs";
import { useSetupAdapter } from "../../../../api/setup";
import { readWifiMoveResult, useWifiMoveSettings } from "../../../../api/wifimove";
import { JobProgress } from "../../../../components/jobs";
import { Banner, Button, Skeleton } from "../../../../components/ui";
import { SetupFlow, setupApSsid } from "../../../discover/setup";
import { cannotMoveReason, wifiMoveOutcome } from "./logic";
import { WifiMoveSheet } from "./WifiMoveSheet";
import "./wifimove.css";

interface Props {
  id: string;
  /** The device's live network status: `wifi_change` decides whether the control exists at all. */
  net: NetworkStatus;
  /** What the person types to confirm. */
  deviceName: string;
  down: boolean;
  /** Called when a move finished (the network status should be read again). */
  onChanged?: () => void;
}

/** The job of the move in progress or just finished, with its ending in plain words. */
function MoveJobView({ jobId, onDone, onChanged, onRecover }: { jobId: string; onDone: () => void; onChanged: () => void; onRecover?: () => void }) {
  const { job } = useJob(jobId);
  const finished = job ? isJobFinished(job) : false;
  const reloaded = useRef(false);
  useEffect(() => {
    if (finished && !reloaded.current) {
      reloaded.current = true;
      onChanged();
    }
  }, [finished, onChanged]);
  if (!job) return <Skeleton variant="block" />;
  const result = readWifiMoveResult(job);
  const outcome = wifiMoveOutcome(job, result);
  return (
    <div className="wm-job">
      <JobProgress job={job} />
      {outcome && (
        <Banner tone={outcome.tone} title={outcome.title}>
          {outcome.body}
        </Banner>
      )}
      {!finished && <p className="nt-note">If the device cannot join the new network it goes back to its current one by itself. Cancelling only stops the Manager from waiting.</p>}
      {finished && (
        <div className="nt-actions">
          {onRecover && (result?.outcome === "not_found" || result?.outcome === "unknown") && (
            <Button size="sm" variant="primary" onClick={onRecover}>
              Recover over its setup Wi-Fi
            </Button>
          )}
          <Button size="sm" onClick={onDone}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/** Wi-Fi card section "Move to another Wi-Fi network" (L1). Absent on firmware without `wifi_change`: a muted line says why. */
export function WifiMoveSection({ id, net, deviceName, down, onChanged }: Props) {
  const supported = net.wifi_change !== undefined;
  const res = useWifiMoveSettings(id, supported);
  const adapter = useSetupAdapter();
  const [open, setOpen] = useState(false);
  const [recover, setRecover] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { reload } = res;

  if (!supported) return <p className="nt-note">Moving to another Wi-Fi network needs newer firmware.</p>;

  const serverJob = res.data?.activeJobId && res.data.activeJobId !== dismissed ? res.data.activeJobId : null;
  const activeId = jobId ?? serverJob;
  const blocked = cannotMoveReason(down, activeId !== null);
  const canRecover = adapter.adapter?.supported === true;

  return (
    <div className="wm-line">
      {activeId && (
        <MoveJobView
          key={activeId}
          jobId={activeId}
          onDone={() => {
            setDismissed(activeId);
            setJobId(null);
          }}
          onRecover={canRecover ? () => setRecover(true) : undefined}
          onChanged={() => {
            reload();
            onChanged?.();
          }}
        />
      )}
      <div className="nt-actions">
        <Button onClick={() => setOpen(true)} disabled={down || blocked !== null}>
          Move to another Wi-Fi network
        </Button>
      </div>
      {blocked && <p className="nt-note">{blocked}</p>}
      <WifiMoveSheet id={id} deviceName={deviceName} open={open} onOpenChange={setOpen} onStarted={(job) => setJobId(job.id)} />
      {recover && <SetupFlow target={{ ssid: setupApSsid(id), deviceId: id }} onClose={() => setRecover(false)} />}
    </div>
  );
}
