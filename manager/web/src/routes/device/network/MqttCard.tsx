import type { MqttStatus } from "@shared/device-api";
import { useState } from "react";
import { sendCommand } from "../../../api/commands";
import { AnimatedNumber, Banner, Button, Card, CardHead, Checkbox, Chip, errorMessage, Field, InlineError, KeyValue, PasswordInput, Sheet, Spinner, TextInput, useToast } from "../../../components/ui";
import { buildMqttConfigure, DEFAULT_ROOT, mqttPrefixPreview, validateMqttForm, type MqttForm } from "./logic";

interface Props {
  id: string;
  mqtt: MqttStatus;
  down: boolean;
  onChanged: () => void;
}

const HINT_NO_OFF = "MQTT can't be switched off once set up (firmware limitation). To stop using it, set a different broker or reset the device.";

/** MQTT card: status, counters, topics, and the Configure sheet. */
export function MqttCard({ id, mqtt, down, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const configured = mqtt.uri !== "";
  const tone = !configured ? "off" : mqtt.connected ? "ok" : "bad";
  const label = !configured ? "Not set up" : mqtt.connected ? "Connected" : "Disconnected";
  const prefix = mqtt.prefix;

  return (
    <Card className={down ? "nt-card is-down nt-full" : "nt-card nt-full"} aria-labelledby="nt-mqtt-h">
      <CardHead
        title={<span id="nt-mqtt-h">MQTT</span>}
        actions={
          <>
            <Chip tone={down ? "off" : tone}>{label}</Chip>
            <Button size="sm" onClick={() => setOpen(true)} disabled={down}>
              Configure
            </Button>
          </>
        }
      />
      {!configured ? (
        <div className="nt-sub" style={{ borderTop: 0, paddingTop: 0 }}>
          <strong>No broker set</strong>
          <p className="nt-note">Set a broker to publish this device&apos;s state and accept commands over MQTT.</p>
          <div className="nt-actions">
            <Button variant="primary" onClick={() => setOpen(true)} disabled={down}>
              Set up MQTT
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!mqtt.connected && (
            <Banner tone="warn" title="Can't reach the broker.">
              Check the broker address and that it&apos;s reachable from the device&apos;s network.
            </Banner>
          )}
          <div className="nt-mqtt">
            <KeyValue
              items={[
                { label: "Broker", value: mqtt.uri, mono: true },
                { label: "Topic root", value: mqtt.root, mono: true },
                { label: "Topic prefix", value: prefix, mono: true },
                { label: "Topic id", value: mqtt.topic_id, mono: true },
                { label: "Published", value: <AnimatedNumber value={mqtt.published} /> },
                { label: "Failed", value: <AnimatedNumber value={mqtt.publish_fail} /> },
                { label: "Received", value: <AnimatedNumber value={mqtt.received} /> },
                { label: "Reconnects", value: <AnimatedNumber value={mqtt.reconnects} /> },
                { label: "Last error", value: mqtt.last_error ? <span className="mono nt-err t-warn">{mqtt.last_error}</span> : null },
              ]}
            />
            <details className="nt-ref">
              <summary>
                Topics ({mqtt.sub.length + mqtt.pub.length})
              </summary>
              <div>
                <ul className="nt-topics" aria-label="Topics">
                  {mqtt.sub.map((t) => (
                    <li key={`s-${t}`}>
                      <span className="nt-dir">Subscribe</span>
                      <span className="mono">{`${prefix}/${t}`}</span>
                    </li>
                  ))}
                  {mqtt.pub.map((t) => (
                    <li key={`p-${t}`}>
                      <span className="nt-dir">Publish</span>
                      <span className="mono">{`${prefix}/${t}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </div>
        </>
      )}
      <p className="nt-note">{HINT_NO_OFF}</p>
      <MqttConfigureSheet id={id} mqtt={mqtt} open={open} onOpenChange={setOpen} onSaved={onChanged} />
    </Card>
  );
}

const blank = (mqtt: MqttStatus): MqttForm => ({ uri: mqtt.uri, root: mqtt.root || DEFAULT_ROOT, changeCreds: false, user: "", password: "" });

function MqttConfigureSheet({ id, mqtt, open, onOpenChange, onSaved }: { id: string; mqtt: MqttStatus; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [form, setForm] = useState<MqttForm>(() => blank(mqtt));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const toast = useToast();
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(blank(mqtt));
      setError(null);
    } else {
      // never keep credentials around after the sheet closes
      setForm((f) => ({ ...f, user: "", password: "" }));
    }
  }
  const set = (patch: Partial<MqttForm>) => setForm((f) => ({ ...f, ...patch }));

  const errors = validateMqttForm(form);
  const body = buildMqttConfigure(form, mqtt);
  const ready = body !== null && !errors.uri && !errors.root;

  const save = async () => {
    if (!ready || pending || !body) return;
    const { cmd, ...fields } = body;
    setPending(true);
    setError(null);
    set({ changeCreds: false, user: "", password: "" });
    try {
      await sendCommand(id, { cmd, ...fields });
      onSaved();
      toast({ tone: "ok", title: "MQTT settings saved", description: "The device is reconnecting to the broker." });
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
      title="Configure MQTT"
      description="Only the fields you change are sent. The device reconnects right away."
      locked={pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!ready || pending}>
            {pending && <Spinner />}
            Save and reconnect
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
        <Field label="Broker URI" hint="mqtt://host:1883 or mqtts://host:8883" error={form.uri.trim() ? errors.uri : null}>
          <TextInput mono value={form.uri} onChange={(uri) => set({ uri })} placeholder="mqtt://192.168.1.10:1883" autoComplete="off" spellCheck={false} disabled={pending} />
        </Field>
        <Field
          label="Topic root"
          hint={
            <>
              Letters, numbers, _ - and /. Topics will start with <span className="mono">{mqttPrefixPreview(form.root, mqtt.topic_id)}</span>
            </>
          }
          error={errors.root}
        >
          <TextInput mono value={form.root} onChange={(root) => set({ root })} placeholder={DEFAULT_ROOT} autoComplete="off" spellCheck={false} disabled={pending} />
        </Field>
        <Checkbox
          checked={form.changeCreds}
          onChange={(changeCreds) => set({ changeCreds, user: "", password: "" })}
          label="Change credentials"
          hint="The broker's user name and password can't be read from the device, so they stay as they are unless you change them here."
          disabled={pending}
        />
        {form.changeCreds && (
          <>
            <Field label="Username" hint="Leave empty to remove the user name.">
              <TextInput value={form.user} onChange={(user) => set({ user })} autoComplete="off" spellCheck={false} disabled={pending} />
            </Field>
            <Field label="Password">
              <PasswordInput value={form.password} onChange={(password) => set({ password })} disabled={pending} />
            </Field>
          </>
        )}
        <p className="nt-note">{HINT_NO_OFF}</p>
        <button type="submit" hidden />
        {error && <InlineError message={error} />}
      </form>
    </Sheet>
  );
}
