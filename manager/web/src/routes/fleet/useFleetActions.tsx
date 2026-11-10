import type { DeviceSummary } from "@shared/api";
import { useMemo } from "react";
import { forgetDevice, refreshDevice } from "../../api/devices";
import { sendCommand } from "../../api/commands";
import { errorMessage, useConfirm, useToast } from "../../components/ui";
import { deviceTitle } from "../../lib/format";
import { nameList } from "./logic";

export interface FleetActions {
  /** Poll now. Failures are toasted. */
  refresh(list: readonly DeviceSummary[]): Promise<void>;
  /** Confirm, then `system.reboot` on each device in parallel. Resolves true when confirmed. */
  reboot(list: readonly DeviceSummary[]): Promise<boolean>;
  /** Confirm, then remove from this Manager (the device is not changed). */
  forget(list: readonly DeviceSummary[]): Promise<boolean>;
}

interface Failure {
  name: string;
  message: string;
}

/** Run `fn` for every device in parallel and collect what failed (nothing throws). */
async function runAll(list: readonly DeviceSummary[], fn: (d: DeviceSummary) => Promise<unknown>): Promise<Failure[]> {
  const results = await Promise.allSettled(list.map(fn));
  const failures: Failure[] = [];
  results.forEach((r, i) => {
    const d = list[i];
    if (r.status === "rejected" && d) failures.push({ name: deviceTitle(d), message: errorMessage(r.reason) });
  });
  return failures;
}

const describeFailures = (f: Failure[]) => f.map((x) => `${x.name}: ${x.message}`).join("\n");

export function useFleetActions(): FleetActions {
  const confirm = useConfirm();
  const toast = useToast();

  return useMemo<FleetActions>(() => {
    const refresh = async (list: readonly DeviceSummary[]) => {
      const failures = await runAll(list, (d) => refreshDevice(d.id));
      if (failures.length) {
        toast({
          tone: "bad",
          title: list.length === 1 ? `Could not refresh ${failures[0]?.name ?? "the device"}` : `Could not refresh ${failures.length} of ${list.length} devices`,
          description: describeFailures(failures),
        });
      }
    };

    const reboot = (list: readonly DeviceSummary[]) => {
      const one = list.length === 1;
      return confirm({
        title: one ? `Reboot ${deviceTitle(list[0] as DeviceSummary)}?` : `Reboot ${list.length} devices?`,
        body: (
          <>
            <p>{one ? "It restarts now and is back in a few seconds." : "They restart now and are back in a few seconds."}</p>
            {!one && <p className="mut">{nameList(list, 8)}</p>}
          </>
        ),
        confirmLabel: one ? "Reboot" : `Reboot ${list.length}`,
        tone: "danger",
        run: async () => {
          const failures = await runAll(list, (d) => sendCommand(d.id, { cmd: "system.reboot" }));
          if (failures.length === list.length && one) throw new Error(failures[0]?.message ?? "Reboot failed");
          if (failures.length) {
            toast({
              tone: failures.length === list.length ? "bad" : "warn",
              title: `${list.length - failures.length} restarting, ${failures.length} failed`,
              description: describeFailures(failures),
            });
          } else {
            toast({ tone: "ok", title: one ? `Restarting ${deviceTitle(list[0] as DeviceSummary)}` : `Restarting ${list.length} devices` });
          }
        },
      });
    };

    const forget = (list: readonly DeviceSummary[]) => {
      const one = list.length === 1;
      return confirm({
        title: one ? `Forget ${deviceTitle(list[0] as DeviceSummary)}?` : `Forget ${list.length} devices?`,
        body: (
          <>
            <p>Forget only removes it from this Manager; the device is not changed. You can add it again from Discover.</p>
            {!one && <p className="mut">{nameList(list, 8)}</p>}
          </>
        ),
        confirmLabel: one ? "Forget" : `Forget ${list.length}`,
        tone: "danger",
        run: async () => {
          const failures = await runAll(list, (d) => forgetDevice(d.id));
          if (failures.length === list.length && one) throw new Error(failures[0]?.message ?? "Could not forget the device");
          if (failures.length) {
            toast({ tone: "warn", title: `Forgot ${list.length - failures.length}, ${failures.length} failed`, description: describeFailures(failures) });
          }
        },
      });
    };

    return { refresh, reboot, forget };
  }, [confirm, toast]);
}
