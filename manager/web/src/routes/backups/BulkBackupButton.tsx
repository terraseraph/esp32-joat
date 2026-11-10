import type { DeviceSummary } from "@shared/api";
import { Archive } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { useBackupNow } from "./useBackupNow";

/** "Back up" in the Fleet bulk bar: backs up the selected devices and toasts the result. */
export function BulkBackupButton({ devices, disabled }: { devices: readonly DeviceSummary[]; disabled?: boolean }) {
  const backupNow = useBackupNow();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await backupNow(devices);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" onClick={() => void run()} disabled={disabled || busy || devices.length === 0} aria-busy={busy || undefined}>
      {busy ? <Spinner /> : <Archive className="i sm" aria-hidden="true" />}
      Back up
    </Button>
  );
}
