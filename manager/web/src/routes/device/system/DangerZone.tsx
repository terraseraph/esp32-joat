import { Power } from "lucide-react";
import { useState } from "react";
import { asCommandError, isExpectedRestart, sendCommand } from "../../../api/commands";
import { useReboot } from "../../../components/device/useReboot";
import { Button } from "../../../components/ui/Button";
import { Card, CardHead } from "../../../components/ui/Card";
import { Dialog } from "../../../components/ui/Dialog";
import { Field } from "../../../components/ui/Field";
import { InlineError } from "../../../components/ui/InlineError";
import { Spinner } from "../../../components/ui/Spinner";
import { TextInput } from "../../../components/ui/TextInput";
import { useToast } from "../../../components/ui/Toast";
import { markFactoryReset } from "./useSystemData";

export interface DangerZoneProps {
  id: string;
  /** Display title (for the reboot dialog and toast). */
  title: string;
  /** What the user types to confirm a factory reset: the device name, else its hostname. */
  confirmName: string;
  /** Wi-Fi network the device opens after a reset (its `ap_ssid`, else hostname). */
  apSsid: string;
  disabled: boolean;
}

function FactoryResetDialog({ open, onOpenChange, id, title, confirmName, apSsid }: Omit<DangerZoneProps, "disabled"> & { open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep(1);
      setTyped("");
      setError(null);
    }
  }
  const ready = typed.trim() === confirmName.trim() && confirmName.trim() !== "";

  const run = async () => {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await sendCommand(id, { cmd: "system.factory_reset" });
      markFactoryReset(id, { at: Date.now(), name: title, apSsid });
      toast({ tone: "info", title: `Factory reset sent to ${title}`, description: isExpectedRestart(res) ? "The device is restarting." : undefined });
      onOpenChange(false);
    } catch (err) {
      setError(asCommandError(err).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Factory reset ${title}?`}
      tone="danger"
      locked={pending}
      hideClose
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {step === 1 ? (
            <Button variant="danger" onClick={() => setStep(2)}>
              Continue
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void run()} disabled={!ready || pending} aria-busy={pending || undefined}>
              {pending && <Spinner />}
              Factory reset
            </Button>
          )}
        </>
      }
    >
      {step === 1 ? (
        <>
          <p>
            Erases Wi-Fi, pins, add-ons, rules, MQTT, name and the Setup AP password. The device leaves your network and reappears as Wi-Fi network <span className="mono">{apSsid}</span>.
          </p>
          <p className="mut">This can't be undone.</p>
        </>
      ) : (
        <>
          <p>Last check. This device will be erased and restarted.</p>
          <Field label={<>Type {confirmName} to confirm</>}>
            <TextInput
              value={typed}
              onChange={setTyped}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={pending}
            />
          </Field>
          {error && <InlineError message={error} />}
        </>
      )}
    </Dialog>
  );
}

export function DangerZone(props: DangerZoneProps) {
  const { id, title, disabled } = props;
  const reboot = useReboot(id, title);
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <Card className="danger" aria-labelledby="sys-dz-h">
      <CardHead title={<span id="sys-dz-h">Danger zone</span>} />
      <div className="dz-row">
        <div>
          <div className="strong">Reboot</div>
          <p className="mut">Restarts the device. It will be offline for about 10 seconds.</p>
        </div>
        <Button disabled={disabled} onClick={() => void reboot()}>
          <Power className="i" aria-hidden="true" />
          Reboot
        </Button>
      </div>
      <div className="dz-row">
        <div>
          <div className="strong">Factory reset</div>
          <p className="mut">Erases Wi-Fi, pins, add-ons, rules, MQTT settings, the name and the Setup AP password. The device leaves this network.</p>
        </div>
        <Button variant="danger" disabled={disabled} onClick={() => setResetOpen(true)}>
          Factory reset…
        </Button>
      </div>
      <FactoryResetDialog {...props} open={resetOpen} onOpenChange={setResetOpen} />
    </Card>
  );
}
