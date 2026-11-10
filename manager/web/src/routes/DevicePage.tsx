import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import { Archive, Cpu, Download, ExternalLink, Power, RefreshCw } from "lucide-react";
import { Navigate, useParams } from "react-router";
import { refreshDevice, useDevice } from "../api/devices";
import { revalidateDevice } from "../api/useApi";
import { DeviceBanners } from "../components/device/DeviceBanners";
import { DeviceChips } from "../components/device/DeviceChips";
import { DeviceHeader, type DeviceAction } from "../components/device/DeviceHeader";
import { DeviceHeaderSkeleton } from "../components/device/DeviceHeaderSkeleton";
import { DEVICE_TABS, DeviceTabs, isDeviceTab, type DeviceTabSlug } from "../components/device/DeviceTabs";
import { useReboot } from "../components/device/useReboot";
import { RouteTransition } from "../components/shell/RouteTransition";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { errorMessage } from "../components/ui/InlineError";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/ui/Toast";
import { deviceSubtitle, deviceTitle } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useBackupNow } from "./backups/useBackupNow";
import { LiveTab } from "./device/live/LiveTab";
import { NetworkTab } from "./device/network/NetworkTab";
import { PinsTab } from "./device/pins/PinsTab";
import { SystemTab } from "./device/system/SystemTab";
import { UpdateSheet } from "./device/system/UpdateSheet";

const TAB_COMPONENTS: Record<DeviceTabSlug, ComponentType<{ id: string }>> = {
  live: LiveTab,
  pins: PinsTab,
  network: NetworkTab,
  system: SystemTab,
};

/** `/devices/:id/*`: persistent header + device-level states + tabs, with the tab content cross-fading underneath. */
export function DevicePage() {
  // Read the route from params (not useLocation) so this stays correct while the page fades out.
  const { id = "", "*": splat = "" } = useParams();
  const tab = splat.split("/")[0];
  const { summary, loaded, notFound } = useDevice(id);
  const toast = useToast();
  const title = summary ? deviceTitle(summary) : id;
  useDocumentTitle(title);

  // A restart that ends with the device online again: toast, and ask the open tab to re-read its resources IN PLACE.
  // The tab is never remounted for this (a remount would close any open dialog or sheet and reset its state).
  const health = summary?.health;
  const prev = useRef({ id, health });
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  });
  useEffect(() => {
    const was = prev.current;
    prev.current = { id, health };
    if (was.id === id && was.health === "rebooting" && health === "online") {
      toast({ tone: "ok", title: `${titleRef.current} is back online` });
      revalidateDevice(id);
    }
  }, [id, health, toast]);

  const [refreshing, setRefreshing] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const reboot = useReboot(id, title);
  const backupNow = useBackupNow();
  const [backingUp, setBackingUp] = useState(false);

  if (!isDeviceTab(tab)) return <Navigate to={`/devices/${encodeURIComponent(id)}/live`} replace />;
  const Panel = TAB_COMPONENTS[tab];
  const label = DEVICE_TABS.find((t) => t.slug === tab)?.label ?? "";

  if (notFound) {
    return (
      <EmptyState
        icon={Cpu}
        title="This device is not in your fleet"
        action={
          <ButtonLink to="/" variant="primary">
            Back to Fleet
          </ButtonLink>
        }
      >
        Nothing with this id is registered in the Manager. It may have been forgotten; add it again from Discover.
      </EmptyState>
    );
  }

  if (!loaded || !summary) {
    return (
      <>
        <DeviceHeaderSkeleton />
        <DeviceTabs id={id} />
        <Skeleton variant="block" height={160} />
      </>
    );
  }

  const actions: DeviceAction[] = [
    { key: "page", label: "Open device page", icon: ExternalLink, href: `http://${summary.host}/` },
    {
      key: "refresh",
      label: "Refresh",
      icon: RefreshCw,
      pending: refreshing,
      onSelect: () => {
        setRefreshing(true);
        refreshDevice(id)
          .catch((err: unknown) => toast({ tone: "bad", title: "Could not refresh", description: errorMessage(err) }))
          .finally(() => setRefreshing(false));
      },
    },
    {
      key: "backup",
      label: "Back up",
      icon: Archive,
      pending: backingUp,
      disabled: summary.health !== "online",
      tooltip: summary.health === "online" ? "Save this device's pins, add-ons and rules on this PC" : "A backup reads the live device, so it has to be online",
      onSelect: () => {
        setBackingUp(true);
        void backupNow([summary]).finally(() => setBackingUp(false));
      },
    },
    {
      key: "update",
      label: "Update",
      icon: Download,
      primary: true,
      disabled: summary.health !== "online" && summary.health !== "updating",
      tooltip: summary.health === "online" || summary.health === "updating" ? "Install a firmware image on this device" : "A firmware update needs the device to be online",
      onSelect: () => setUpdateOpen(true),
    },
    { key: "reboot", label: "Reboot", icon: Power, disabled: summary.health === "rebooting", onSelect: () => void reboot() },
  ];

  return (
    <>
      <DeviceHeader title={title} subtitle={deviceSubtitle(summary)} chips={<DeviceChips summary={summary} />} actions={actions} />
      <DeviceBanners summary={summary} />
      <UpdateSheet deviceId={id} open={updateOpen} onOpenChange={setUpdateOpen} />
      <DeviceTabs id={id} />
      <RouteTransition routeKey={tab}>
        <div className="tab-panel" role="region" aria-label={label}>
          <Panel id={id} />
        </div>
      </RouteTransition>
    </>
  );
}
