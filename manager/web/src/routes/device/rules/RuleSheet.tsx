import type { LiveIoMap } from "@shared/api";
import type { Rule, RuleOp } from "@shared/device-api";
import { useMemo, useState, type CSSProperties } from "react";
import { useCommand } from "../../../api/commands";
import { Banner, Button, Checkbox, Field, NumberInput, Select, Sheet, Switch, TextInput, useToast, type SelectOption } from "../../../components/ui";
import {
  ADC_MAX_MV,
  MAX_RULE_ID,
  MODE_LABEL,
  OPS,
  buildRuleSet,
  defaultRuleForm,
  defaultRuleId,
  defaultSourceValue,
  defaultThenValue,
  destRange,
  destinationPins,
  formFromRule,
  isDestMode,
  pinModes,
  sourcePins,
  validateRule,
  type RuleForm,
  type RuleMode,
} from "./ruleLogic";
import "./rules.css";

export interface RuleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  rules: Rule[];
  io: LiveIoMap;
  /** Rule being edited (id fixed); `null` adds a new one. */
  editing: Rule | null;
  onSaved: () => void;
}

/** Add / Edit rule sheet: When (source, op, value) / Then (destination, value) / Otherwise (optional). */
export function RuleSheet({ open, onOpenChange, deviceId, rules, io, editing, onSaved }: RuleSheetProps) {
  const toast = useToast();
  const cmd = useCommand(deviceId);
  const modes = useMemo(() => pinModes(io), [io]);
  const [form, setForm] = useState<RuleForm>(() => (editing ? formFromRule(editing) : defaultRuleForm(rules, io)));
  const v = useMemo(() => validateRule(form, rules, io, editing?.id), [form, rules, io, editing]);

  const set = (patch: Partial<RuleForm>) => {
    cmd.reset();
    setForm((f) => ({ ...f, ...patch }));
  };

  const setSrc = (src: number) => {
    const before = form.src === undefined ? undefined : modes.get(form.src);
    const after = modes.get(src);
    set({ src, ...((before === "adc") !== (after === "adc") ? { value: defaultSourceValue(after) } : {}) });
  };
  const setDest = (key: "dst" | "elseDst", gpio: number) => {
    const valueKey = key === "dst" ? "thenValue" : "elseValue";
    const range = destRange(modes.get(gpio));
    const cur = key === "dst" ? form.thenValue : form.elseValue;
    const fits = cur !== undefined && cur >= range.min && cur <= range.max;
    set({ [key]: gpio, ...(fits ? {} : { [valueKey]: key === "dst" ? defaultThenValue(modes.get(gpio)) : 0 }) });
  };

  const submit = async () => {
    if (!v.valid) return;
    try {
      await cmd.run(buildRuleSet({ ...form, id: v.id }));
    } catch {
      return; // shown verbatim below
    }
    toast({ tone: "ok", title: editing ? `Saved rule ${v.id}` : `Added rule ${v.id}` });
    onSaved();
    onOpenChange(false);
  };

  const pending = cmd.pending;
  const err = cmd.error?.message;
  const srcOptions = pinOptions(sourcePins(io), form.src, modes, "Choose a pin…");
  const dstOptions = (cur: number | undefined) => pinOptions(destinationPins(io), cur, modes, "Choose a pin…", true);
  const srcMode = form.src === undefined ? undefined : modes.get(form.src);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit rule ${editing.id}` : "Add rule"}
      width={520}
      locked={pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={pending || !v.valid}>
            {pending ? "Saving…" : "Save rule"}
          </Button>
        </>
      }
    >
      <div className="rule-form">
        <section className="rule-block" aria-label="When">
          <div className="eyebrow">When</div>
          <div className="rule-row rr3">
            <Field label="Source pin" error={v.errors.src}>
              <Select value={form.src === undefined ? "" : String(form.src)} onChange={(x) => setSrc(Number(x))} options={srcOptions} />
            </Field>
            <Field label="Is">
              <Select value={form.op} onChange={(x) => set({ op: x as RuleOp })} options={OPS.map((o) => ({ value: o.value, label: `${o.label}  ${o.word}` }))} />
            </Field>
            {srcMode === "adc" ? (
              <Field label="Value (mV)" error={v.errors.value}>
                <NumberInput value={form.value} onChange={(x) => set({ value: x })} min={0} max={ADC_MAX_MV} step={1} unit="mV" />
              </Field>
            ) : (
              <Field label="Level" error={v.errors.value}>
                <Select
                  value={form.value === undefined ? "" : String(form.value)}
                  onChange={(x) => set({ value: Number(x) })}
                  options={[{ value: "0", label: "Low (0)" }, { value: "1", label: "High (1)" }]}
                />
              </Field>
            )}
          </div>
          <p className="hint">Source: inputs, analog pins and outputs.</p>
        </section>

        <section className="rule-block" aria-label="Then set">
          <div className="eyebrow">Then set</div>
          <ActionRow
            label="Destination pin"
            gpio={form.dst}
            value={form.thenValue}
            mode={form.dst === undefined ? undefined : modes.get(form.dst)}
            options={dstOptions(form.dst)}
            gpioError={v.errors.dst}
            valueError={v.errors.thenValue}
            onGpio={(g) => setDest("dst", g)}
            onValue={(x) => set({ thenValue: x })}
          />
          <p className="hint">Destination: outputs, PWM and servo pins.</p>
        </section>

        <section className="rule-block" aria-label="Otherwise">
          <Checkbox checked={form.elseOn} onChange={(c) => set({ elseOn: c })} label={<><strong>Otherwise</strong> <span className="mut">(optional)</span></>} />
          {form.elseOn && (
            <ActionRow
              label="Otherwise destination pin"
              gpio={form.elseDst}
              value={form.elseValue}
              mode={form.elseDst === undefined ? undefined : modes.get(form.elseDst)}
              options={dstOptions(form.elseDst)}
              gpioError={v.errors.elseDst}
              valueError={v.errors.elseValue}
              onGpio={(g) => setDest("elseDst", g)}
              onValue={(x) => set({ elseValue: x })}
            />
          )}
        </section>

        <div className="grid" style={{ "--min": "180px" } as CSSProperties}>
          <Field label="Rule ID" error={v.errors.id} hint={editing ? "The id can't be changed." : `max ${MAX_RULE_ID} characters. Default: ${defaultRuleId(form.src) || "r + source pin"}.`}>
            <TextInput value={form.id} onChange={(id) => set({ id })} readOnly={Boolean(editing)} placeholder={defaultRuleId(form.src)} mono spellCheck={false} autoComplete="off" />
          </Field>
          <div className="field">
            <span className="label">Status</span>
            <Switch checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} label="Enabled" />
          </div>
        </div>

        {v.warnings.map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}
        {v.errors.general && <Banner tone="warn">{v.errors.general}</Banner>}
        <p className="hint">
          One rule per source pin: saving replaces any rule that already uses this source. Sends <code>rule.set</code>.
        </p>
        {err && (
          <Banner tone="bad" title="The device rejected this rule:">
            <span className="mono">{err}</span>
          </Banner>
        )}
      </div>
    </Sheet>
  );
}

function pinOptions(gpios: number[], current: number | undefined, modes: Map<number, RuleMode>, placeholder: string, dest = false): SelectOption[] {
  const label = (g: number) => {
    const m = modes.get(g);
    return m ? `GPIO ${g} (${MODE_LABEL[m]})` : `GPIO ${g} (not configured)`;
  };
  const out: SelectOption[] = [];
  if (current === undefined) out.push({ value: "", label: placeholder });
  for (const g of gpios) out.push({ value: String(g), label: label(g) });
  if (current !== undefined && !gpios.includes(current)) out.push({ value: String(current), label: dest && !isDestMode(modes.get(current)) ? `${label(current)} - not an output` : label(current) });
  return out;
}

function ActionRow({
  label, gpio, value, mode, options, gpioError, valueError, onGpio, onValue,
}: {
  label: string;
  gpio: number | undefined;
  value: number | undefined;
  mode: RuleMode | undefined;
  options: SelectOption[];
  gpioError: string | undefined;
  valueError: string | undefined;
  onGpio: (gpio: number) => void;
  onValue: (value: number | undefined) => void;
}) {
  return (
    <div className="rule-row rr2">
      <Field label={label} error={gpioError}>
        <Select value={gpio === undefined ? "" : String(gpio)} onChange={(x) => onGpio(Number(x))} options={options} />
      </Field>
      {mode === "pwm" ? (
        <Field label="Duty (0-1000)" error={valueError}>
          <NumberInput value={value} onChange={onValue} min={0} max={1000} step={1} />
        </Field>
      ) : mode === "servo" ? (
        <Field label="Angle (°)" error={valueError}>
          <NumberInput value={value} onChange={onValue} min={0} max={180} step={1} unit="°" />
        </Field>
      ) : mode === "out" ? (
        <Field label="Set to" error={valueError}>
          <Select value={value === undefined ? "" : String(value)} onChange={(x) => onValue(Number(x))} options={[{ value: "1", label: "On (1)" }, { value: "0", label: "Off (0)" }]} />
        </Field>
      ) : (
        <Field label="Value" error={valueError}>
          <NumberInput value={value} onChange={onValue} step={1} />
        </Field>
      )}
    </div>
  );
}
