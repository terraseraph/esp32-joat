import type { PinConfigEntry } from "@shared/api";
import type { Hardware, HardwarePin, HeaderPad, Rule } from "@shared/device-api";
import { CircleAlert, Info } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { asCommandError, sendCommand } from "../../../api/commands";
import { Banner, Button, Checkbox, Chip, Field, InlineError, NumberInput, Segmented, Sheet, Spinner, useConfirm, useToast } from "../../../components/ui";
import {
  allowedModes,
  buildPinConfig,
  busRole,
  formFromConfig,
  isClaimed,
  MODE_LABEL,
  otherPwmPins,
  ownerExplanation,
  parseOwner,
  pinLabel,
  RANGES,
  rulesUsing,
  toFormMode,
  validateForm,
  type FormMode,
  type PinForm,
} from "./pinLogic";

export interface PinSheetProps {
  id: string;
  pin: HardwarePin;
  pad: HeaderPad | undefined;
  hardware: Hardware;
  /** Current configuration of this pin (undefined: not configured or pin-config not loaded). */
  entry: PinConfigEntry | undefined;
  /** `rule.list` result (null while unknown). */
  rules: Rule[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why editing is impossible right now (offline...), or null. */
  blockedReason: string | null;
  onSaved: () => void;
  /** Scroll to the Add-ons section (for pins owned by an add-on or bus). */
  onGoToAddons: () => void;
}

const Note = ({ icon = "info", tone, children }: { icon?: "info" | "alert"; tone?: "warn"; children: ReactNode }) => (
  <p className={tone ? `pn-note ${tone}` : "pn-note"}>
    {icon === "alert" ? <CircleAlert className="i sm" aria-hidden="true" /> : <Info className="i sm" aria-hidden="true" />}
    <span>{children}</span>
  </p>
);

/** Side sheet that configures one pin: mode limited to what it supports, per-mode fields, minimal `pin.configure`. */
export function PinSheet({ id, pin, pad, hardware, entry, rules, open, onOpenChange, blockedReason, onSaved, onGoToAddons }: PinSheetProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const modes = useMemo(() => allowedModes(pin), [pin]);
  const claimed = isClaimed(pin.owner);
  const configured = parseOwner(pin.owner).kind === "own" || entry !== undefined;

  const [mode, setMode] = useState<FormMode>(() => {
    const m = toFormMode(entry?.mode);
    return modes.some((o) => o.mode === m && !o.disabled) ? m : "disabled";
  });
  const [form, setForm] = useState<PinForm>(() => formFromConfig(entry?.config));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const patch = (p: Partial<PinForm>) => setForm((f) => ({ ...f, ...p }));

  const label = pinLabel(pin, pad);
  const title = `GPIO ${pin.gpio}${label ? ` · ${label}` : ""}`;
  const errors = validateForm(mode, form);
  const invalid = Object.keys(errors).length > 0;
  const usedBy = rulesUsing(rules, pin.gpio);
  const others = otherPwmPins(hardware.pins, pin.gpio);
  const canPull = pin.pull;
  const servoOwned = pin.owner.startsWith("servo_");
  const nothingToDo = mode === "disabled" && !configured;
  const unknownOptions = entry?.source === "live" && (mode === "out" || mode === "in");

  const save = async () => {
    if (pending || blockedReason || invalid || nothingToDo) return;
    setError(null);
    if (mode === "disabled" && usedBy.length > 0) {
      const ok = await confirm({
        title: `Turn off GPIO ${pin.gpio}?`,
        body: `${usedBy.length === 1 ? "Rule" : "Rules"} ${usedBy.map((r) => r.id).join(", ")} ${usedBy.length === 1 ? "uses" : "use"} this pin. They stay on the device but cannot work until it is set up again.`,
        confirmLabel: "Turn off",
        tone: "danger",
      });
      if (!ok) return;
    }
    const cfg = buildPinConfig(pin.gpio, mode, form, { pull: canPull });
    setPending(true);
    try {
      await sendCommand(id, { cmd: "pin.configure", pin: cfg });
      toast({ tone: "ok", title: mode === "disabled" ? `GPIO ${pin.gpio} turned off` : `GPIO ${pin.gpio} set to ${MODE_LABEL[mode]}`, description: mode === "disabled" ? undefined : "Saved on the device; it keeps this after a reboot." });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(asCommandError(err).message);
    } finally {
      setPending(false);
    }
  };

  const flags: string[] = [];
  if (pin.adc1) flags.push("ADC1");
  if (pin.adc2) flags.push("ADC2");
  if (pin.dac) flags.push("DAC");
  if (pin.touch) flags.push("Touch");

  const info = parseOwner(pin.owner);
  const role = info.kind === "bus" ? busRole(info.id, pin.gpio, hardware.buses) : null;

  const footer = claimed ? (
    <>
      <Button onClick={() => onOpenChange(false)}>Close</Button>
      <Button variant="primary" onClick={onGoToAddons}>
        Go to add-ons
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => onOpenChange(false)} disabled={pending}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => void save()} disabled={pending || Boolean(blockedReason) || invalid || nothingToDo}>
        {pending && <Spinner />} Save
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} width={460} footer={footer} locked={pending}>
      <div className="pn-sheet-body">
        <div className="pn-sheet-notes">
          {pin.notes && <p className="mut">{pin.notes}</p>}
          <div className="pn-flags">
            {flags.map((f) => (
              <Chip key={f}>{f}</Chip>
            ))}
            {pin.input_only && <Chip>Input-only</Chip>}
            {pin.strap && <Chip tone="warn">Strapping pin</Chip>}
            {pin.status_led && <Chip>Status LED</Chip>}
            {pin.boot_btn && <Chip>BOOT button</Chip>}
          </div>
        </div>

        {blockedReason && <Banner tone="warn">{blockedReason}</Banner>}

        {claimed ? (
          <Banner tone="info" title={ownerExplanation(pin, hardware.buses)}>
            {info.kind === "addon"
              ? "Remove or edit that add-on to free this pin."
              : `${role ? `This pin is the bus ${role} line. ` : ""}Add-ons on this bus use it; remove or edit them to free the pin.`}
          </Banner>
        ) : (
          <>
            <Field label="Mode">
              <Segmented<FormMode>
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  setError(null);
                }}
                options={modes.map((o) => ({ value: o.mode, label: MODE_LABEL[o.mode], disabled: o.disabled, hint: o.hint }))}
              />
            </Field>

            {pin.input_only && <Note>Output, PWM and Servo are not available: this pin is input-only.</Note>}
            {!pin.adc1 && pin.adc2 && <Note>Analog (ADC) is not available on this pin: ADC2 cannot be used while Wi-Fi is on.</Note>}
            {servoOwned && <Note>This pin is a servo. Only Servo mode (or Off) can be set directly; turn it Off first to use another mode.</Note>}
            {pin.strap && (
              <Note icon="alert" tone="warn">
                Strapping pin: its level at power-up changes how the board boots, so avoid wiring that holds it high or low then.
              </Note>
            )}
            {pin.status_led && <Note>Status LED: the device blinks it to show its state, so using it here can hide that.</Note>}
            {pin.boot_btn && <Note>BOOT button: holding it low at reset puts the chip into download mode.</Note>}
            {usedBy.length > 0 && <Note>Driven by {usedBy.length === 1 ? "rule" : "rules"} {usedBy.map((r) => r.id).join(", ")}.</Note>}
            {unknownOptions && <Note>Some options (invert, pull, boot level) were set outside this Manager and are unknown. They show as defaults here; saving writes what you see.</Note>}

            {mode === "disabled" && <p className="mut">Mode Off: the pin is unused and its saved settings are removed.</p>}

            {mode === "out" && (
              <>
                <Field label="Start level at boot" hint="Level used each time the device starts.">
                  <Segmented<"0" | "1"> value={form.boot === 1 ? "1" : "0"} onChange={(v) => patch({ boot: v === "1" ? 1 : 0 })} options={[{ value: "0", label: "Low" }, { value: "1", label: "High" }]} />
                </Field>
                <div className="pn-checks">
                  <Checkbox checked={form.invert} onChange={(v) => patch({ invert: v })} label="Invert" />
                  {canPull ? (
                    <>
                      <Checkbox checked={form.pullUp} onChange={(v) => patch({ pullUp: v })} label="Pull-up" />
                      <Checkbox checked={form.pullDown} onChange={(v) => patch({ pullDown: v })} label="Pull-down" />
                    </>
                  ) : (
                    <Note>No internal pull on this pin.</Note>
                  )}
                </div>
              </>
            )}

            {mode === "in" && (
              <>
                <div className="pn-checks">
                  <Checkbox checked={form.invert} onChange={(v) => patch({ invert: v })} label="Invert" />
                  {canPull ? (
                    <>
                      <Checkbox checked={form.pullUp} onChange={(v) => patch({ pullUp: v })} label="Pull-up" />
                      <Checkbox checked={form.pullDown} onChange={(v) => patch({ pullDown: v })} label="Pull-down" />
                    </>
                  ) : (
                    <Note>Input-only pin, no internal pull.</Note>
                  )}
                </div>
                <Field label="Debounce" hint={`${RANGES.debounce_ms.min}-${RANGES.debounce_ms.max} ms. Default ${RANGES.debounce_ms.def}.`} error={errors.debounce}>
                  <NumberInput value={form.debounce} onChange={(v) => patch({ debounce: v })} min={RANGES.debounce_ms.min} max={RANGES.debounce_ms.max} unit="ms" />
                </Field>
              </>
            )}

            {mode === "pwm" && (
              <>
                <div className="grid" style={{ "--min": "180px" } as CSSProperties}>
                  <Field label="Duty" hint={`Sent as duty ${Math.round((form.dutyPct ?? 0) * 10)} (0-1000). Used at boot.`} error={errors.dutyPct}>
                    <NumberInput value={form.dutyPct} onChange={(v) => patch({ dutyPct: v })} min={0} max={100} step={0.1} unit="%" />
                  </Field>
                  <Field label="Frequency (shared by all PWM pins)" hint={`${RANGES.hz.min}-${RANGES.hz.max} Hz. Default ${RANGES.hz.def}.`} error={errors.hz}>
                    <NumberInput value={form.hz} onChange={(v) => patch({ hz: v })} min={RANGES.hz.min} max={RANGES.hz.max} unit="Hz" />
                  </Field>
                </div>
                <Banner tone="warn" title="Frequency is shared by all PWM pins.">
                  {others.length > 0 ? `Changing it also changes GPIO ${others.join(", ")}.` : `No other pin uses PWM right now, so only GPIO ${pin.gpio} changes.`}
                </Banner>
              </>
            )}

            {mode === "servo" && (
              <>
                <Field label="Start angle" hint={`${RANGES.angle.min}-${RANGES.angle.max}°. Default ${RANGES.angle.def}.`} error={errors.angle}>
                  <NumberInput value={form.angle} onChange={(v) => patch({ angle: v })} min={RANGES.angle.min} max={RANGES.angle.max} unit="°" />
                </Field>
                <div className="grid" style={{ "--min": "180px" } as CSSProperties}>
                  <Field label="Min pulse" hint={`${RANGES.min_us.min}-${RANGES.min_us.max} µs.`} error={errors.minUs}>
                    <NumberInput value={form.minUs} onChange={(v) => patch({ minUs: v })} min={RANGES.min_us.min} max={RANGES.min_us.max} unit="µs" />
                  </Field>
                  <Field label="Max pulse" hint={`${RANGES.max_us.min}-${RANGES.max_us.max} µs.`} error={errors.maxUs}>
                    <NumberInput value={form.maxUs} onChange={(v) => patch({ maxUs: v })} min={RANGES.max_us.min} max={RANGES.max_us.max} unit="µs" />
                  </Field>
                </div>
              </>
            )}

            {mode === "adc" && (
              <>
                <Field label="Sample every" hint={`${RANGES.sample_ms.min}-${RANGES.sample_ms.max} ms. Default ${RANGES.sample_ms.def}.`} error={errors.sampleMs}>
                  <NumberInput value={form.sampleMs} onChange={(v) => patch({ sampleMs: v })} min={RANGES.sample_ms.min} max={RANGES.sample_ms.max} unit="ms" />
                </Field>
                <div className="grid" style={{ "--min": "180px" } as CSSProperties}>
                  <Field label="Hysteresis" hint={`${RANGES.hysteresis_mv.min}-${RANGES.hysteresis_mv.max} mV. Default ${RANGES.hysteresis_mv.def}.`} error={errors.hysteresis}>
                    <NumberInput value={form.hysteresis} onChange={(v) => patch({ hysteresis: v })} min={RANGES.hysteresis_mv.min} max={RANGES.hysteresis_mv.max} unit="mV" />
                  </Field>
                  <Field label="Smoothing" hint={`${RANGES.smooth.min}-${RANGES.smooth.max} %. Default ${RANGES.smooth.def}.`} error={errors.smooth}>
                    <NumberInput value={form.smooth} onChange={(v) => patch({ smooth: v })} min={RANGES.smooth.min} max={RANGES.smooth.max} unit="%" />
                  </Field>
                </div>
              </>
            )}

            {mode !== "disabled" && <p className="hint">Save sends <code>pin.configure</code> and keeps it across reboots. Only options that differ from the defaults are sent.</p>}
            {error && <InlineError message={error} />}
          </>
        )}
      </div>
    </Sheet>
  );
}
