import type { Hardware, ModuleCatalogPin, ModuleCatalogSetting, ModuleCatalogType, ModuleInstance } from "@shared/device-api";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type CSSProperties } from "react";
import { useCommand } from "../../../api/commands";
import { Banner, Button, Chip, Field, NumberInput, Select, Sheet, TextInput, useToast, type SelectOption } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import {
  buildModuleAdd,
  buildModuleConfigure,
  busLabel,
  busesOfKind,
  defaultForm,
  defaultPins,
  formFromInstance,
  freePinsFor,
  instanceCount,
  roleLabel,
  settingText,
  siblingBusPins,
  typeAtLimit,
  validateAddonForm,
  type AddonForm,
  type SettingValue,
} from "./addonLogic";
import "./addons.css";

type StepKey = "type" | "pins" | "settings" | "review";
const STEP_LABEL: Record<StepKey, string> = { type: "Type", pins: "Pins", settings: "Settings", review: "Review" };

export interface AddonWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  catalog: ModuleCatalogType[];
  hardware: Hardware | null;
  instances: ModuleInstance[];
  /** Instance being edited (id fixed, no type step); `null` adds a new add-on. */
  editing: ModuleInstance | null;
  /** Called after the device accepted the change (reload list + hardware owners). */
  onSaved: () => void;
}

/** Add add-on wizard / Edit add-on sheet, generated from `module.catalog` (no hard-coded types). */
export function AddonWizard({ open, onOpenChange, deviceId, catalog, hardware, instances, editing, onSaved }: AddonWizardProps) {
  const toast = useToast();
  const cmd = useCommand(deviceId);
  const editType = editing ? catalog.find((t) => t.type === editing.type) : undefined;
  const steps: StepKey[] = editing ? ["pins", "settings", "review"] : ["type", "pins", "settings", "review"];

  const [stepIdx, setStepIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [showErrors, setShowErrors] = useState(false);
  const [form, setForm] = useState<AddonForm | null>(() => {
    if (editing && editType) return formFromInstance(editing, editType);
    const first = catalog.find((t) => !typeAtLimit(t, instances));
    return first ? defaultForm(first, hardware, instances) : null;
  });

  const type = catalog.find((t) => t.type === form?.type);
  const step = steps[stepIdx] ?? "type";
  const editingId = editing?.id;
  const validation = useMemo(() => (form && type ? validateAddonForm(form, { type, hardware, instances, editingId }) : null), [form, type, hardware, instances, editingId]);

  const update = (fn: (f: AddonForm) => AddonForm) => {
    cmd.reset();
    setForm((f) => (f ? fn(f) : f));
  };

  const go = (to: number) => {
    setDir(to > stepIdx ? 1 : -1);
    setStepIdx(to);
    setShowErrors(false);
  };

  const pickType = (t: ModuleCatalogType) => {
    cmd.reset();
    if (form?.type !== t.type) setForm(defaultForm(t, hardware, instances));
  };

  const next = () => {
    if (!validation || !type) return;
    if (step === "pins" && !validation.pinsOk) return setShowErrors(true);
    if (step === "settings" && !validation.settingsOk) return setShowErrors(true);
    go(stepIdx + 1);
  };

  const submit = async () => {
    if (!form || !type || !validation?.valid) return;
    const body = editing ? buildModuleConfigure(form, editing, type) : buildModuleAdd(form);
    if (!body) {
      toast({ tone: "info", title: "Nothing to change" });
      onOpenChange(false);
      return;
    }
    try {
      await cmd.run(body);
    } catch {
      return; // shown verbatim below
    }
    toast({ tone: "ok", title: editing ? `Saved ${form.id}` : `Added ${form.id}` });
    onSaved();
    onOpenChange(false);
  };

  const pending = cmd.pending;
  const last = step === "review";
  const err = cmd.error?.message;
  const title = editing ? `Edit add-on ${editing.id}` : "Add add-on";

  const footer = (
    <>
      <Button onClick={() => (stepIdx === 0 ? onOpenChange(false) : go(stepIdx - 1))} disabled={pending}>
        {stepIdx === 0 ? "Cancel" : "Back"}
      </Button>
      {last ? (
        <Button variant="primary" onClick={() => void submit()} disabled={pending || !validation?.valid}>
          {pending ? "Sending…" : editing ? "Save changes" : "Add add-on"}
        </Button>
      ) : (
        <Button variant="primary" onClick={next} disabled={!form || !type || (step === "type" && !type)}>
          Next
        </Button>
      )}
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} footer={footer} width={520} locked={pending}>
      <ol className="steps" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s} className={cx(i < stepIdx && "done", i === stepIdx && "on")} aria-current={i === stepIdx ? "step" : undefined}>
            {STEP_LABEL[s]}
          </li>
        ))}
      </ol>
      <AnimatePresence mode="wait" initial={false} custom={dir}>
        <motion.div
          key={step}
          className="addon-step"
          custom={dir}
          variants={{ enter: (d: number) => ({ opacity: 0, x: d * 18 }), center: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: d * -18 }) }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          {step === "type" && <TypeStep catalog={catalog} instances={instances} selected={form?.type} onPick={pickType} />}
          {step === "pins" && form && type && validation && (
            <PinsStep
              form={form}
              type={type}
              hardware={hardware}
              instances={instances}
              editingId={editingId}
              errors={showErrors ? validation.errors : { pins: {}, settings: {}, ...(validation.errors.general ? { general: validation.errors.general } : {}) }}
              idError={validation.errors.id && (showErrors || form.id !== "") ? validation.errors.id : undefined}
              update={update}
            />
          )}
          {step === "settings" && form && type && validation && (
            <SettingsStep form={form} type={type} errors={validation.errors.settings} showAll={showErrors} update={update} />
          )}
          {step === "review" && form && type && <ReviewStep form={form} type={type} editing={editing} />}
        </motion.div>
      </AnimatePresence>
      {err && (
        <Banner tone="bad" title={editing ? "The device rejected these changes:" : "The device rejected this add-on:"}>
          <span className="mono">{err}</span>
          {/need \d+ bytes/.test(err) && <div className="mut">Reboot the device or remove another add-on to free memory, then try again.</div>}
        </Banner>
      )}
    </Sheet>
  );
}

