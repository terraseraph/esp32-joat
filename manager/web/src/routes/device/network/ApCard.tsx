import type { NetworkStatus } from "@shared/device-api";
import { useState } from "react";
import { sendCommand } from "../../../api/commands";
import { Button, Card, CardHead, Chip, errorMessage, Field, InlineError, KeyValue, PasswordInput, Sheet, Spinner, useConfirm, useToast } from "../../../components/ui";
import { validateApPassword } from "./logic";

interface Props {
  id: string;
  net: NetworkStatus;
  down: boolean;
  onChanged: () => void;
}

/** Setup AP card: SSID, Open/Protected, address, set or remove the password. */
export function ApCard({ id, net, down, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  const remove = () =>
    confirm({
      title: "Make the Setup AP open?",
      body: "Anyone in range will be able to join the Setup AP and reach this device without a password.",
      confirmLabel: "Remove password",
      tone: "danger",
      run: async () => {
        await sendCommand(id, { cmd: "network.ap.set_password", password: "" });
        onChanged();
        toast({ tone: "ok", title: "Setup AP password removed" });
      },
    });

  return (
    <Card className={down ? "nt-card is-down" : "nt-card"} aria-labelledby="nt-ap-h">
      <CardHead title={<span id="nt-ap-h">Setup AP</span>} actions={<Chip tone={net.ap_open ? "warn" : "ok"}>{net.ap_open ? "Open" : "Protected"}</Chip>} />
      <KeyValue
        items={[
          { label: "Network name", value: net.ap_ssid, mono: true },
          { label: "Address", value: net.ap_ip, mono: true },
          { label: "Security", value: net.ap_open ? "Open (no password)" : "Protected (password set)" },
        ]}
      />
      <p className="nt-note">The device opens this network when it can&apos;t join Wi-Fi, for setup and recovery. The password can&apos;t be read back from the device.</p>
      <div className="nt-actions">
        <Button onClick={() => setOpen(true)} disabled={down}>
          {net.ap_open ? "Set password" : "Change password"}
        </Button>
        {!net.ap_open && (
          <Button onClick={() => void remove()} disabled={down}>
            Remove password (make it open)
          </Button>
        )}
      </div>
      <ApPasswordSheet id={id} open={open} onOpenChange={setOpen} onSaved={onChanged} />
    </Card>
  );
}

function ApPasswordSheet({ id, open, onOpenChange, onSaved }: { id: string; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const toast = useToast();
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPw("");
      setAgain("");
      setError(null);
    }
  }

  const pwError = pw ? validateApPassword(pw) : null;
  const matchError = again && pw !== again ? "The two passwords do not match" : null;
  const ready = validateApPassword(pw, again) === null;

  const save = async () => {
    if (!ready || pending) return;
    const password = pw;
    setPending(true);
    setError(null);
    setPw("");
    setAgain("");
    try {
      await sendCommand(id, { cmd: "network.ap.set_password", password });
      onSaved();
      toast({ tone: "ok", title: "Setup AP password set" });
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Setup AP password"
      description="Anyone joining the Setup AP will need this password."
      locked={pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!ready || pending}>
            {pending && <Spinner />}
            Set password
          </Button>
        </>
      }
    >
      <form
        className="nt-card"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Password" hint="8 to 63 characters." error={pwError}>
          <PasswordInput value={pw} onChange={setPw} disabled={pending} />
        </Field>
        <Field label="Confirm password" error={matchError}>
          <PasswordInput value={again} onChange={setAgain} disabled={pending} />
        </Field>
        <button type="submit" hidden />
        {error && <InlineError message={error} />}
      </form>
    </Sheet>
  );
}
