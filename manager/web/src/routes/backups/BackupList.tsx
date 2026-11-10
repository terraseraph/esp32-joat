import type { DeviceSummary } from "@shared/api";
import { Download, Trash2 } from "lucide-react";
import { backupDownloadUrl, type BackupMeta } from "../../api/backups";
import { Button, buttonClass } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { cx } from "../../lib/cx";
import { countsText, formatTaken, gapCountLabel, gapLabel } from "./labels";

export interface BackupListProps {
  backups: readonly BackupMeta[];
  /** Devices by id, to tell which sources are offline right now. */
  devices: Readonly<Record<string, DeviceSummary>>;
  onView(b: BackupMeta): void;
  onRestore(b: BackupMeta): void;
  onDelete(b: BackupMeta): void;
}

function Gaps({ gaps }: { gaps: string[] }) {
  if (gaps.length === 0) return <Chip tone="ok">No gaps</Chip>;
  return (
    <details className="gaps">
      <summary>
        <Chip tone="warn">{gapCountLabel(gaps.length)}</Chip>
      </summary>
      <ul>
        {gaps.map((g) => (
          <li key={g}>{gapLabel(g)}</li>
        ))}
      </ul>
    </details>
  );
}

export function BackupList({ backups, devices, onView, onRestore, onDelete }: BackupListProps) {
  return (
    <div className="table-wrap">
      <table className="table bk-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Taken</th>
            <th>Firmware</th>
            <th>Contents</th>
            <th>Gaps</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {backups.map((b) => {
            const live = devices[b.source.id];
            const offline = live !== undefined && live.health !== "online";
            const title = b.name || b.source.name || b.source.id;
            return (
              <tr key={b.id} className={cx(offline && "is-offline")}>
                <td className="bk-c-device">
                  <span className="cell-main" title={title}>{title}</span>
                  <span className="cell-sub">
                    {b.source.id}
                    {offline ? " · offline now" : ""}
                  </span>
                  {b.note && <span className="bk-note">{b.note}</span>}
                </td>
                <td data-label="Taken">{formatTaken(b.createdAt)}</td>
                <td data-label="Firmware">{b.source.app_version ? <Chip mono>{b.source.app_version}</Chip> : <span className="mut">-</span>}</td>
                <td data-label="Contents">{countsText(b.counts)}</td>
                <td data-label="Gaps">
                  <Gaps gaps={b.gaps} />
                </td>
                <td className="bk-c-actions">
                  <div className="actions bk-actions">
                    <Button size="sm" onClick={() => onView(b)} aria-label={`View backup of ${title}`}>
                      View
                    </Button>
                    <a className={buttonClass({ size: "sm" })} href={backupDownloadUrl(b.id)} download aria-label={`Download backup of ${title}`}>
                      <Download className="i sm" aria-hidden="true" />
                      Download
                    </a>
                    <Button size="sm" onClick={() => onRestore(b)} aria-label={`Restore backup of ${title} to other devices`} title={offline ? `${title} is offline, but this backup can still be restored to other devices` : undefined}>
                      Restore to…
                    </Button>
                    <Button size="sm" variant="ghost" iconOnly aria-label={`Delete backup of ${title}`} onClick={() => onDelete(b)}>
                      <Trash2 className="i sm" aria-hidden="true" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