// ---- Step 1: type ---------------------------------------------------------------------------------------------

function TypeStep({ catalog, instances, selected, onPick }: { catalog: ModuleCatalogType[]; instances: ModuleInstance[]; selected: string | undefined; onPick: (t: ModuleCatalogType) => void }) {
  return (
    <div className="stack">
      <div className="grid" style={{ "--min": "190px" } as CSSProperties}>
        {catalog.map((t) => {
          const used = instanceCount(t, instances);
          const full = used >= t.max_instances;
          return (
            <button key={t.type} type="button" className="addon-type" aria-pressed={selected === t.type} disabled={full} onClick={() => onPick(t)}>
              <span className="t">{t.label}</span>
              <span className="mut">{t.summary}</span>
              <span className="chips">
                <Chip>{t.bus === "i2c" ? "I²C" : "SPI"}</Chip>
                <Chip tone={full ? "warn" : undefined}>
                  {used} of {t.max_instances} used
                </Chip>
              </span>
            </button>
          );
        })}
      </div>
      <p className="hint">A type that has reached its limit is disabled.</p>
    </div>
  );
}

// ---- Step 2: id, bus, pins --------------------------------------------------------------------------------------

function PinsStep({
  form, type, hardware, instances, editingId, errors, idError, update,
}: {
  form: AddonForm;
  type: ModuleCatalogType;
  hardware: Hardware | null;
  instances: ModuleInstance[];
  editingId: string | undefined;
  errors: ReturnType<typeof validateAddonForm>["errors"];
  idError: string | undefined;
  update: (fn: (f: AddonForm) => AddonForm) => void;
}) {
  const buses = busesOfKind(hardware, type.bus);
  const busRoles = type.pins.filter((p) => p.share === "bus");
  const ownRoles = type.pins.filter((p) => p.share === "instance");
  const setBus = (bus: string) =>
    update((f) => {
      const d = defaultPins(type, bus, hardware, instances, editingId);
      const pins = { ...f.pins };
      for (const r of busRoles) pins[r.role] = d[r.role];
      return { ...f, bus, pins };
    });
  const renderPin = (role: ModuleCatalogPin) => (
    <PinPicker key={role.role} role={role} form={form} hardware={hardware} instances={instances} editingId={editingId} error={errors.pins[role.role]} onChange={(g) => update((f) => ({ ...f, pins: { ...f.pins, [role.role]: g } }))} />
  );
  return (
    <div className="stack">
      {errors.general && <Banner tone="warn">{errors.general}</Banner>}
      <Field label="Name" hint={editingId ? "The name can't be changed. Remove the add-on and add it again to rename it." : "Letters, digits and _, starting with a letter, up to 16 characters."} error={idError} required>
        <TextInput value={form.id} onChange={(id) => update((f) => ({ ...f, id }))} readOnly={Boolean(editingId)} mono maxLength={32} spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Bus" error={errors.bus} hint={hardware?.buses.find((b) => b.id === form.bus)?.hint}>
        <Select value={form.bus} onChange={setBus} options={buses.map((b) => ({ value: b.id, label: `${b.label} (${b.id})` }))} />
      </Field>
      {busRoles.length > 0 && (
        <fieldset className="addon-pins">
          <legend className="eyebrow">Bus pins</legend>
          {busRoles.map(renderPin)}
        </fieldset>
      )}
      {ownRoles.length > 0 && (
        <fieldset className="addon-pins">
          <legend className="eyebrow">Add-on pins</legend>
          {ownRoles.map(renderPin)}
        </fieldset>
      )}
    </div>
  );
}

