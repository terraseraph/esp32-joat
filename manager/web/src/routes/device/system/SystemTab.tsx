import type { DeviceSummary } from "@shared/api";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router";
import { useEffect } from "react";
import { useDevice } from "../../../api/devices";
import { useStore } from "../../../api/store";
import { Banner } from "../../../components/ui/Banner";
import { ButtonLink } from "../../../components/ui/Button";
import { Button } from "../../../components/ui/Button";
import { Card, CardHead } from "../../../components/ui/Card";
import { InlineError } from "../../../components/ui/InlineError";
import { KeyValue } from "../../../components/ui/KeyValue";
import { Skeleton } from "../../../components/ui/Skeleton";
import { Spinner } from "../../../components/ui/Spinner";
import { deviceTitle, formatAgo, formatUptime } from "../../../lib/format";
import { DangerZone } from "./DangerZone";
import { FirmwareCard } from "./FirmwareCard";
import { IdentityCard } from "./IdentityCard";
import { LogsCard } from "./LogsCard";
import { MemoryCard } from "./MemoryCard";
import { UptimeCard } from "./UptimeCard";
import { clearFactoryReset, isUnavailable, resetStore, useSystemData, type ResetMarker } from "./useSystemData";
import "./system.css";

function SystemSkeleton() {
  return (
    <div className="sys-cols" aria-busy="true" aria-label="Loading system information">
      {[0, 1].map((col) => (
        <div key={col} className="stack">
          {[0, 1].map((i) => (
            <Card key={i}>
              <div className="sys-skel">
                <Skeleton variant="title" width="30%" />
                <Skeleton variant="line" />
                <Skeleton variant="line" width="85%" />
                <Skeleton variant="line" width="70%" />
                <Skeleton variant="line" width="80%" />
              </div>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}

/** What the user needs to know once a factory-reset device is no longer on the LAN. */
function ResetAftermath({ id, marker, health }: { id: string; marker: ResetMarker; health: DeviceSummary["health"] }) {
  const restarting = health === "rebooting";
  return (
    <Card aria-labelledby="sys-reset-h">
      <CardHead title={<span id="sys-reset-h">{restarting ? `Resetting ${marker.name}…` : `${marker.name} was reset`}</span>} />
      {restarting ? (
        <p className="row">
          <Spinner label="Restarting" /> Waiting for the device to restart…
        </p>
      ) : (
        <div className="stack" style={{ gap: "var(--s3)" }}>
          <Banner tone="warn" title="This device is no longer on your network">
            Its Wi-Fi settings were erased, so it now runs as a Setup AP: the Wi-Fi network <span className="mono">{marker.apSsid}</span>.
          </Banner>
          <ol className="sys-steps">
            <li>
              Join <span className="mono">{marker.apSsid}</span> from a phone or computer and open <span className="mono">192.168.4.1</span>.
            </li>
            <li>Put the device back on your Wi-Fi from its own page.</li>
            <li>
              Add it again from <Link to="/discover">Discover</Link>. Its settings, pins, add-ons and rules need to be set up again.
            </li>
          </ol>
          <div className="btns">
            <ButtonLink to="/discover" variant="primary">
              Open Discover
            </ButtonLink>
            <Button onClick={() => clearFactoryReset(id)}>Dismiss</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Last values the Manager has when the device cannot be read (greyed, with Retry). */
function Unreachable({ summary, error, onRetry }: { summary: DeviceSummary; error: string; onRetry: () => void }) {
  return (
    <Card aria-labelledby="sys-err-h">
      <CardHead title={<span id="sys-err-h">System</span>} />
      <InlineError message={error} onRetry={onRetry} />
      <div className="sys-off" aria-disabled="true" style={{ marginTop: "var(--s4)" }}>
        <KeyValue
          items={[
            { label: "Device ID", value: summary.id, mono: true },
            { label: "Hostname", value: summary.hostname, mono: true },
            { label: "Address", value: summary.host, mono: true },
            { label: "Firmware", value: summary.app_version, mono: true },
            { label: "Last seen", value: formatAgo(summary.lastSeen) },
            { label: "Uptime at last poll", value: summary.uptime_s === null ? "" : formatUptime(summary.uptime_s) },
          ]}
        />
      </div>
    </Card>
  );
}

/** `/devices/:id/system` (M8): identity, firmware, memory, uptime, logs, danger zone. */
export function SystemTab({ id }: { id: string }) {
  const { summary } = useDevice(id);
  const data = useSystemData(id);
  const marker = useStore(resetStore, (m) => m[id]) as ResetMarker | undefined;
  const health = summary?.health;

  // The device answered again after a reset (it was put back on this network): the notice is obsolete.
  useEffect(() => {
    if (marker && health === "online" && Date.now() - marker.at > 5_000) clearFactoryReset(id);
  }, [marker, health, id]);

  if (!summary) return null;
  const title = deviceTitle(summary);
  const unavailable = isUnavailable(summary);
  const status = data.status;

  if (marker && health !== "online") return <ResetAftermath id={id} marker={marker} health={health ?? "unknown"} />;
  if (!status) {
    if (data.loading) return <SystemSkeleton />;
    return <Unreachable summary={summary} error={data.error ?? "The device did not answer."} onRetry={data.reload} />;
  }

  return (
    <div className="sys">
      <AnimatePresence initial={false}>
        {data.error && (
          <motion.div key="err" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: "hidden" }}>
            <div style={{ paddingBottom: "var(--s4)" }}>
              <Banner tone="warn" title="Showing the last values the Manager read" action={<Button size="sm" onClick={data.reload}>Retry</Button>}>
                <span className="mono">{data.error}</span>
              </Banner>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="sys-cols">
        <div className="stack">
          <IdentityCard id={id} status={status} summary={summary} disabled={unavailable} onRenamed={data.reload} />
          <FirmwareCard id={id} ota={data.ota} progress={data.progress} disabled={unavailable} />
        </div>
        <div className="stack">
          <MemoryCard memory={data.memory} disabled={unavailable} />
          <UptimeCard
            uptime_s={data.uptime_s}
            boot_count={data.boot_count}
            reset_reason={data.reset_reason}
            boot_state={data.boot_state}
            safe_mode={data.safe_mode}
            safe_reason={status.safe_reason}
            disabled={unavailable}
          />
        </div>
      </div>
      <div className="stack" style={{ marginTop: "var(--s4)", gap: "var(--s4)" }}>
        <LogsCard id={id} title={title} disabled={unavailable} />
        <DangerZone id={id} title={title} confirmName={status.name || status.hostname} apSsid={status.ap_ssid || status.hostname} disabled={unavailable} />
      </div>
    </div>
  );
}
