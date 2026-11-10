import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { backupDownloadUrl, updateBackupNote, type BackupFile, type BackupMeta } from "../../api/backups";
import { useApi } from "../../api/useApi";
import { Banner } from "../../components/ui/Banner";
import { Button, buttonClass } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { InlineError, errorMessage } from "../../components/ui/InlineError";
import { Sheet } from "../../components/ui/Sheet";
import { Skeleton } from "../../components/ui/Skeleton";
import { formatTaken, gapCountLabel, gapLabel, modulePins, moduleSettings, mqttText, pinModeLabel, pinSettings, ruleText } from "./labels";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sect">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Contents({ file }: { file: BackupFile }) {
  return (
    <>
      <Section title="General">
        <dl className="kv">
          <dt>Device name</dt>
          <dd>{file.name}</dd>
          <dt>MQTT broker</dt>
          <dd className="mono">{mqttText(file)}</dd>
          {file.mqtt?.root !== undefined && (
            <>
              <dt>MQTT topic root</dt>
              <dd className="mono">{file.mqtt.root}</dd>
            </>
          )}
          <dt>Source device</dt>
          <dd className="mono">{[file.source.id, file.source.board_id].filter(Boolean).join(" · ")}</dd>
        </dl>
      </Section>

      <Section title="Pins">
        {file.pins.length === 0 ? (
          <p className="mut">No pins in this backup.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>GPIO</th>
                  <th>Mode</th>
                  <th>Settings</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {file.pins.map((p) => (
                  <tr key={p.gpio}>
                    <td className="num">{p.gpio}</td>
                    <td>{pinModeLabel(p.mode)}</td>
                    <td className="mut">{pinSettings(p) || "Default settings"}</td>
                    <td>{p._from === "shadow" ? <Chip tone="acc">set via the Manager</Chip> : <Chip>read from the device</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Add-ons">
        {file.modules.length === 0 ? (
          <p className="mut">No add-ons in this backup.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Add-on</th>
                  <th>Bus</th>
                  <th>Pins</th>
                  <th>Settings</th>
                </tr>
              </thead>
              <tbody>
                {file.modules.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="cell-main bk-min0">{m.id}</span>
                      <span className="cell-sub">{m.type}</span>
                    </td>
                    <td className="mono">{m.bus ?? "-"}</td>
                    <td className="mono">{modulePins(m) || "-"}</td>
                    <td className="mut">{moduleSettings(m) || "Default settings"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Rules">
        {file.rules.length === 0 ? (
          <p className="mut">No rules in this backup.</p>
        ) : (
          <ul className="bk-rules">
            {file.rules.map((r) => (
              <li key={r.id}>
                <Chip mono>{r.id}</Chip>
                <span>{ruleText(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {file.gaps.length > 0 && (
        <Banner tone="warn" title="Not included">
          <ul className="bk-gap-list">
            {file.gaps.map((g) => (
              <li key={g}>{gapLabel(g)}</li>
            ))}
          </ul>
        </Banner>
      )}
    </>
  );
}

function NoteEditor({ meta }: { meta: BackupMeta }) {
  const [value, setValue] = useState(meta.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [base, setBase] = useState(meta.note);
  const dirty = value.trim() !== base;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateBackupNote(meta.id, value.trim());
      setBase(updated.note);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <label htmlFor="bk-note">Note</label>
      <div className="row">
        <input
          id="bk-note"
          className="input bk-note-input"
          value={value}
          maxLength={200}
          placeholder="For example: before the rewiring"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          autoComplete="off"
        />
        <Button onClick={() => void save()} disabled={!dirty || busy} aria-busy={busy || undefined}>
          Save note
        </Button>
      </div>
      {saved && !dirty && (
        <div className="hint" role="status">
          Note saved.
        </div>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}

/** "View": everything a backup holds, what it can't hold, and a note you can edit. */
export function BackupDetail({ meta, onClose, onRestore }: { meta: BackupMeta; onClose(): void; onRestore(meta: BackupMeta): void }) {
  const { data, error, loading, reload } = useApi<BackupFile>(`/api/backups/${encodeURIComponent(meta.id)}`);
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={meta.name || meta.source.name}
      description={
        <>
          Backup taken {formatTaken(meta.createdAt)}
          {meta.source.app_version ? (
            <>
              {" "}
              · firmware <span className="mono">{meta.source.app_version}</span>
            </>
          ) : null}
        </>
      }
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button onClick={() => onRestore(meta)}>Restore to…</Button>
          <a className={buttonClass({ variant: "primary" })} href={backupDownloadUrl(meta.id)} download>
            <Download className="i" aria-hidden="true" />
            Download JSON
          </a>
        </>
      }
    >
      <div className="chips">
        <Chip>{meta.counts.pins === 1 ? "1 pin" : `${meta.counts.pins} pins`}</Chip>
        <Chip>{meta.counts.modules === 1 ? "1 add-on" : `${meta.counts.modules} add-ons`}</Chip>
        <Chip>{meta.counts.rules === 1 ? "1 rule" : `${meta.counts.rules} rules`}</Chip>
        <Chip tone={meta.gaps.length > 0 ? "warn" : "ok"}>{gapCountLabel(meta.gaps.length)}</Chip>
      </div>
      <NoteEditor meta={meta} />
      {loading && !data && <Skeleton variant="block" height={160} />}
      {error && !data && <InlineError message={error.message} onRetry={reload} />}
      {data && <Contents file={data} />}
    </Sheet>
  );
}
