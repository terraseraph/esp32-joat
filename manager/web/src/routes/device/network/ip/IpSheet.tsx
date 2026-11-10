import type { IpCheckResult, IpSettings, Job } from "@shared/api";
import { useEffect, useState } from "react";
import { checkIpChange, startIpChange, type IpChangeBody } from "../../../../api/ip";
import { Banner, Button, errorMessage, Field, InlineError, Segmented, Sheet, Spinner, TextInput, useConfirm } from "../../../../components/ui";
import { isValidStatic, validateStatic, type IpField, type StaticValues } from "../../../../lib/ipv4";
import "./ip.css";

type Mode = "dhcp" | "static";
const EMPTY: StaticValues = { ip: "", netmask: "", gateway: "", dns: "" };
const CHECK_DELAY_MS = 400;

interface Props {
  id: string;
  settings: IpSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job was started; the card follows it. */
  onStarted: (job: Job) => void;
}

function current(s: IpSettings): StaticValues {
  return { ip: s.ip, netmask: s.netmask, gateway: s.gateway, dns: s.dns };
}

function toBody(mode: Mode, v: StaticValues): IpChangeBody {
  if (mode === "dhcp") return { mode: "dhcp" };
  const dns = v.dns.trim();
  return { mode: "static", ip: v.ip.trim(), netmask: v.netmask.trim(), gateway: v.gateway.trim(), ...(dns ? { dns } : {}) };
}

/** Edit sheet: DHCP / Static, instant field errors, warnings from the server's dry run, and the 90 s confirm explained. */
export function IpSheet({ id, settings, open, onOpenChange, onStarted }: Props) {
  const confirm = useConfirm();
  const [mode, setMode] = useState<Mode>("static");
  const [values, setValues] = useState<StaticValues>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<IpField, boolean>>>({});
  const [check, setCheck] = useState<{ key: string; result: IpCheckResult } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const isStatic = settings.ipMode === "static";
      setMode(isStatic ? "static" : "dhcp"); // open in the mode the device is in now
      setValues(isStatic ? current(settings) : EMPTY);
      setTouched({});
      setCheck(null);
      setError(null);
    }
  }

  const canStatic = settings.staConnected;
  const clientErrors = mode === "static" ? validateStatic(values) : {};
  const complete = mode === "dhcp" || isValidStatic(values);
  const body = toBody(mode, values);
  const bodyKey = JSON.stringify(body);

  // Dry run on the server, debounced; only a result for exactly what is in the form is used.
  useEffect(() => {
    if (!open || !complete) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      checkIpChange(id, JSON.parse(bodyKey) as IpChangeBody, ctl.signal)
        .then((result) => setCheck({ key: bodyKey, result }))
        .catch(() => {
          // The check is advice; the real request validates again.
        });
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [open, complete, bodyKey, id]);

  const result = check?.key === bodyKey ? check.result : null;
  const serverErrors: Partial<Record<IpField, string>> = {};
  const modeErrors: string[] = [];
  for (const e of result?.errors ?? []) {
    if (e.field === "mode") modeErrors.push(e.message);
    else serverErrors[e.field] ??= e.message;
  }
  const fieldError = (f: IpField): string | null => (touched[f] ? (clientErrors[f] ?? serverErrors[f] ?? null) : (serverErrors[f] ?? null));
  const blocked = !complete || (result !== null && !result.ok) || Object.keys(clientErrors).length > 0;

  const bind = (f: IpField) => ({
    value: values[f],
    onChange: (v: string) => setValues((p) => ({ ...p, [f]: v })),
    onBlur: () => setTouched((p) => ({ ...p, [f]: true })),
    disabled: pending,
    mono: true,
    autoComplete: "off",
    spellCheck: false,
  });

  const start = async () => {
    const job = await startIpChange(id, body);
    onStarted(job);
    onOpenChange(false);
  };

  const submit = async () => {
    if (blocked || pending) return;
    setError(null);
    if (mode === "static") {
      const ip = values.ip.trim();
      await confirm({
        title: `Change the address to ${ip}?`,
        body: (
          <>
            <p>The device switches to the fixed address {ip} about two seconds after the Manager sends it. The Manager then looks for it there and confirms the change.</p>
            <p>If the Manager cannot reach it at the new address within 90 seconds, the device goes back to its previous setting by itself.</p>
          </>
        ),
        confirmLabel: "Change address",
        tone: "danger",
        run: async () => {
          try {
            await start();
          } catch (err) {
            setError(errorMessage(err));
            throw err;
          }
        },
      });
      return;
    }
    setPending(true);
    try {
      await start();
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
      title="Change IP address"
      description="Choose how this device gets its address on your network."
      locked={pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={mode === "static" ? "danger" : "primary"} onClick={() => void submit()} disabled={blocked || pending}>
            {pending && <Spinner />}
            {mode === "static" ? "Use this address" : "Switch to DHCP"}
          </Button>
        </>
      }
    >
      <form
        className="ip-fields"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Address mode">
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "dhcp", label: "DHCP" },
              { value: "static", label: "Static", disabled: !canStatic, hint: "The device must be connected to Wi-Fi to set a fixed address." },
            ]}
          />
        </Field>

        {mode === "static" ? (
          <>
            {Boolean(settings.ip) && (
              <Button size="sm" className="ip-prefill" onClick={() => setValues(current(settings))} disabled={pending}>
                Use current values
              </Button>
            )}
            <div className="ip-row">
              <Field label="IP address" error={fieldError("ip")}>
                <TextInput {...bind("ip")} placeholder="192.168.1.50" />
              </Field>
              <Field label="Netmask" error={fieldError("netmask")}>
                <TextInput {...bind("netmask")} placeholder="255.255.255.0" />
              </Field>
            </div>
            <div className="ip-row">
              <Field label="Gateway" error={fieldError("gateway")} hint="Usually your router.">
                <TextInput {...bind("gateway")} placeholder="192.168.1.1" />
              </Field>
              <Field label="DNS server (optional)" error={fieldError("dns")} hint="Left empty, the gateway is used.">
                <TextInput {...bind("dns")} placeholder="192.168.1.1" />
              </Field>
            </div>
          </>
        ) : (
          <div className="ip-explain">
            <p>The device asks your router for an address, as most devices do. The router may give it a different one than before; the Manager finds it again by its ID.</p>
            {!settings.staConnected && <p>The device is not connected to Wi-Fi right now. DHCP is saved and used as soon as it joins a network.</p>}
          </div>
        )}

        {modeErrors.map((m) => (
          <Banner key={m} tone="bad">
            {m}
          </Banner>
        ))}
        {(result?.warnings ?? []).length > 0 && (
          <div className="ip-warnings">
            {result?.warnings.map((w) => (
              <Banner key={w.code} tone="warn">
                {w.message}
              </Banner>
            ))}
          </div>
        )}

        <div className="ip-explain">
          <p>
            <strong>Safety net:</strong> after the device applies the change, the Manager has 90 seconds to reach it and confirm. If it can&apos;t (wrong subnet, address taken, router
            rules), the device returns to its previous setting by itself, so you can&apos;t lock yourself out.
          </p>
        </div>

        <button type="submit" hidden />
        {error && <InlineError message={error} />}
      </form>
    </Sheet>
  );
}
