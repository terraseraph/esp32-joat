import { useState } from "react";
import { fieldErrors, type SettingsResponse, type SettingsUpdate } from "../../api/settings";
import { Card } from "../../components/ui/Card";
import { Field } from "../../components/ui/Field";
import { errorMessage } from "../../components/ui/InlineError";
import { Switch } from "../../components/ui/Switch";
import { NumberInput } from "../../components/ui/TextInput";
import { useToast } from "../../components/ui/Toast";
import { ListEditor } from "./ListEditor";
import { SaveBar } from "./SaveBar";

interface Draft {
  poll: number | undefined;
  bgOn: boolean;
  bgEvery: number | undefined;
  targets: string[];
  subnets: string[];
}

const fromSettings = (s: SettingsResponse): Draft => ({
  poll: s.pollIntervalS,
  bgOn: s.backgroundScan.enabled,
  bgEvery: s.backgroundScan.periodMin,
  targets: [...s.discoveryTargets],
  subnets: [...s.extraSubnets],
});
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Index errors from `details` paths such as `/discoveryTargets/2`. */
function indexErrors(all: Record<string, string>, key: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [path, message] of Object.entries(all)) {
    const m = new RegExp(`^/${key}/(\\d+)$`).exec(path);
    if (m) out[Number(m[1])] = message;
  }
  return out;
}

/** Health polling and discovery: poll interval, background scan, extra targets and subnets. */
export function DevicesCard({ settings, onSave }: { settings: SettingsResponse; onSave: (patch: SettingsUpdate) => Promise<SettingsResponse> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => fromSettings(settings));
  const [seen, setSeen] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  if (settings !== seen) {
    setSeen(settings);
    setDraft(fromSettings(settings));
  }

  const base = fromSettings(settings);
  const patch: SettingsUpdate = {};
  if (draft.poll !== undefined && draft.poll !== base.poll) patch.pollIntervalS = draft.poll;
  if (draft.bgOn !== base.bgOn || (draft.bgEvery !== undefined && draft.bgEvery !== base.bgEvery)) {
    patch.backgroundScan = { enabled: draft.bgOn, ...(draft.bgEvery !== undefined ? { periodMin: draft.bgEvery } : {}) };
  }
  if (!same(draft.targets, base.targets)) patch.discoveryTargets = draft.targets;
  if (!same(draft.subnets, base.subnets)) patch.extraSubnets = draft.subnets;
  const dirty = Object.keys(patch).length > 0;
  const pollBad = draft.poll === undefined || draft.poll < 10 || draft.poll > 300;
  const everyBad = draft.bgEvery === undefined || draft.bgEvery < 1 || draft.bgEvery > 60;

  const edit = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setError(null);
    setDetails({});
  };

  async function save() {
    setSaving(true);
    setError(null);
    setDetails({});
    try {
      await onSave(patch);
      toast({ tone: "ok", title: "Device settings saved" });
    } catch (err) {
      setError(errorMessage(err));
      setDetails(fieldErrors(err));
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setDraft(base);
    setError(null);
    setDetails({});
  }

  return (
    <Card aria-labelledby="s-devices">
      <div className="card-head">
        <h2 id="s-devices">Devices and discovery</h2>
      </div>
      <div className="stack">
        <Field label="Check devices every" hint="Each check is one small request per device. 10 to 300 seconds." error={details["/pollIntervalS"] ?? (pollBad ? "Use 10 to 300 seconds." : undefined)}>
          <NumberInput value={draft.poll} onChange={(poll) => edit({ poll })} min={10} max={300} step={1} unit="s" />
        </Field>

        <Switch
          checked={draft.bgOn}
          onCheckedChange={(bgOn) => edit({ bgOn })}
          label="Scan in the background"
          hint="Looks for new devices on its own. Found devices wait in Discover until you add them."
        />
        <Field label="Scan every" hint="1 to 60 minutes." error={details["/backgroundScan/periodMin"] ?? (draft.bgOn && everyBad ? "Use 1 to 60 minutes." : undefined)}>
          <NumberInput value={draft.bgEvery} onChange={(bgEvery) => edit({ bgEvery })} min={1} max={60} step={1} unit="min" disabled={!draft.bgOn} />
        </Field>

        <ListEditor
          label="Extra discovery targets"
          hint="Addresses probed on every scan, one host or host:port each, for devices that mDNS and the subnet sweep do not find."
          placeholder="192.168.20.7 or 192.168.20.7:8080"
          items={draft.targets}
          onChange={(targets) => edit({ targets })}
          errors={indexErrors(details, "discoveryTargets")}
        />
        <ListEditor
          label="Extra subnets to sweep"
          hint="CIDR ranges swept on every scan, for a network this PC can reach but is not directly on. Wider than /24 is clamped to the /24 of the address."
          placeholder="192.168.20.0/24"
          items={draft.subnets}
          onChange={(subnets) => edit({ subnets })}
          errors={indexErrors(details, "extraSubnets")}
        />
        <SaveBar dirty={dirty} saving={saving} canSave={!pollBad && !(draft.bgOn && everyBad)} error={error} onSave={() => void save()} onRevert={revert} />
      </div>
    </Card>
  );
}
