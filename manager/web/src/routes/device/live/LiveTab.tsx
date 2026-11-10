import type { DeviceHealth, LinkState } from "@shared/api";
import type { DeviceStatus, ModuleList, RuleList } from "@shared/device-api";
import { ListChecks, RefreshCw, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDevice, refreshDevice } from "../../../api/devices";
import { asCommandError, deviceGet, sendCommand, useDeviceCommandResult } from "../../../api/commands";
import { liveStore, seedLiveIo, useDeviceLive } from "../../../api/live";
import { Banner, Button, ButtonLink, Chip, EmptyState, errorMessage, InlineError, Skeleton, useToast, type Tone } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { formatAgo, formatRssi } from "../../../lib/format";
import { LiveTile, type SetPin } from "./Tiles";
import { adoptedState, buildTiles, pinSetBody } from "./model";
import "./live.css";

const FROZEN: ReadonlySet<DeviceHealth> = new Set<DeviceHealth>(["offline", "unreachable", "rebooting", "updating"]);

function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function linkChip(link: LinkState, wasOpen: boolean): { tone: Tone; label: string; pulse: boolean } {
  switch (link) {
    case "open":
      return { tone: "ok", label: "Live", pulse: true };
    case "full":
      return { tone: "warn", label: "WS full · polling every 5 s", pulse: false };
    case "connecting":
      return { tone: "warn", label: wasOpen ? "Reconnecting…" : "Connecting", pulse: false };
    default:
      return { tone: "off", label: "Not live", pulse: false };
  }
}

function TileSkeletons() {
  return (
    <div className="grid" style={{ "--min": "190px" } as React.CSSProperties} aria-busy="true" aria-label="Loading live values">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="tile live-skel">
          <Skeleton variant="line" width="45%" />
          <Skeleton variant="title" width="35%" />
          <Skeleton variant="line" width="60%" />
        </div>
      ))}
    </div>
  );
}

