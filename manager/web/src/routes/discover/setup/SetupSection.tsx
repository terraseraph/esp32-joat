import { CheckCircle2, Lock, LockOpen, Radio, RefreshCw, WifiOff } from "lucide-react";
import { useState } from "react";
import type { SetupAp } from "@shared/api";
import { useDevices } from "../../../api/devices";
import { useJobs } from "../../../api/jobs";
import { useSetupAps } from "../../../api/setup";
import { Banner, Button, ButtonLink, Card, CardHead, Chip, Skeleton, Spinner } from "../../../components/ui";
import { RecoveryBanner } from "./RecoveryBanner";
import { SetupFlow } from "./SetupFlow";
import { signalBars, splitSetupAps, type SetupTarget } from "./logic";
import "./setup.css";

interface FlowState {
  target?: SetupTarget;
  jobId?: string;
}

/** "Devices in setup mode" on Discover: boards whose own Wi-Fi (`esp32-xxxxxx`) this PC can see, plus a running setup and the crash-recovery banner. */
export function SetupSection() {
  const aps = useSetupAps();
  const { jobs: running } = useJobs({ kind: "setup", active: true });
  const [flow, setFlow] = useState<FlowState | null>(null);
  const active = running[0];
  const { list: devices } = useDevices();

  const { data } = aps;
  let body;
  if (aps.loading) {
    body = (
      <div className="stack" aria-busy="true" aria-label="Looking for devices in setup mode">
        <Skeleton variant="title" />
        <Skeleton />
      </div>
    );
  } else if (!data) {
    // the server does not offer setup (older build) or could not answer: stay out of the way
    return flow ? <SetupFlow {...flow} onClose={() => setFlow(null)} /> : <RecoveryBanner />;
  } else if (!data.supported) {
    body = (
      <p className="su-unsupported mut">
        <WifiOff className="i sm" aria-hidden="true" />
        <span>{data.reason ?? "This PC cannot join a device's setup Wi-Fi."} Join the device's Wi-Fi yourself and open 192.168.4.1 to set it up.</span>
      </p>
    );
  } else {
    const { needSetup, alreadySetUp } = splitSetupAps(data.aps, devices);
    body = (
      <>
        {needSetup.length === 0 ? (
          <div className="su-empty">
            <p>{alreadySetUp.length ? "No device needs setting up." : "No device in setup mode nearby."}</p>
            <p className="mut su-p">A new board raises its own Wi-Fi called <span className="mono">esp32-xxxxxx</span> until it has a network. Power it on close to this PC and press Refresh.</p>
          </div>
        ) : (
          <ul className="su-aps" aria-label="Devices in setup mode">
            {needSetup.map((ap) => (
              <li key={ap.ssid} className="su-ap">
                <ApMain ap={ap} />
                {ap.knownDeviceId && <Chip tone="acc">In your fleet, offline</Chip>}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={Boolean(active)}
                  onClick={() => setFlow({ target: { ssid: ap.ssid, secured: ap.secured, deviceId: ap.knownDeviceId ?? undefined } })}
                  aria-label={`${ap.knownDeviceId ? "Recover" : "Set up"} ${ap.ssid}`}
                >
                  {ap.knownDeviceId ? "Recover" : "Set up"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {alreadySetUp.length > 0 && (
          <div className="su-done">
            <p className="mut su-p">
              Already set up and online. Their setup Wi-Fi is still on; the board closes it when it restarts.
            </p>
            <ul className="su-aps" aria-label="Already set up">
              {alreadySetUp.map(({ ap, device }) => (
                <li key={ap.ssid} className="su-ap done">
                  <ApMain ap={ap} />
                  <Chip tone="ok" icon={CheckCircle2}>
                    {device?.name || "In your fleet"}
                    {device?.host ? ` · ${device.host}` : ""}
                  </Chip>
                  <ButtonLink to={`/devices/${ap.knownDeviceId}/live`} size="sm" variant="ghost" aria-label={`Open ${device?.name || ap.ssid}`}>
                    Open
                  </ButtonLink>
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="su-section">
      <RecoveryBanner />
      {active && (
        <Banner
          tone="info"
          title="A setup is running"
          action={
            <Button size="sm" variant="primary" onClick={() => setFlow({ jobId: active.id })}>
              Show progress
            </Button>
          }
        >
          {active.message ?? active.title}
        </Banner>
      )}
      <Card aria-labelledby="su-h">
        <CardHead
          title={
            <span id="su-h" className="su-title">
              <Radio className="i" aria-hidden="true" />
              Devices in setup mode
            </span>
          }
          actions={
            data?.supported ? (
              <Button size="sm" onClick={() => void aps.refresh()} disabled={aps.refreshing} aria-busy={aps.refreshing}>
                {aps.refreshing ? <Spinner /> : <RefreshCw className="i sm" aria-hidden="true" />}
                Refresh
              </Button>
            ) : undefined
          }
        />
        {body}
        {aps.error && !aps.loading && data && (
          <p className="t-bad su-p" role="alert">
            {aps.error.message}
          </p>
        )}
      </Card>
      {flow && <SetupFlow {...flow} onClose={() => setFlow(null)} />}
    </div>
  );
}

function ApMain({ ap }: { ap: SetupAp }) {
  const bars = signalBars(ap.signal);
  return (
    <div className="su-ap-main">
      <div className="su-ap-name mono">{ap.ssid}</div>
      <div className="su-ap-meta mut">
        <span className="su-sig" data-l={bars} role="img" aria-label={ap.signal === null ? "Signal unknown" : `Signal ${ap.signal} percent`}>
          <i />
          <i />
          <i />
          <i />
        </span>
        {ap.secured ? <Lock className="i sm" aria-hidden="true" /> : <LockOpen className="i sm" aria-hidden="true" />}
        <span>{ap.secured ? "Password protected" : "Open"}</span>
      </div>
    </div>
  );
}
