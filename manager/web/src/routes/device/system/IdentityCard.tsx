import type { DeviceSummary } from "@shared/api";
import type { DeviceStatus } from "@shared/device-api";
import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { asCommandError, sendCommand } from "../../../api/commands";
import { patchDevice } from "../../../api/devices";
import { Button } from "../../../components/ui/Button";
import { Card, CardHead } from "../../../components/ui/Card";
import { Field } from "../../../components/ui/Field";
import { errorMessage, InlineError } from "../../../components/ui/InlineError";
import { KeyValue } from "../../../components/ui/KeyValue";
import { Spinner } from "../../../components/ui/Spinner";
import { TextInput } from "../../../components/ui/TextInput";
import { useToast } from "../../../components/ui/Toast";
import { NAME_MAX, topicIdPreview, validateName } from "./helpers";

const FEATURE_LABEL: Record<string, string> = { wifi: "Wi-Fi", bt: "BT", ble: "BLE", emb_flash: "Embedded flash", emb_psram: "Embedded PSRAM" };

export function chipDescription(s: DeviceStatus): string {
  const ci = s.chip_info;
  if (!ci) return s.chip;
  const feats = ci.features.map((f) => FEATURE_LABEL[f] ?? f).join(", ");
  return [`${ci.model} rev ${ci.revision}`, `${ci.cores} ${ci.cores === 1 ? "core" : "cores"}`, feats].filter(Boolean).join(" · ");
}

export interface IdentityCardProps {
  id: string;
  status: DeviceStatus;
  summary: DeviceSummary;
  /** Rename is not possible while the device cannot be reached. */
  disabled: boolean;
  onRenamed: () => void;
}

function NameField({ id, status, disabled, onRenamed }: Pick<IdentityCardProps, "id" | "status" | "disabled" | "onRenamed">) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? status.name;
  const trimmed = value.trim();
  const invalid = validateName(value);
  const dirty = trimmed !== status.name;
  const topic = topicIdPreview(value, status.hostname);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || invalid || pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await sendCommand(id, { cmd: "identity.set_name", name: trimmed });
      toast({ tone: "ok", title: `Renamed to ${trimmed}` });
      setDraft(null);
      onRenamed();
    } catch (err) {
      setError(asCommandError(err).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Field
        label="Name"
        error={dirty && invalid && value !== "" ? invalid : undefined}
        hint={
          <>
            Up to {NAME_MAX} characters. MQTT topics become <span className="mono">devices/{topic}/…</span>
          </>
        }
      >
        <div className="rename">
          <TextInput value={value} onChange={(v) => setDraft(v)} maxLength={NAME_MAX} autoComplete="off" spellCheck={false} disabled={disabled || pending} />
          <Button type="submit" disabled={disabled || pending || !dirty || invalid !== null} aria-busy={pending || undefined}>
            {pending && <Spinner />}
            Rename
          </Button>
        </div>
      </Field>
      {dirty && !invalid && (
        <p className="warnline" style={{ marginTop: "var(--s2)" }}>
          <TriangleAlert className="i sm" aria-hidden="true" />
          <span>Renaming changes the device's MQTT topics and its mDNS name.</span>
        </p>
      )}
      {error && <InlineError message={error} className="field-gap" />}
    </form>
  );
}

function LabelField({ id, summary }: { id: string; summary: DeviceSummary }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? summary.label;
  const dirty = value.trim() !== summary.label;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    try {
      await patchDevice(id, { label: value.trim() });
      toast({ tone: "ok", title: value.trim() ? "Label saved" : "Label cleared" });
      setDraft(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="field-gap">
      <Field label="Manager label" hint="Only stored in the Manager, never sent to the device. When set, it replaces the device name in the Manager.">
        <div className="rename">
          <TextInput value={value} onChange={(v) => setDraft(v)} maxLength={64} placeholder="Optional" autoComplete="off" disabled={pending} />
          <Button type="submit" disabled={pending || !dirty} aria-busy={pending || undefined}>
            {pending && <Spinner />}
            Save label
          </Button>
        </div>
      </Field>
      {error && <InlineError message={error} className="field-gap" />}
    </form>
  );
}

/** Name (device) + label (Manager only) + the fixed identity facts. */
export function IdentityCard({ id, status, summary, disabled, onRenamed }: IdentityCardProps) {
  return (
    <Card aria-labelledby="sys-id-h">
      <CardHead title={<span id="sys-id-h">Identity</span>} />
      <NameField id={id} status={status} disabled={disabled} onRenamed={onRenamed} />
      <LabelField id={id} summary={summary} />
      <KeyValue
        className="kv-after"
        items={[
          { label: "Device ID", value: status.id, mono: true },
          { label: "MAC", value: status.mac, mono: true },
          { label: "Hostname", value: status.hostname ? `${status.hostname}.local` : "", mono: true },
          { label: "MQTT topic id", value: status.topic_id, mono: true },
          { label: "Chip", value: chipDescription(status) },
          { label: "Board", value: status.chip },
          { label: "Config schema", value: `${status.schema} · generation ${status.generation}` },
        ]}
      />
    </Card>
  );
}
