import { Archive, Copy, Upload } from "lucide-react";
import { useState } from "react";
import { deleteBackup, useBackups, type BackupMeta } from "../api/backups";
import { useDevices } from "../api/devices";
import { useJobs } from "../api/jobs";
import { JobProgress } from "../components/jobs/JobProgress";
import { Banner, Button, Card, EmptyState, InlineError, PageHeader, Select, Skeleton, useConfirm, useToast } from "../components/ui";
import { BackupDetail } from "./backups/BackupDetail";
import { BackupList } from "./backups/BackupList";
import { BackupNowSheet } from "./backups/BackupNowSheet";
import { BackupWizard, type WizardStart } from "./backups/BackupWizard";
import { ImportDialog } from "./backups/ImportDialog";
import "./backups/backups.css";

type Dialog = { kind: "backup" } | { kind: "import" } | { kind: "detail"; meta: BackupMeta } | { kind: "wizard"; start: WizardStart };

/** `/backups`: saved device setups, with Back up, Import, Restore and Clone. */
export function BackupsPage() {
  const { list, loaded, error, reload } = useBackups();
  const { list: devices } = useDevices();
  const { jobs: running } = useJobs({ kind: "backup-apply", active: true });
  const confirm = useConfirm();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useState("all");

  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
  const sources = [...new Map(list.map((b) => [b.source.id, b.name || b.source.name || b.source.id])).entries()];
  const activeFilter = sources.some(([id]) => id === filter) ? filter : "all";
  const shown = activeFilter === "all" ? list : list.filter((b) => b.source.id === activeFilter);
  const close = () => setDialog(null);

  const remove = (b: BackupMeta) => {
    const title = b.name || b.source.name || b.source.id;
    void confirm({
      title: "Delete this backup?",
      body: <p>The saved backup of {title} is removed from this PC. The device isn't touched. Download it first if you may need it again.</p>,
      confirmLabel: "Delete backup",
      tone: "danger",
      run: () => deleteBackup(b.id),
    });
  };

  let body;
  if (!loaded && error) {
    body = (
      <Banner tone="bad" title="Could not load your backups">
        <InlineError message={error.message} onRetry={() => void reload()} />
      </Banner>
    );
  } else if (!loaded) {
    body = <Skeleton variant="block" height={160} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={Archive}
        title="No backups yet"
        action={
          <div className="actions">
            <Button variant="primary" onClick={() => setDialog({ kind: "backup" })}>
              Back up devices…
            </Button>
            <Button onClick={() => setDialog({ kind: "import" })}>Import file…</Button>
          </div>
        }
      >
        Back up a device to keep its pins, add-ons, rules and MQTT broker. You can restore them later or copy them to other devices.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {sources.length > 1 && (
          <div className="bk-filter">
            <label htmlFor="bk-filter" className="mut">
              Show
            </label>
            <Select id="bk-filter" value={activeFilter} onChange={setFilter} options={[{ value: "all", label: "All devices" }, ...sources.map(([id, name]) => ({ value: id, label: name }))]} />
          </div>
        )}
        <BackupList
          backups={shown}
          devices={byId}
          onView={(meta) => setDialog({ kind: "detail", meta })}
          onRestore={(backup) => setDialog({ kind: "wizard", start: { mode: "restore", backup } })}
          onDelete={remove}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Backups"
        description="Save a device's setup and copy it to others"
        actions={
          <>
            <Button variant="primary" onClick={() => setDialog({ kind: "backup" })}>
              <Archive className="i" aria-hidden="true" />
              Back up devices…
            </Button>
            <Button onClick={() => setDialog({ kind: "import" })}>
              <Upload className="i" aria-hidden="true" />
              Import file…
            </Button>
            <Button onClick={() => setDialog({ kind: "wizard", start: { mode: "clone" } })}>
              <Copy className="i" aria-hidden="true" />
              Clone a device…
            </Button>
          </>
        }
      />
      <div className="stack">
        <Banner tone="info" title="What a backup can and can't hold.">
          Devices have no export command, so the Manager reads pins, add-ons and rules from the live device. Wi-Fi details and MQTT logins can't be read back and are never included. Every backup lists its gaps.
        </Banner>

        {dialog?.kind !== "wizard" && running.map((job) => (
          <Card key={job.id}>
            <JobProgress job={job} />
          </Card>
        ))}

        {body}
      </div>

      {dialog?.kind === "backup" && <BackupNowSheet onClose={close} />}
      {dialog?.kind === "import" && (
        <ImportDialog
          onClose={close}
          onImported={(meta) => {
            close();
            toast({ tone: "ok", title: `Imported the backup of ${meta.name || meta.source.name}` });
          }}
        />
      )}
      {dialog?.kind === "detail" && <BackupDetail meta={dialog.meta} onClose={close} onRestore={(backup) => setDialog({ kind: "wizard", start: { mode: "restore", backup } })} />}
      {dialog?.kind === "wizard" && <BackupWizard start={dialog.start} onClose={close} />}
    </>
  );
}
