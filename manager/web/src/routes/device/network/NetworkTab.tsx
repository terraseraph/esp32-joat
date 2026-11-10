import type { MqttStatus, NetworkStatus } from "@shared/device-api";
import { useState } from "react";
import { useDevice } from "../../../api/devices";
import { useDeviceResource } from "../../../api/commands";
import { useDeviceEvent, useDeviceLive } from "../../../api/live";
import { Banner, Button, Card, Chip, InlineError, Skeleton } from "../../../components/ui";
import { formatAgo } from "../../../lib/format";
import { ApCard } from "./ApCard";
import { IpCard } from "./ip/IpCard";
import { MqttCard } from "./MqttCard";
import { WifiCard } from "./WifiCard";
import "./network.css";

/** Keeps the last non-null value, so an offline reload still shows what was seen before. */
function useLastGood<T>(data: T | null): T | null {
  const [kept, setKept] = useState<T | null>(data);
  if (data !== null && data !== kept) setKept(data);
  return data ?? kept;
}

/** Overlays a telemetry snapshot that arrived after `base` was loaded (older snapshots would show stale values). */
function useFresh<T extends object>(base: T | null, tele: T | null | undefined): T | null {
  const [seen, setSeen] = useState<{ base: T | null; tele: T | null }>({ base, tele: tele ?? null });
  if (seen.base !== base) setSeen({ base, tele: tele ?? null });
  if (base && tele && tele !== seen.tele) return { ...base, ...tele };
  return base;
}

const DOWN = new Set(["offline", "unreachable", "rebooting", "updating"]);

function Loading() {
  return (
    <div className="nt-grid" aria-busy="true" aria-label="Loading network settings">
      {[0, 1].map((i) => (
        <Card key={i} className="nt-card">
          <Skeleton variant="title" />
          <Skeleton />
          <Skeleton width="80%" />
          <Skeleton width="60%" />
          <Skeleton variant="block" />
        </Card>
      ))}
    </div>
  );
}

/** Network tab (`/devices/:id/network`): Wi-Fi (read-only), Setup AP, MQTT. */
export function NetworkTab({ id }: { id: string }) {
  const { summary } = useDevice(id);
  const live = useDeviceLive(id);
  const netRes = useDeviceResource<NetworkStatus>(id, "network");
  const mqttRes = useDeviceResource<MqttStatus>(id, "mqtt");
  const reloadNet = netRes.reload;
  useDeviceEvent(id, "net", () => reloadNet());

  const netBase = useLastGood(netRes.data);
  const mqttBase = useLastGood(mqttRes.data);
  const net = useFresh(netBase, live.telemetry?.network);
  const mqtt = useFresh(mqttBase, live.telemetry?.mqtt);

  const down = summary ? DOWN.has(summary.health) : false;
  const busy = (summary?.queue ?? 0) > 0;
  const reloadAll = () => {
    netRes.reload();
    mqttRes.reload();
  };
  const reloadMqtt = mqttRes.reload;

  const loading = (netRes.loading && !netBase) || (mqttRes.loading && !mqttBase);
  const failed = !net && !mqtt && (netRes.error ?? mqttRes.error);
  const lastSeen = summary ? formatAgo(summary.lastSeen) : "never";

  return (
    <div className="nt-tab">
      {down && (
        <Banner
          tone="warn"
          title={`${summary?.label || summary?.name || "This device"} isn't answering.`}
          action={
            <Button size="sm" onClick={reloadAll}>
              Retry
            </Button>
          }
        >
          {net || mqtt ? "Showing the last values the Manager saw. " : ""}Last seen {lastSeen}. Network changes are unavailable.
        </Banner>
      )}
      {busy && !down && (
        <Banner tone="info">
          <Chip>Busy</Chip> The device is handling other requests; changes may take a moment.
        </Banner>
      )}
      {loading && !failed ? (
        <Loading />
      ) : failed ? (
        <Card className="nt-card">
          <InlineError message={failed.message} onRetry={reloadAll} />
        </Card>
      ) : (
        <div className="nt-grid">
          {net ? (
            <>
              <WifiCard id={id} net={net} down={down} deviceName={summary?.label || summary?.name || summary?.hostname || id} onChanged={reloadNet} />
              <ApCard id={id} net={net} down={down} onChanged={reloadNet} />
              <IpCard id={id} net={net} down={down} />
            </>
          ) : (
            netRes.error && (
              <Card className="nt-card nt-full">
                <InlineError message={netRes.error.message} onRetry={netRes.reload} />
              </Card>
            )
          )}
          {mqtt ? (
            <MqttCard id={id} mqtt={mqtt} down={down} onChanged={reloadMqtt} />
          ) : (
            mqttRes.error && (
              <Card className="nt-card nt-full">
                <InlineError message={mqttRes.error.message} onRetry={mqttRes.reload} />
              </Card>
            )
          )}
        </div>
      )}
    </div>
  );
}
