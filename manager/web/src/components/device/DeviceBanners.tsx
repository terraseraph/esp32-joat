import type { DeviceSummary } from "@shared/api";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { refreshDevice } from "../../api/devices";
import { useSetupAdapter } from "../../api/setup";
import { formatAgo } from "../../lib/format";
import { SetupFlow, setupApSsid } from "../../routes/discover/setup";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { errorMessage } from "../ui/InlineError";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import "./deviceShell.css";

export interface DeviceBannerSpec {
  key: string;
  node: ReactNode;
}

/** Which device-level banners apply (pure, for tests). Order = display order. */
export function deviceBannerKeys(s: Pick<DeviceSummary, "health" | "safe_mode" | "attention">): Array<"offline" | "rebooting" | "safe" | "mismatch"> {
  const keys: Array<"offline" | "rebooting" | "safe" | "mismatch"> = [];
  if (s.health === "offline" || s.health === "unreachable") keys.push("offline");
  if (s.health === "rebooting") keys.push("rebooting");
  if (s.safe_mode === true || s.attention.includes("safe_mode")) keys.push("safe");
  if (s.attention.includes("host_mismatch")) keys.push("mismatch");
  return keys;
}

function Retry({ id }: { id: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        refreshDevice(id)
          .catch((err: unknown) => toast({ tone: "bad", title: "Could not refresh", description: errorMessage(err) }))
          .finally(() => setBusy(false));
      }}
    >
      {busy && <Spinner />}
      Retry
    </Button>
  );
}

/** "Recover over its setup Wi-Fi": only offered when this PC can join a device's Setup AP. Opens the setup flow in recover mode. */
function RecoverButton({ id }: { id: string }) {
  const { adapter } = useSetupAdapter();
  const [open, setOpen] = useState(false);
  if (!adapter?.supported) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Recover over its setup Wi-Fi
      </Button>
      {open && <SetupFlow target={{ ssid: setupApSsid(id), deviceId: id }} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Device-level states shown above the tabs; they apply to every tab. Banners animate their height. */
export function DeviceBanners({ summary }: { summary: DeviceSummary }) {
  const keys = deviceBannerKeys(summary);
  const name = summary.label || summary.name || summary.hostname || summary.id;
  const nodes: Record<string, ReactNode> = {
    offline: (
      <Banner
        tone="warn"
        action={
          <span className="dev-banner-acts">
            <Retry id={summary.id} />
            <RecoverButton id={summary.id} />
          </span>
        }
      >
        Can't reach this device. Last seen {formatAgo(summary.lastSeen)}.
      </Banner>
    ),
    rebooting: (
      <Banner tone="info">
        <span className="dev-rebooting">
          <Spinner label="Restarting" />
          Restarting… waiting for {name} to come back
        </span>
      </Banner>
    ),
    safe: (
      <Banner tone="bad" title="Safe mode: the I/O configuration was not applied">
        {summary.safe_reason ? <span className="mono">{summary.safe_reason}</span> : "The device started with all pins in a safe state."}
      </Banner>
    ),
    mismatch: (
      <Banner tone="warn" title="Another device answers at this address">
        The Manager reaches {summary.host}, but a different device replies there. Its values are not shown here.
      </Banner>
    ),
  };
  return (
    <div className="dev-banners">
      <AnimatePresence initial={false}>
        {keys.map((k) => (
          <motion.div
            key={k}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="dev-banner-inner">{nodes[k]}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
