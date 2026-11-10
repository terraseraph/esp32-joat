import type { Job, WifiMoveCheckResult } from "@shared/api";
import { Lock, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { checkWifiMove, scanDeviceNetworks, startWifiMove } from "../../../../api/wifimove";
import { Banner, Button, errorMessage, Field, InlineError, PasswordInput, Sheet, Spinner, TextInput, useConfirm } from "../../../../components/ui";
import { networkChoices, validateWifiForm, type NetworkChoice } from "./logic";
import "./wifimove.css";

const CHECK_DELAY_MS = 400;

interface Props {
  id: string;
  /** What the person types to confirm (the device's name). */
  deviceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job was started; the card follows it. */
  onStarted: (job: Job) => void;
}

type Scan = { state: "idle" } | { state: "scanning" } | { state: "done"; networks: NetworkChoice[] } | { state: "error"; message: string };

/** "Move to another Wi-Fi network": name (typed or picked from the device's own scan), password, the server's warnings, then a danger confirmation. */
export function WifiMoveSheet({ id, deviceName, open, onOpenChange, onStarted }: Props) {
  const confirm = useConfirm();
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState<{ ssid?: boolean; password?: boolean }>({});
  const [scan, setScan] = useState<Scan>({ state: "idle" });
  const [check, setCheck] = useState<{ key: string; result: WifiMoveCheckResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSsid("");
      setPassword("");
      setTouched({});
      setScan({ state: "idle" });
      setCheck(null);
      setError(null);
    }
  }

  const errors = validateWifiForm(ssid, password);
  const valid = !errors.ssid && !errors.password;
  const key = JSON.stringify([ssid, password.length >= 8, password === ""]);

  // Dry run on the server, debounced. The password never leaves for the check: only its length matters, and a same-length stand-in is sent.
  useEffect(() => {
    if (!open || !valid) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      checkWifiMove(id, { ssid, ...(password ? { password: "x".repeat(password.length) } : {}) }, ctl.signal)
        .then((result) => setCheck({ key, result }))
        .catch(() => {
          // The check is advice; the real request validates again.
        });
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // `password` only matters through `key`; the stand-in is rebuilt from its length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, valid, key, id]);

  const result = check?.key === key ? check.result : null;
  const blocked = !valid || (result !== null && !result.ok);

  const doScan = () => {
    setScan({ state: "scanning" });
    scanDeviceNetworks(id)
      .then((aps) => setScan({ state: "done", networks: networkChoices(aps) }))
      .catch((err: unknown) => setScan({ state: "error", message: errorMessage(err) }));
  };

  const pick = (n: NetworkChoice) => {
    setSsid(n.ssid);
    if (!n.secured) setPassword("");
    setTouched((t) => ({ ...t, ssid: true }));
  };

  const submit = async () => {
    setTouched({ ssid: true, password: true });
    if (blocked) return;
    setError(null);
    await confirm({
      title: `Move ${deviceName} to "${ssid}"?`,
      body: (
        <>
          <p>
            The device will stop answering for up to about 30 seconds while it tries the new network. If it cannot join, it goes back to its current network by itself.
          </p>
          <p>If this PC cannot reach &quot;{ssid}&quot;, the Manager will not be able to find the device afterwards.</p>
        </>
      ),
      confirmLabel: "Move device",
      tone: "danger",
      typeToConfirm: deviceName,
      run: async () => {
        try {
          const job = await startWifiMove(id, { ssid, ...(password ? { password } : {}) });
          onStarted(job);
          onOpenChange(false);
        } catch (err) {
          setError(errorMessage(err));
          throw err;
        }
      },
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Move to another Wi-Fi network"
      description="Choose the network this device should join."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} disabled={blocked}>
            Continue
          </Button>
        </>
      }
    >
      <form
        className="wm-fields"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Network name" error={touched.ssid ? (errors.ssid ?? null) : null}>
          <TextInput
            value={ssid}
            onChange={setSsid}
            onBlur={() => setTouched((t) => ({ ...t, ssid: true }))}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="My home network"
          />
        </Field>

        <div className="wm-scan">
          <Button size="sm" onClick={doScan} disabled={scan.state === "scanning"}>
            {scan.state === "scanning" ? <Spinner /> : <Wifi className="i sm" aria-hidden="true" />}
            Scan from the device
          </Button>
          <span className="mut wm-hint">The device looks around for a few seconds and does not answer anything else meanwhile.</span>
        </div>
        {scan.state === "error" && <InlineError message={scan.message} onRetry={doScan} />}
        {scan.state === "done" &&
          (scan.networks.length === 0 ? (
            <p className="mut wm-hint">The device did not see any network.</p>
          ) : (
            <ul className="wm-nets" aria-label="Networks the device can see">
              {scan.networks.map((n) => (
                <li key={n.ssid}>
                  <button type="button" className="wm-net" aria-pressed={n.ssid === ssid} onClick={() => pick(n)}>
                    <span className="wm-net-name">{n.ssid}</span>
                    {n.secured && <Lock className="i sm" aria-label="Needs a password" />}
                    <span className="nt-sig" data-l={n.bars} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="mut wm-net-sig">{n.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}

        <Field label="Password" error={touched.password ? (errors.password ?? null) : null} hint="Leave empty for an open network. It is sent to the device and not stored by the Manager.">
          <PasswordInput value={password} onChange={setPassword} onBlur={() => setTouched((t) => ({ ...t, password: true }))} spellCheck={false} />
        </Field>

        {(result?.errors ?? []).map((e) => (
          <Banner key={e.message} tone="bad">
            {e.message}
          </Banner>
        ))}
        {(result?.warnings ?? []).length > 0 && (
          <div className="wm-warnings">
            {result?.warnings.map((w) => (
              <Banner key={w.code} tone="warn">
                {w.message}
              </Banner>
            ))}
          </div>
        )}

        <div className="wm-explain">
          <p>
            <strong>What happens:</strong> the device tests the new network for up to 20 seconds and will not answer during that time. If it cannot join (wrong password,
            out of range, no address from the router), it goes back to its current network and the Manager tells you why. If it joins, the Manager looks for it by its ID, even on
            a new address.
          </p>
        </div>

        <button type="submit" hidden />
        {error && <InlineError message={error} />}
      </form>
    </Sheet>
  );
}
