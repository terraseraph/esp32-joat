import type { DeviceSummary } from "@shared/api";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { backupDevices } from "../../api/backups";
import { useToast } from "../../components/ui/Toast";
import { deviceTitle } from "../../lib/format";
import { backupErrorMessage, countsText } from "./labels";

/**
 * "Back up now" for the device header and the Fleet bulk bar: backs up the given devices, then toasts the result with a link to the
 * Backups screen. Resolves with the number of backups saved (failures are toasted, never thrown).
 */
export function useBackupNow(): (devices: readonly DeviceSummary[]) => Promise<number> {
  const toast = useToast();
  const navigate = useNavigate();
  return useCallback(
    async (devices) => {
      const outcomes = await backupDevices(devices.map((d) => ({ id: d.id, name: deviceTitle(d) })));
      const ok = outcomes.filter((o) => o.meta);
      const failed = outcomes.filter((o) => !o.meta);
      const action = { label: "View backups", onClick: () => navigate("/backups") };
      const failureText = failed.map((o) => (devices.length === 1 ? backupErrorMessage(o.error, o.name) : `${o.name}: ${backupErrorMessage(o.error, o.name)}`)).join("\n");

      if (failed.length === 0) {
        const first = ok[0]?.meta;
        toast({
          tone: "ok",
          title: ok.length === 1 ? `Backed up ${ok[0]?.name ?? "the device"}` : `Backed up ${ok.length} devices`,
          description: ok.length === 1 && first ? countsText(first.counts) : undefined,
          action,
        });
      } else if (ok.length === 0) {
        toast({ tone: "bad", title: devices.length === 1 ? `Could not back up ${failed[0]?.name ?? "the device"}` : `Could not back up ${failed.length} devices`, description: failureText });
      } else {
        toast({ tone: "warn", title: `Backed up ${ok.length} of ${devices.length} devices`, description: failureText, action });
      }
      return ok.length;
    },
    [toast, navigate],
  );
}
