import { useState } from "react";
import { DEFAULT_FIRMWARE_URL, fieldErrors, type SettingsResponse, type SettingsUpdate } from "../../api/settings";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field } from "../../components/ui/Field";
import { errorMessage } from "../../components/ui/InlineError";
import { Segmented } from "../../components/ui/Segmented";
import { TextInput } from "../../components/ui/TextInput";
import { useToast } from "../../components/ui/Toast";
import { SaveBar } from "./SaveBar";

/** Where "Get latest firmware" looks, and the initial "Parallel updates" of the Firmware screen. */
export function FirmwareCard({ settings, onSave }: { settings: SettingsResponse; onSave: (patch: SettingsUpdate) => Promise<SettingsResponse> }) {
  const toast = useToast();
  const [url, setUrl] = useState(settings.firmwareBaseUrl);
  const [par, setPar] = useState(String(settings.defaultParallelUpdates));
  const [seen, setSeen] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  if (settings !== seen) {
    setSeen(settings);
    setUrl(settings.firmwareBaseUrl);
    setPar(String(settings.defaultParallelUpdates));
  }

  const patch: SettingsUpdate = {};
  if (url.trim() !== settings.firmwareBaseUrl) patch.firmwareBaseUrl = url.trim();
  if (Number(par) !== settings.defaultParallelUpdates) patch.defaultParallelUpdates = Number(par);
  const dirty = Object.keys(patch).length > 0;
  const urlEmpty = url.trim() === "";

  const clearErrors = () => {
    setError(null);
    setDetails({});
  };

  async function save() {
    setSaving(true);
    clearErrors();
    try {
      await onSave(patch);
      toast({ tone: "ok", title: "Firmware settings saved" });
    } catch (err) {
      setError(errorMessage(err));
      setDetails(fieldErrors(err));
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setUrl(settings.firmwareBaseUrl);
    setPar(String(settings.defaultParallelUpdates));
    clearErrors();
  }

  return (
    <Card aria-labelledby="s-firmware">
      <div className="card-head">
        <h2 id="s-firmware">Firmware</h2>
      </div>
      <div className="stack">
        <Field
          label="Firmware source"
          hint="The web address Get latest firmware downloads from (the firmware file is read from its firmware/ folder)."
          error={details["/firmwareBaseUrl"] ?? (urlEmpty ? "Enter a web address." : undefined)}
        >
          <div className="le-add">
            <TextInput
              type="url"
              value={url}
              onChange={(v) => {
                setUrl(v);
                clearErrors();
              }}
              mono
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              onClick={() => {
                setUrl(DEFAULT_FIRMWARE_URL);
                clearErrors();
              }}
              disabled={url === DEFAULT_FIRMWARE_URL}
            >
              Reset to default
            </Button>
          </div>
        </Field>
        <Field label="Default parallel updates" hint="How many devices the Firmware screen updates at the same time to begin with (1 to 4).">
          <Segmented
            value={par}
            onChange={(v) => {
              setPar(v);
              setError(null);
            }}
            options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))}
          />
        </Field>
        <SaveBar dirty={dirty} saving={saving} canSave={!urlEmpty} error={error} onSave={() => void save()} onRevert={revert} />
      </div>
    </Card>
  );
}
