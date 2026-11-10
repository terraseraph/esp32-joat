import type { Bme280State, Hardware, Mfrc522State, ModuleCatalog, ModuleCatalogType, ModuleInstance, ModuleList } from "@shared/device-api";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Puzzle } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useCommand, useDeviceCommandResult, useDeviceResource } from "../../../api/commands";
import { useDevice } from "../../../api/devices";
import { useDeviceLive } from "../../../api/live";
import { Banner, Button, Card, Chip, EmptyState, InlineError, Skeleton, Switch, useConfirm, useToast } from "../../../components/ui";
import { formatAgo } from "../../../lib/format";
import { cx } from "../../../lib/cx";
import { AddonWizard } from "./AddonWizard";
import { busLabel, describeReading, instanceCount, pinSummary, settingText, typeAtLimit } from "./addonLogic";
import "./addons.css";

interface Sheet {
  open: boolean;
  /** Increments per opening so the wizard starts from a clean state. */
  n: number;
  editing: ModuleInstance | null;
}

/** Add-ons card list + Add add-on wizard (`module.catalog|list|add|configure|remove`). */
export function AddonsSection({ id }: { id: string }) {
  const { summary } = useDevice(id);
  const offline = summary?.health === "offline" || summary?.health === "unreachable";
  const catalogRes = useDeviceCommandResult<ModuleCatalog>(id, { cmd: "module.catalog" });
  const listRes = useDeviceCommandResult<ModuleList>(id, { cmd: "module.list" });
  const hwRes = useDeviceResource<Hardware>(id, "hardware");
  const live = useDeviceLive(id);
  const cmd = useCommand(id);
  const confirm = useConfirm();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet>({ open: false, n: 0, editing: null });
  const [busy, setBusy] = useState<string | null>(null);

  const catalog = catalogRes.data?.types ?? [];
  const instances = listRes.data?.modules ?? [];
  const hardware = hwRes.data;
  const loadError = listRes.error?.message ?? catalogRes.error?.message ?? hwRes.error?.message ?? null;
  const loading = !listRes.data && !loadError;
  const ready = Boolean(listRes.data && catalogRes.data && hardware);

  const reloadAll = () => {
    listRes.reload();
    hwRes.reload();
    if (catalogRes.error || !catalogRes.data) catalogRes.reload();
  };
  const retry = () => {
    if (listRes.error) listRes.reload();
    if (catalogRes.error) catalogRes.reload();
    if (hwRes.error) hwRes.reload();
  };

  const open = (editing: ModuleInstance | null) => setSheet((s) => ({ open: true, n: s.n + 1, editing }));

  const toggle = async (inst: ModuleInstance, enabled: boolean) => {
    setBusy(inst.id);
    try {
      await cmd.run({ cmd: "module.configure", id: inst.id, enabled });
      reloadAll();
    } catch (err) {
      toast({ tone: "bad", title: `Could not ${enabled ? "enable" : "disable"} ${inst.id}`, description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (inst: ModuleInstance, label: string, pins: string) => {
    const ok = await confirm({
      title: `Remove ${inst.id}?`,
      body: `${label} ${inst.id} will be removed from the device. Its pins${pins ? ` (${pins})` : ""} become free again.`,
      confirmLabel: "Remove add-on",
      tone: "danger",
      run: async () => {
        await cmd.run({ cmd: "module.remove", id: inst.id });
      },
    });
    if (ok) {
      toast({ tone: "ok", title: `Removed ${inst.id}` });
      reloadAll();
    }
  };

  const everyTypeFull = catalog.length > 0 && catalog.every((t) => typeAtLimit(t, instances));
  const addDisabled = offline || !ready || everyTypeFull;

  return (
    <section id="addons" className="addons-sec" aria-labelledby="addons-h">
      <div className="addons-head">
        <h2 id="addons-h">Add-ons</h2>
        {catalog.length > 0 && (
          <span className="sub">{catalog.map((t) => `${t.label}: ${instanceCount(t, instances)} of ${t.max_instances}`).join(" · ")}</span>
        )}
        <span className="spacer" />
        <Button variant="primary" onClick={() => open(null)} disabled={addDisabled} title={everyTypeFull ? "Every add-on type has reached its limit" : undefined}>
          <Plus className="i" aria-hidden="true" /> Add add-on
        </Button>
      </div>

      {offline && (
        <Banner tone="warn" title="This device is offline" action={<Button size="sm" onClick={retry}>Retry</Button>}>
          Add-ons are shown read-only{summary?.lastSeen ? `. Last seen ${formatAgo(summary.lastSeen)}` : ""}.
        </Banner>
      )}

      {loadError && <InlineError message={loadError} onRetry={retry} />}

      {loading && (
        <div className="grid" style={{ "--min": "340px" } as CSSProperties} aria-busy="true" aria-label="Loading add-ons">
          {[0, 1].map((i) => (
            <Card key={i}>
              <Skeleton variant="title" />
              <Skeleton variant="line" width="80%" />
              <Skeleton variant="line" width="60%" />
              <Skeleton variant="block" />
            </Card>
          ))}
        </div>
      )}

      {listRes.data && instances.length === 0 && (
        <EmptyState
          icon={Puzzle}
          title="No add-ons yet"
          action={
            <Button variant="primary" onClick={() => open(null)} disabled={addDisabled}>
              <Plus className="i" aria-hidden="true" /> Add add-on
            </Button>
          }
        >
          Add a BME280 temperature, humidity and pressure sensor or an RC522 RFID reader. Add-ons use the pins you choose.
        </EmptyState>
      )}

      {instances.length > 0 && (
        <div className="grid" style={{ "--min": "340px" } as CSSProperties}>
          <AnimatePresence initial={false}>
            {instances.map((inst) => {
              const type = catalog.find((t) => t.type === inst.type);
              const state = (live.io[`mod_${inst.id}`] as Bme280State | Mfrc522State | undefined) ?? inst.state;
              return (
                <motion.div key={inst.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.18 }}>
                  <AddonCard
                    inst={inst}
                    type={type}
                    state={state}
                    offline={offline}
                    busy={busy === inst.id}
                    onToggle={(v) => void toggle(inst, v)}
                    onEdit={() => open(inst)}
                    onRemove={() => void remove(inst, type?.label ?? inst.type, pinSummary(type, inst))}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {ready && (
        <AddonWizard
          key={sheet.n}
          open={sheet.open}
          onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
          deviceId={id}
          catalog={catalog}
          hardware={hardware}
          instances={instances}
          editing={sheet.editing}
          onSaved={reloadAll}
        />
      )}
    </section>
  );
}

function AddonCard({
  inst, type, state, offline, busy, onToggle, onEdit, onRemove,
}: {
  inst: ModuleInstance;
  type: ModuleCatalogType | undefined;
  state: Bme280State | Mfrc522State | undefined;
  offline: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const reading = describeReading(state, inst.enabled);
  const settings = type?.settings ?? [];
  return (
    <Card className={cx("addon", !inst.enabled && "is-disabled", offline && "is-offline")} aria-label={`Add-on ${inst.id}`}>
      <div className="addon-top">
        <Chip mono>{inst.id}</Chip>
        <h3>{type?.label ?? inst.type}</h3>
        <Chip tone={inst.enabled ? "ok" : "off"}>{inst.enabled ? "Enabled" : "Disabled"}</Chip>
        <div className="addon-live" aria-live="polite">
          <motion.div key={reading.primary} className={cx("rd", reading.empty && "is-empty")} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
            {reading.primary}
          </motion.div>
          {reading.secondary && <div className="sb">{reading.secondary}</div>}
        </div>
      </div>
      <dl className="kv">
        <dt>Bus</dt>
        <dd>{busLabel(type, inst.bus)}</dd>
        <dt>Pins</dt>
        <dd>{pinSummary(type, inst) || <span className="mut">None</span>}</dd>
        {settings.length === 0 && Object.keys(inst.settings ?? {}).length === 0 ? (
          <>
            <dt>Settings</dt>
            <dd className="mut">None</dd>
          </>
        ) : (
          settings.map((s) => (
            <SettingRow key={s.key} label={s.label} value={settingText(s, inst.settings?.[s.key])} />
          ))
        )}
      </dl>
      <div className="addon-actions">
        <Switch checked={inst.enabled} onCheckedChange={onToggle} disabled={offline || busy} aria-label={`Enable ${inst.id}`} />
        <Button size="sm" onClick={onEdit} disabled={offline || !type}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={onRemove} disabled={offline}>
          Remove
        </Button>
      </div>
    </Card>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