function PinPicker({
  role, form, hardware, instances, editingId, error, onChange,
}: {
  role: ModuleCatalogPin;
  form: AddonForm;
  hardware: Hardware | null;
  instances: ModuleInstance[];
  editingId: string | undefined;
  error: string | undefined;
  onChange: (gpio: number | undefined) => void;
}) {
  const sibling = role.share === "bus" ? siblingBusPins(role.role, form.bus, instances, editingId) : [];
  const busDefault = hardware?.buses.find((b) => b.id === form.bus)?.pins[role.role];
  const pins = freePinsFor(role, hardware, editingId, sibling);
  const current = form.pins[role.role];
  const originallySet = editingId !== undefined && instances.find((i) => i.id === editingId)?.pins[role.role] !== undefined;
  const options: SelectOption[] = [];
  if (!role.required && !originallySet) options.push({ value: "", label: "None" });
  if (current === undefined && role.required) options.push({ value: "", label: "Choose a pin…" });
  const labelOf = (gpio: number) => {
    const p = hardware?.pins.find((x) => x.gpio === gpio);
    const bits = [`GPIO ${gpio}`];
    if (gpio === busDefault && role.share === "bus") bits.push("bus default");
    else if (sibling.includes(gpio)) bits.push("shared with another add-on");
    if (p?.strap) bits.push("strapping pin");
    return bits.join(" · ");
  };
  for (const p of pins) options.push({ value: String(p.gpio), label: labelOf(p.gpio) });
  if (current !== undefined && !pins.some((p) => p.gpio === current)) {
    const owner = hardware?.pins.find((p) => p.gpio === current)?.owner;
    options.push({ value: String(current), label: `GPIO ${current}${owner ? ` · in use (${owner})` : ""}` });
  }
  return (
    <Field label={`${roleLabel(role.role)}${role.required ? "" : " (optional)"}`} error={error} required={role.required}>
      <Select value={current === undefined ? "" : String(current)} onChange={(v) => onChange(v === "" ? undefined : Number(v))} options={options} />
    </Field>
  );
}

// ---- Step 3: settings -------------------------------------------------------------------------------------------

function SettingsStep({ form, type, errors, showAll, update }: { form: AddonForm; type: ModuleCatalogType; errors: Record<string, string>; showAll: boolean; update: (fn: (f: AddonForm) => AddonForm) => void }) {
  if (type.settings.length === 0) return <p className="mut">This add-on has no settings.</p>;
  const set = (key: string, v: SettingValue | undefined) => update((f) => ({ ...f, settings: { ...f.settings, [key]: v } }));
  return (
    <div className="stack">
      {type.settings.map((s) => (
        <SettingField key={s.key} s={s} value={form.settings[s.key]} error={errors[s.key] && (showAll || form.settings[s.key] !== s.def || s.key === "addr") ? errors[s.key] : undefined} onChange={(v) => set(s.key, v)} />
      ))}
    </div>
  );
}

function SettingField({ s, value, error, onChange }: { s: ModuleCatalogSetting; value: SettingValue | undefined; error: string | undefined; onChange: (v: SettingValue | undefined) => void }) {
  if (s.kind === "enum") {
    const choices = s.choices ?? [];
    return (
      <Field label={s.label} error={error}>
        <Select
          value={value === undefined ? "" : String(value)}
          onChange={(v) => onChange(choices.find((c) => String(c.value) === v)?.value)}
          options={choices.map((c) => ({ value: String(c.value), label: c.label }))}
        />
      </Field>
    );
  }
  const range = s.min !== undefined && s.max !== undefined ? `${s.min}–${s.max}. ` : "";
  return (
    <Field label={s.label} error={error} hint={`${range}Default ${String(s.def)}.`}>
      <NumberInput value={typeof value === "number" ? value : undefined} onChange={onChange} min={s.min} max={s.max} step={1} />
    </Field>
  );
}

// ---- Step 4: review -------------------------------------------------------------------------------------------

function ReviewStep({ form, type, editing }: { form: AddonForm; type: ModuleCatalogType; editing: ModuleInstance | null }) {
  const pins = type.pins.filter((p) => form.pins[p.role] !== undefined);
  return (
    <div className="stack">
      <dl className="kv">
        <dt>Add-on</dt>
        <dd>
          {type.label} <span className="mut">· {type.summary}</span>
        </dd>
        <dt>Name</dt>
        <dd className="mono">{form.id}</dd>
        <dt>Bus</dt>
        <dd>{busLabel(type, form.bus)}</dd>
        {pins.map((p) => (
          <ReviewPin key={p.role} label={roleLabel(p.role)} gpio={form.pins[p.role] as number} />
        ))}
        {type.settings.map((s) => (
          <ReviewSetting key={s.key} s={s} value={form.settings[s.key]} />
        ))}
      </dl>
      <p className="hint">
        The device checks it has enough free memory before it starts the add-on
        {editing ? "; only the fields you changed are sent" : ""}.
      </p>
    </div>
  );
}

function ReviewPin({ label, gpio }: { label: string; gpio: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>GPIO {gpio}</dd>
    </>
  );
}

function ReviewSetting({ s, value }: { s: ModuleCatalogSetting; value: SettingValue | undefined }) {
  return (
    <>
      <dt>{s.label}</dt>
      <dd>{settingText(s, value)}</dd>
    </>
  );
}
