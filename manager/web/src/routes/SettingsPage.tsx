import { useEffect } from "react";
import { healthStore, refreshHealth } from "../api/serverStatus";
import { useAccess, useSettings } from "../api/settings";
import { useStore } from "../api/store";
import { getBrowserWs } from "../api/ws";
import { Card } from "../components/ui/Card";
import { InlineError } from "../components/ui/InlineError";
import { PageHeader } from "../components/ui/PageHeader";
import { AboutCard, DataCard } from "./settings/AboutCard";
import { AccessCard } from "./settings/AccessCard";
import { AppearanceCard } from "./settings/AppearanceCard";
import { DevicesCard } from "./settings/DevicesCard";
import { FirmwareCard } from "./settings/FirmwareCard";
import "./settings/settings.css";

function SkeletonCard({ title }: { title: string }) {
  return (
    <Card aria-busy="true">
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <div className="stack" aria-label={`Loading ${title.toLowerCase()}`}>
        <span className="skeleton line" />
        <span className="skeleton line" />
        <span className="skeleton line" />
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const access = useAccess();
  const health = useStore(healthStore).health;

  useEffect(() => {
    void refreshHealth(); // version, data folder and start time for the cards below
  }, []);

  // Another browser (or the Manager PC) switched LAN access: re-read it.
  const reloadAccess = access.reload;
  useEffect(() => getBrowserWs().subscribe("access", () => reloadAccess()), [reloadAccess]);

  return (
    <>
      <PageHeader title="Settings" description="These apply to the Manager, not to your devices. Each section has its own Save." />
      <div className="settings-col">
        {settings.data ? (
          <>
            <DevicesCard settings={settings.data} onSave={settings.save} />
            <FirmwareCard settings={settings.data} onSave={settings.save} />
          </>
        ) : settings.loading ? (
          <>
            <SkeletonCard title="Devices and discovery" />
            <SkeletonCard title="Firmware" />
          </>
        ) : (
          <Card>
            <div className="card-head">
              <h2>Devices, discovery and firmware</h2>
            </div>
            <InlineError message={settings.error?.message ?? "Could not load settings."} onRetry={settings.reload} />
          </Card>
        )}
        <AppearanceCard />
        <AccessCard access={access} />
        <DataCard health={health} />
        <AboutCard health={health} />
      </div>
    </>
  );
}
