import { Lock, LockOpen, Send } from "lucide-react";
import { useState } from "react";
import type { SetupChooseResult, SetupWifiBody } from "../../../api/setup";
import { Banner, Button, Field, PasswordInput, Spinner, TextInput } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { sortNetworks } from "./logic";

const MANUAL = "\u0000manual";

export interface ChooseNetworkProps {
  result: SetupChooseResult;
  busy: boolean;
  /** Plain-words failure of the last send. */
  error: string | null;
  onSubmit(body: SetupWifiBody): void;
}

/** The job is waiting: pick the network the device should join (its own scan, strongest first) or type a name. */
export function ChooseNetwork({ result, busy, error, onSubmit }: ChooseNetworkProps) {
  const networks = sortNetworks(result.networks);
  const [picked, setPicked] = useState<string>("");
  const [manual, setManual] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);

  const isManual = picked === MANUAL;
  const chosen = networks.find((n) => n.ssid === picked);
  const ssid = isManual ? manual.trim() : picked;
  const needsPassword = isManual ? false : chosen?.secure === true;
  const showPassword = isManual || needsPassword;

  const problem = !ssid ? (isManual ? "Type the network name." : "Pick a network.") : needsPassword && !password ? "Enter the Wi-Fi password." : null;

  const submit = () => {
    setTouched(true);
    if (problem) return;
    onSubmit({ ssid, ...(password ? { password } : {}) });
  };

  const name = result.device.name || result.device.id;
  return (
    <form
      className="su-choose"
      aria-label="Choose the device's network"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <h3 className="su-h">Choose the network for {name || "the device"}</h3>
        <p className="mut su-p">These are the Wi-Fi networks the device can see. It will join the one you pick and your PC will go back to its own network.</p>
      </div>

      <fieldset className="su-nets" disabled={busy}>
        <legend className="sr">Wi-Fi networks</legend>
        {networks.length === 0 && <p className="mut su-p">The device did not find any network. Type the name below.</p>}
        {networks.map((n) => (
          <label key={n.ssid} className={cx("su-net", picked === n.ssid && "on")}>
            <input type="radio" name="su-net" value={n.ssid} checked={picked === n.ssid} onChange={() => setPicked(n.ssid)} />
            <span className="su-net-name">{n.ssid}</span>
            <span className="su-net-meta mut">
              {n.secure ? <Lock className="i sm" aria-hidden="true" /> : <LockOpen className="i sm" aria-hidden="true" />}
              <span className="sr">{n.secure ? "Secured" : "Open"}</span>
              <span className="num">{Math.round(n.rssi)} dBm</span>
            </span>
          </label>
        ))}
        <label className={cx("su-net", isManual && "on")}>
          <input type="radio" name="su-net" value={MANUAL} checked={isManual} onChange={() => setPicked(MANUAL)} />
          <span className="su-net-name">Another network...</span>
        </label>
      </fieldset>

      {isManual && (
        <Field label="Network name" error={touched && !ssid ? "Type the network name." : undefined} required>
          <TextInput value={manual} onChange={setManual} autoComplete="off" spellCheck={false} disabled={busy} maxLength={32} />
        </Field>
      )}
      {showPassword && (
        <Field
          label="Wi-Fi password"
          hint={isManual ? "Leave it empty for an open network." : undefined}
          error={touched && needsPassword && !password ? "Enter the Wi-Fi password." : undefined}
          required={needsPassword}
        >
          <PasswordInput value={password} onChange={setPassword} disabled={busy} maxLength={63} />
        </Field>
      )}
      {touched && !ssid && !isManual && (
        <p className="t-bad su-p" role="alert">
          {problem}
        </p>
      )}

      {error && (
        <Banner tone="bad" title="Could not send the network">
          {error}
        </Banner>
      )}

      <div>
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner /> : <Send className="i sm" aria-hidden="true" />}
          Send to device
        </Button>
      </div>
    </form>
  );
}
