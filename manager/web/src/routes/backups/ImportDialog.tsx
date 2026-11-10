import { AlertTriangle, Upload } from "lucide-react";
import { useState, type DragEvent } from "react";
import { importBackup, type BackupMeta } from "../../api/backups";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { errorMessage } from "../../components/ui/InlineError";
import { cx } from "../../lib/cx";

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

/** Checks the file before it is sent: it must be JSON and say what it is. The server validates everything else. */
export function parseBackupFile(text: string): { ok: true; file: unknown } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file isn't valid JSON, so it can't be a backup." };
  }
  const kind = typeof parsed === "object" && parsed !== null ? (parsed as { kind?: unknown }).kind : undefined;
  if (kind !== "de-esp32-backup") return { ok: false, message: "This file isn't a de-esp32 backup (missing kind: de-esp32-backup)." };
  return { ok: true, file: parsed };
}

/** "Import file…": pick or drop a backup .json exported from this or another Manager. */
export function ImportDialog({ onClose, onImported }: { onClose(): void; onImported(meta: BackupMeta): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (f: File | null | undefined) => {
    setFile(f ?? null);
    setError(null);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const checked = parseBackupFile(await readText(file));
      if (!checked.ok) {
        setError(checked.message);
        return;
      }
      onImported(await importBackup(checked.file));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Import a backup file"
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            Import
          </Button>
        </>
      }
    >
      <label
        className={cx("dropzone", over && "over")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Upload className="i" aria-hidden="true" />
        <strong>{file ? file.name : "Drop a backup .json here"}</strong>
        <span className="mut">{file ? "Choose a different file" : "or choose a file"}</span>
        <input type="file" accept="application/json,.json" aria-label="Backup file" onChange={(e) => choose(e.target.files?.[0])} />
      </label>
      <div className="hint">Files exported with Download JSON from this or another Manager.</div>
      {error && (
        <div className="field err">
          <div className="msg" role="alert">
            <AlertTriangle className="i sm" aria-hidden="true" />
            {error}
          </div>
        </div>
      )}
    </Dialog>
  );
}
