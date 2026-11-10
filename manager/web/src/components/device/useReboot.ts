import { useCallback } from "react";
import { sendCommand } from "../../api/commands";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";

/**
 * Confirm, then send `system.reboot` (the Manager maps the dropped connection to `{expectedRestart:true}`
 * and the device's health becomes `rebooting`). A device error is shown verbatim inside the dialog.
 */
export function useReboot(id: string, name: string): () => Promise<boolean> {
  const confirm = useConfirm();
  const toast = useToast();
  return useCallback(async () => {
    const ok = await confirm({
      title: `Reboot ${name}?`,
      body: "It will be offline for about 10 seconds.",
      confirmLabel: "Reboot",
      run: async () => {
        await sendCommand(id, { cmd: "system.reboot" });
      },
    });
    if (ok) toast({ tone: "info", title: `Restarting ${name}…` });
    return ok;
  }, [confirm, toast, id, name]);
}
