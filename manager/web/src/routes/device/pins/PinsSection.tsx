import type { Hardware, HardwarePin, HeaderPad, IoState, RuleList } from "@shared/device-api";
import { useMemo, useState } from "react";
import { refreshDevice, useDevice } from "../../../api/devices";
import { useDeviceCommandResult, useDeviceResource, usePinConfig } from "../../../api/commands";
import { useDeviceLive } from "../../../api/live";
import { Banner, Button, Card, InlineError, Skeleton } from "../../../components/ui";
import { formatAgo } from "../../../lib/format";
import { PinList, countUses } from "./PinList";
import { PinSheet } from "./PinSheet";
import { Pinout, PinoutLegend } from "./Pinout";
import { pinUse, type LiveIo, type PinFilter, type PinUse } from "./pinLogic";
import "./pins.css";

const UNREACHABLE = new Set(["offline", "unreachable", "rebooting", "updating"]);

function PinsSkeleton() {
  return (
    <div className="pins-grid" aria-busy="true" aria-label="Loading pins">
      <Card>
        <Skeleton variant="title" />
        <Skeleton variant="block" height={360} />
      </Card>
      <Card>
        <Skeleton variant="title" />
        <Skeleton variant="block" />
        <Skeleton variant="block" />
        <Skeleton variant="block" />
      </Card>
    </div>
  );
}

/** Pinout, pin list and pin sheet of a device ("Pins" part of the Pins & add-ons tab). */
export function PinsSection({ id }: { id: string }) {
  const hardware = useDeviceResource<Hardware>(id, "hardware");
  const pinConfig = usePinConfig(id);
  const rules = useDeviceCommandResult<RuleList>(id, { cmd: "rule.list" });
  const live = useDeviceLive(id);
  const { summary } = useDevice(id);

  const [filter, setFilter] = useState<PinFilter>("all");
  const [selected, setSelected] = useState<number | null>(null);
  const [sheet, setSheet] = useState<{ gpio: number; n: number; open: boolean } | null>(null);

  const hw = hardware.data;
  const offline = Boolean(summary && UNREACHABLE.has(summary.health));
  const safeMode = summary?.safe_mode === true;

  const maps = useMemo(() => {
    const pinsByGpio = new Map<number, HardwarePin>();
    const padsByGpio = new Map<number, HeaderPad>();
    if (hw) {
      for (const p of hw.pins) pinsByGpio.set(p.gpio, p);
      for (const pad of [...hw.header.left, ...hw.header.right]) if (pad.gpio !== null) padsByGpio.set(pad.gpio, pad);
    }
    return { pinsByGpio, padsByGpio };
  }, [hw]);

  const cfgByGpio = useMemo(() => new Map((pinConfig.data?.pins ?? []).map((e) => [e.gpio, e])), [pinConfig.data]);

  // Live I/O: from the WebSocket once hydrated, else from the `live` values of pin-config.
  const io: LiveIo = useMemo(() => {
    if (live.hydrated) return live.io;
    const seed: Record<string, IoState> = {};
    for (const e of pinConfig.data?.pins ?? []) {
      const key = typeof e.live?.id === "string" ? e.live.id : null;
      if (key && e.live) seed[key] = e.live as unknown as IoState;
    }
    return seed;
  }, [live.hydrated, live.io, pinConfig.data]);

  const uses = useMemo(() => {
    const m = new Map<number, PinUse>();
    for (const p of maps.pinsByGpio.values()) m.set(p.gpio, pinUse(p, cfgByGpio.get(p.gpio), io));
    return m;
  }, [maps.pinsByGpio, cfgByGpio, io]);

  const counts = useMemo(() => {
    let configured = 0;
    let addons = 0;
    for (const u of uses.values()) {
      if (u.kind === "mode") configured++;
      else if (u.kind === "addon" || u.kind === "bus") addons++;
    }
    return { configured, addons, free: countUses(uses.values()).free };
  }, [uses]);

  const reloadAll = () => {
    hardware.reload();
    pinConfig.reload();
    rules.reload();
  };

  const retryOffline = () => {
    void refreshDevice(id)
      .catch(() => undefined)
      .finally(reloadAll);
  };

  const select = (gpio: number) => {
    setSelected(gpio);
    setSheet((s) => ({ gpio, n: (s?.n ?? 0) + 1, open: true }));
  };

  const goToAddons = () => {
    setSheet((s) => (s ? { ...s, open: false } : s));
    document.getElementById("sec-addons")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sheetPin = sheet ? maps.pinsByGpio.get(sheet.gpio) : undefined;

  let body;
  if (hardware.loading && !hw) body = <PinsSkeleton />;
  else if (!hw) {
    body = (
      <Card>
        <InlineError message={hardware.error?.message ?? "Could not load the pin layout."} onRetry={hardware.reload} />
        {offline && <p className="mut">The device is offline, so its pin layout is not available yet.</p>}
      </Card>
    );
  } else {
    body = (
      <div className="pins-wrap">
        <div className="pins-grid">
          <Card aria-labelledby="pinout-h">
            <div className="card-head">
              <h3 id="pinout-h">{hw.board_name || "Board"} pinout</h3>
              <span className="mut">USB at the bottom · click a pad</span>
            </div>
            <Pinout hardware={hw} pinsByGpio={maps.pinsByGpio} uses={uses} selected={selected} onSelect={select} disabled={offline} />
            <PinoutLegend />
            <p className="hint">OUT output · IN input · PWM · SRV servo · ADC analog. Pins that are not on the header are listed on the right.</p>
          </Card>
          <Card aria-labelledby="plist-h">
            <PinList hardware={hw} padsByGpio={maps.padsByGpio} uses={uses} io={io} filter={filter} onFilter={setFilter} selected={selected} onSelect={select} disabled={offline} />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <section className="pins-sec" id="sec-pins" aria-labelledby="pins-h">
      <div className="sec-head">
        <h2 id="pins-h">Pins</h2>
        {hw && (
          <span className="sub">
            {counts.configured} configured · {counts.addons} used by add-ons · {counts.free} free
          </span>
        )}
      </div>

      {offline && (
        <Banner
          tone="warn"
          title="This device is offline"
          action={
            <Button size="sm" onClick={retryOffline}>
              Retry
            </Button>
          }
        >
          Showing the last pin layout the Manager loaded. Editing is disabled until the device is back. Last seen {formatAgo(summary?.lastSeen)}.
        </Banner>
      )}
      {safeMode && (
        <Banner tone="warn" title="Safe mode">
          The device did not apply its saved pin settings{summary?.safe_reason ? ` (${summary.safe_reason})` : ""}, so pins may not behave as configured. You can still change them here.
        </Banner>
      )}
      {pinConfig.error && hw && <InlineError message={pinConfig.error.message} onRetry={pinConfig.reload} />}

      {body}

      {hw && sheetPin && sheet && (
        <PinSheet
          key={`${sheet.gpio}:${sheet.n}`}
          id={id}
          pin={sheetPin}
          pad={maps.padsByGpio.get(sheet.gpio)}
          hardware={hw}
          entry={cfgByGpio.get(sheet.gpio)}
          rules={rules.data?.rules ?? null}
          open={sheet.open}
          onOpenChange={(open) => setSheet((s) => (s ? { ...s, open } : s))}
          blockedReason={offline ? "This device is offline. Reconnect it to save changes." : null}
          onSaved={reloadAll}
          onGoToAddons={goToAddons}
        />
      )}
    </section>
  );
}