/** Device · Live: tiles per configured channel, driven by the live WebSocket (spec 4.4 item 3). */
export function LiveTab({ id }: { id: string }) {
  const { summary } = useDevice(id);
  const live = useDeviceLive(id);
  const toast = useToast();
  const now = useNow();

  // Seed from REST so tiles render before the WS snapshot arrives.
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedNonce, setSeedNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    deviceGet<DeviceStatus>(id, "status")
      .then((s) => {
        if (!alive) return;
        setSeedError(null);
        seedLiveIo(id, s.io ?? {});
      })
      .catch((err: unknown) => alive && setSeedError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [id, seedNonce]);

  const rules = useDeviceCommandResult<RuleList>(id, { cmd: "rule.list" });
  const modules = useDeviceCommandResult<ModuleList>(id, { cmd: "module.list" });

  const [wasOpen, setWasOpen] = useState(false);
  if (live.link === "open" && !wasOpen) setWasOpen(true);

  const groups = useMemo(() => buildTiles(live.io, rules.data?.rules ?? [], modules.data?.modules ?? []), [live.io, rules.data, modules.data]);

  const health = summary?.health;
  const frozen = health !== undefined && FROZEN.has(health);
  const safeMode = summary?.safe_mode === true;
  const disabled = frozen || safeMode;

  const setPin: SetPin = useCallback(
    async (kind, gpio, value) => {
      try {
        await sendCommand(id, pinSetBody(kind, gpio, value));
      } catch (err) {
        toast({ tone: "bad", title: `Couldn't set GPIO ${gpio}`, description: asCommandError(err).message });
        return false;
      }
      // Adopt the device's value right away; its own `io` frame confirms it.
      const key = `${kind === "out" ? "gpio" : kind}_${gpio}`;
      liveStore.set((all) => {
        const cur = all[id];
        const st = cur?.io[key];
        if (!cur || !st) return all;
        return { ...all, [id]: { ...cur, io: { ...cur.io, [key]: adoptedState(st, value) } } };
      });
      return true;
    },
    [id, toast],
  );

  const chip = linkChip(live.link, wasOpen);
  const rssi = live.telemetry?.network.rssi ?? summary?.rssi ?? null;
  const mqttConnected = live.telemetry?.mqtt.connected ?? summary?.mqtt.connected ?? null;
  const mqttConfigured = summary?.mqtt.configured ?? (mqttConnected === null ? null : true);
  const pressure = live.telemetry?.memory.pressure ?? summary?.memory.pressure ?? null;
  const updated = live.lastEventAt !== null ? formatAgo(new Date(live.lastEventAt).toISOString(), now) : null;

  const strip = (
    <div className="livebar" role="status">
      <Chip tone={chip.tone} className={cx("live-chip", chip.pulse && "is-pulsing")}>
        {chip.label}
      </Chip>
      {frozen ? (
        <>
          <span className="mut">Last values {summary?.lastSeen ? formatAgo(summary.lastSeen, now) : "unknown"}</span>
          {health !== "rebooting" && health !== "updating" && (
            <Button size="sm" onClick={() => void refreshDevice(id).catch(() => undefined)}>
              <RefreshCw className="i sm" aria-hidden="true" /> Retry
            </Button>
          )}
        </>
      ) : (
        updated && <span className="mut">Updated {updated}</span>
      )}
      <span className="spacer" />
      <span className="chips">
        {rssi !== null && rssi !== 0 && (
          <Chip icon={Wifi} title="Signal strength measured when the device joined Wi-Fi">
            Wi-Fi {formatRssi(rssi).label}
          </Chip>
        )}
        {mqttConfigured === false ? (
          <Chip tone="off">MQTT not set up</Chip>
        ) : (
          mqttConnected !== null && <Chip tone={mqttConnected ? "ok" : "warn"}>{mqttConnected ? "MQTT connected" : "MQTT disconnected"}</Chip>
        )}
        {pressure && <Chip tone={pressure === "ok" ? "ok" : pressure === "warn" ? "warn" : "bad"}>Memory {pressure === "ok" ? "ok" : pressure === "warn" ? "low" : "critical"}</Chip>}
        {(summary?.queue ?? 0) > 0 && <Chip tone="acc">Device busy</Chip>}
      </span>
    </div>
  );

  let body;
  if (!live.hydrated) {
    body =
      seedError !== null ? (
        <div className="card">
          <InlineError message={seedError} onRetry={() => setSeedNonce((n) => n + 1)} />
        </div>
      ) : (
        <TileSkeletons />
      );
  } else if (groups.length === 0) {
    body = (
      <div className="card">
        <EmptyState
          icon={ListChecks}
          title={safeMode ? "Nothing is live in safe mode" : "No pins or add-ons set up yet"}
          action={
            <div className="actions">
              <ButtonLink to={`/devices/${encodeURIComponent(id)}/pins`} variant={safeMode ? undefined : "primary"}>
                {safeMode ? "Open Pins & add-ons" : "Set up pins"}
              </ButtonLink>
            </div>
          }
        >
          {safeMode
            ? "I/O config was not applied, so no pins or add-ons are running. Fix the cause, then reboot the device."
            : "This device has nothing to show live. Choose what each pin does and add sensors in Pins & add-ons."}
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <>
        {groups.map((g) => (
          <section key={g.id} className="group" aria-labelledby={`live-g-${g.id}`}>
            <h2 className="eyebrow" id={`live-g-${g.id}`}>
              {g.label}
            </h2>
            <div className="grid" style={{ "--min": g.id === "addon" ? "260px" : g.id === "pwm" || g.id === "servo" ? "230px" : "190px" } as React.CSSProperties}>
              {g.tiles.map((t) => (
                <LiveTile key={t.key} tile={t} disabled={disabled} frozen={frozen} setPin={setPin} />
              ))}
            </div>
          </section>
        ))}
        <p className="foot-note">
          Changes made here are not saved as the start-up value. Set that in Pins &amp; add-ons.
        </p>
      </>
    );
  }

  return (
    <div className="live-tab">
      {strip}
      {live.link === "full" && (
        <Banner tone="warn">This device already has 4 live viewers; updating every 5 s.</Banner>
      )}
      {safeMode && !frozen && live.hydrated && groups.length > 0 && (
        <p className="mut live-note">Controls are disabled: safe mode means the I/O config was not applied.</p>
      )}
      {body}
    </div>
  );
}
