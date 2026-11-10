import type { Job } from "@shared/api";
import { ArrowUpRight, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api/client";
import { isJobFinished, upsertJob, useJob } from "../../../api/jobs";
import { healthStore } from "../../../api/serverStatus";
import { sendSetupWifi, startSetupJob, useSetupRecovery, type SetupStartBody, type SetupWifiBody } from "../../../api/setup";
import { useStore } from "../../../api/store";
import { JobProgress } from "../../../components/jobs";
import { Banner, Button, ButtonLink, Checkbox, Field, PasswordInput, Sheet, Spinner } from "../../../components/ui";
import { errorMessage } from "../../../components/ui/InlineError";
import { ChooseNetwork } from "./ChooseNetwork";
import { chooseResult, doneResult, failureHint, isRemoteBrowser, type SetupTarget } from "./logic";
import { RecoveryBanner } from "./RecoveryBanner";
import "./setup.css";

export interface SetupFlowProps {
  /** Set when the flow starts something new (the intro is shown first). */
  target?: SetupTarget;
  /** Set to follow a setup job that is already running (reopening Discover). */
  jobId?: string;
  onClose(): void;
}

function RemoteWarning({ running }: { running: boolean }) {
  return (
    <Banner tone="warn" title={running ? "This page will lose the Manager until the setup ends" : "You are using the Manager from another computer"}>
      The Manager runs on a different PC and has to leave its Wi-Fi for about a minute. This page will stop updating until it is back. Keep it open: the result is shown here afterwards.
    </Banner>
  );
}

/** Guided SoftAP setup in a Sheet: intro and warnings, then the job (with the choose-network step), then the result. */
export function SetupFlow({ target, jobId: initialJobId, onClose }: SetupFlowProps) {
  const [jobId, setJobId] = useState<string | undefined>(initialJobId);
  const { job, loading, error: jobError, cancel, retry } = useJob(jobId);
  const lan = useStore(healthStore, (s) => s.health?.lan ?? false);
  const remote = isRemoteBrowser(lan, typeof location === "undefined" ? "localhost" : location.hostname);
  const recovery = useSetupRecovery();

  // intro form
  const [apPassword, setApPassword] = useState("");
  const [reset, setReset] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // choose step
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const finished = job ? isJobFinished(job) : false;
  // a failed run may have left a recovery marker: look again once it ended
  const reloaded = useRef<string | null>(null);
  const reloadRecovery = recovery.reload;
  useEffect(() => {
    if (job && finished && job.state !== "succeeded" && reloaded.current !== job.id) {
      reloaded.current = job.id;
      void reloadRecovery();
    }
  }, [job, finished, reloadRecovery]);

  const ssid = target?.ssid ?? (typeof job?.params.ssid === "string" ? job.params.ssid : "");
  const recoverId = target?.deviceId ?? (typeof job?.params.deviceId === "string" ? job.params.deviceId : undefined);
  // a resumed job has no target: the intro ("Try again") is rebuilt from its public params
  const known: SetupTarget | undefined = target ?? (ssid ? { ssid, secured: undefined, deviceId: recoverId } : undefined);
  const secured = known?.secured;
  const title = recoverId ? "Recover over its setup Wi-Fi" : "Set up a device";

  const start = async () => {
    if (!known) return;
    if (secured === true && !apPassword) {
      setStartError("Enter the setup Wi-Fi password.");
      return;
    }
    setStarting(true);
    setStartError(null);
    const body: SetupStartBody = { ssid: known.ssid };
    if (apPassword) body.apPassword = apPassword;
    if (known.deviceId) body.deviceId = known.deviceId;
    if (reset) body.factoryResetFirst = true;
    try {
      const started = await startSetupJob(body);
      upsertJob(started);
      setApPassword("");
      setJobId(started.id);
    } catch (err) {
      setStartError(err instanceof ApiError && err.code === "setup_running" ? "Another setup is already running. Open it from Discover, or wait until it ends." : errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const send = async (current: Job, body: SetupWifiBody) => {
    setSending(true);
    setSendError(null);
    try {
      upsertJob(await sendSetupWifi(current.id, body));
    } catch (err) {
      setSendError(err instanceof ApiError && err.code === "job_not_waiting" ? "The device is no longer waiting for a network. See the steps above." : errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const again = () => {
    setJobId(undefined);
    setStartError(null);
    setSendError(null);
  };

  const choose = job ? chooseResult(job) : null;
  const done = job ? doneResult(job) : null;
  const hint = job?.state === "failed" ? failureHint(job.error?.code) : null;

  let body;
  let footer;
  if (!jobId) {
    const needAp = secured !== false;
    body = (
      <div className="su-body">
        {remote && <RemoteWarning running={false} />}
        <RecoveryBanner />
        {recoverId ? (
          <p className="su-p">
            The Manager will join <span className="mono">{ssid}</span> to reach this device and give it a Wi-Fi network again. A device raises its setup Wi-Fi after about a minute without its network. This needs newer firmware: older firmware only does it after a reset.
          </p>
        ) : (
          <p className="su-p">
            The Manager will join <span className="mono">{ssid}</span>, ask the device which Wi-Fi networks it can see, and send it the one you pick.
          </p>
        )}
        <Banner tone="info" title="Your PC leaves its Wi-Fi for about a minute">
          While it is on the device's setup Wi-Fi, this PC has no internet and cannot reach other devices. The Manager reconnects it afterwards, even if something goes wrong.
        </Banner>
        {needAp && (
          <Field
            label="Setup Wi-Fi password"
            hint={secured === true ? undefined : "Only if the setup Wi-Fi has a password. Leave it empty if it is open."}
            required={secured === true}
          >
            <PasswordInput value={apPassword} onChange={setApPassword} disabled={starting} />
          </Field>
        )}
        <div className="su-danger">
          <Checkbox
            checked={reset}
            onChange={setReset}
            disabled={starting}
            label="Factory reset first"
            hint="Erases the device's saved settings (Wi-Fi, pins, rules, MQTT) before it gets the new network. Only use it when you want a clean start."
          />
        </div>
        {startError && (
          <Banner tone="bad" title="Could not start the setup">
            {startError}
          </Banner>
        )}
      </div>
    );
    footer = (
      <>
        <Button onClick={onClose} disabled={starting}>
          Cancel
        </Button>
        <Button variant={reset ? "danger" : "primary"} onClick={() => void start()} disabled={starting || !known} aria-busy={starting}>
          {starting && <Spinner />}
          {reset ? "Reset and start setup" : "Start setup"}
        </Button>
      </>
    );
  } else if (!job) {
    body = (
      <div className="su-body">
        {loading ? (
          <p className="mut su-wait">
            <Spinner label="Loading" /> Loading the setup...
          </p>
        ) : (
          <Banner tone="warn" title="This setup is no longer available">
            {jobError?.message ?? "The Manager no longer has it."}
          </Banner>
        )}
      </div>
    );
    footer = <Button onClick={onClose}>Close</Button>;
  } else {
    body = (
      <div className="su-body">
        {remote && !finished && <RemoteWarning running />}
        <RecoveryBanner />
        <JobProgress
          job={job}
          hideDevices
          onAction={async (action) => {
            if (action === "cancel") await cancel();
            else if (action === "retry") {
              const next = await retry();
              if (next) setJobId(next.id);
            }
          }}
        />
        {jobError && <Banner tone="bad">{jobError.message}</Banner>}
        {choose && <ChooseNetwork result={choose} busy={sending} error={sendError} onSubmit={(b) => void send(job, b)} />}
        {done && (
          <Banner tone="ok" title={done.name ? `${done.name} is on your network` : "The device is on your network"}>
            {done.added ? "It was added to your fleet." : "It is already in your fleet."}
            {done.host ? (
              <>
                {" "}
                Address <span className="mono">{done.host}</span>.
              </>
            ) : null}
          </Banner>
        )}
        {hint && <p className="mut su-p">{hint}</p>}
        {job.state === "failed" && job.error?.code === "restore_failed" && (
          <div>
            <Button variant="primary" disabled={recovery.busy !== null} onClick={() => void recovery.restore()}>
              {recovery.busy === "restore" ? <Spinner /> : <TriangleAlert className="i sm" aria-hidden="true" />}
              Restore network
            </Button>
          </div>
        )}
      </div>
    );
    footer = finished ? (
      <>
        {done ? (
          <ButtonLink to={`/devices/${encodeURIComponent(done.deviceId)}`} variant="primary" onClick={onClose}>
            Open the device
            <ArrowUpRight className="i sm" aria-hidden="true" />
          </ButtonLink>
        ) : (
          <Button onClick={again}>
            <RotateCcw className="i sm" aria-hidden="true" />
            Try again
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </>
    ) : (
      <Button onClick={onClose}>Hide</Button>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      description={ssid ? <span className="mono">{ssid}</span> : undefined}
      width={540}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
