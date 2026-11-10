import { useEffect, useRef, useState } from "react";
import { ipChangeOf, readIpJobResult, useIpSettings } from "../../../../api/ip";
import type { IpSettings } from "@shared/api";
import { isJobFinished, useJob } from "../../../../api/jobs";
import type { NetworkStatus } from "@shared/device-api";
import { IpModeChip } from "../../../../components/device/IpModeChip";
import { JobProgress } from "../../../../components/jobs";
import { Banner, Button, Card, CardHead, Chip, InlineError, KeyValue, Skeleton } from "../../../../components/ui";
import { cannotChangeReason, ipChangeWords, ipJobOutcome, netmaskText } from "./logic";
import { IpSheet } from "./IpSheet";
import "./ip.css";

interface Props {
  id: string;
  /** The device's live network status: when it changes (new address, mode, ip_change) the settings are read again. */
  net: NetworkStatus;
  down: boolean;
}

/** The job of the change in progress or just finished, with its outcome in plain words. */
function IpJobView({ jobId, onDone, onChanged }: { jobId: string; onDone: () => void; onChanged: () => void }) {
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
  const outcome = ipJobOutcome(job, readIpJobResult(job));
  return (
    <div className="ip-job">
      <JobProgress job={job} />
      {outcome && (
        <Banner tone={outcome.tone} title={outcome.title}>
          {outcome.body}
        </Banner>
      )}
      {!finished && job.steps.some((x) => x.id === "revert" && x.status === "running") ? (
        <p className="nt-note">Cancel stops the Manager from waiting. The device still goes back to its previous setting by itself.</p>
      ) : (
        !finished && <p className="nt-note">Cancelling before the confirm step lets the device go back to its previous setting by itself.</p>
      )}
      {finished && (
        <div className="nt-actions">
          <Button size="sm" onClick={onDone}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function Values({ s }: { s: IpSettings }) {
  return (
    <KeyValue
      items={[
        { label: "Address", value: s.ip, mono: true },
        { label: "Netmask", value: s.netmask ? netmaskText(s.netmask) : "", mono: true },
        { label: "Gateway", value: s.gateway, mono: true },
        { label: "DNS server", value: s.dns, mono: true },
      ]}
    />
  );
}

/** Network tab: "IP address" card (spec 3.12): DHCP or static, the numbers, a pending change, the last result, and the Change button. */
export function IpCard({ id, net, down }: Props) {
  const res = useIpSettings(id);
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { reload } = res;

  // Read the settings again when the device reports something new (skip the first render: the hook just loaded).
  const sig = `${net.sta_ip}|${net.ip_mode ?? ""}|${net.ip_change?.result ?? ""}|${net.ip_change?.applied ?? ""}`;
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    reload();
  }, [sig, reload]);

  const s = res.data;
  const serverJob = s?.activeJobId && s.activeJobId !== dismissed ? s.activeJobId : null;
  const activeId = jobId ?? serverJob;
  const cls = down ? "nt-card is-down" : "nt-card";

  if (!s) {
    return (
      <Card className={cls} aria-labelledby="nt-ip-h">
        <CardHead title={<span id="nt-ip-h">IP address</span>} />
        {res.error ? (
          <InlineError message={res.error.message} onRetry={res.reload} />
        ) : (
          <div aria-busy="true" aria-label="Loading IP address">
            <Skeleton />
            <Skeleton width="80%" />
          </div>
        )}
      </Card>
    );
  }

  // The live status is fresher than the settings read; when the device reports a record, trust that one.
  const words = ipChangeWords(net.ip_change ?? ipChangeOf(s));
  const blocked = cannotChangeReason(s, down);

  return (
    <Card className={cls} aria-labelledby="nt-ip-h">
      <CardHead
        title={<span id="nt-ip-h">IP address</span>}
        actions={s.supported ? <IpModeChip mode={s.ipMode} className="ip-mode-chip" /> : <Chip tone="off">Needs newer firmware</Chip>}
      />
      {!s.supported ? (
        <p className="nt-note">
          {s.reason ?? "This device's firmware doesn't report how it gets its address, so the Manager can't change it."} Update the device&apos;s firmware to choose DHCP or a fixed
          address here.
        </p>
      ) : (
        <>
          <Values s={s} />
          {!s.staConnected && <p className="nt-note">The device isn&apos;t connected to Wi-Fi right now, so it has no address to show.</p>}
          {words && (
            <p className="nt-note" role="status" data-tone={words.tone}>
              {words.text}
            </p>
          )}
          {activeId && <IpJobView key={activeId} jobId={activeId} onDone={() => {
                setDismissed(activeId);
                setJobId(null);
              }} onChanged={reload} />}
          <div className="nt-actions">
            <Button onClick={() => setOpen(true)} disabled={down || blocked !== null}>
              Change
            </Button>
          </div>
          {blocked && <p className="nt-note">{blocked}</p>}
          <IpSheet id={id} settings={s} open={open} onOpenChange={setOpen} onStarted={(job) => setJobId(job.id)} />
        </>
      )}
    </Card>
  );
}
