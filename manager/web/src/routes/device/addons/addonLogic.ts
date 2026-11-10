import type {
  Bme280State,
  Hardware,
  HardwareBus,
  HardwarePin,
  Mfrc522State,
  ModuleCatalogPin,
  ModuleCatalogSetting,
  ModuleCatalogType,
  ModuleInstance,
} from "@shared/device-api";

export type SettingValue = number | string;

/** Wizard / edit form state. `undefined` pin = not chosen (optional roles only). */
export interface AddonForm {
  type: string;
  id: string;
  bus: string;
  pins: Record<string, number | undefined>;
  settings: Record<string, SettingValue | undefined>;
}

export const ADDON_ID_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

/** Role names as people know them (the firmware says `ss`, the data sheets say CS). */
export function roleLabel(role: string): string {
  if (role === "ss") return "CS";
  return role.toUpperCase();
}

export function busesOfKind(hardware: Hardware | null, kind: ModuleCatalogType["bus"]): HardwareBus[] {
  return (hardware?.buses ?? []).filter((b) => b.kind === kind);
}

function hwPin(hardware: Hardware | null, gpio: number): HardwarePin | undefined {
  return hardware?.pins.find((p) => p.gpio === gpio);
}

/** True when the pin's capabilities satisfy the role: never a flash pin; `in` needs input, `out` needs a real output. */
export function pinFitsRole(pin: HardwarePin, role: Pick<ModuleCatalogPin, "cap">): boolean {
  if (pin.flash) return false;
  return role.cap === "in" ? pin.input : pin.output && !pin.input_only;
}

/**
 * Pins offered for one catalog pin role: capable, not flash, and free (`owner` empty or this add-on's own
 * `mod_<editingId>`). `alsoOwnedBy` lists GPIOs that are allowed although another add-on holds them (the
 * same bus role of a sibling on the same bus).
 */
export function freePinsFor(role: Pick<ModuleCatalogPin, "cap">, hardware: Hardware | null, editingId?: string, alsoOwnedBy: readonly number[] = []): HardwarePin[] {
  if (!hardware) return [];
  return hardware.pins
    .filter((p) => pinFitsRole(p, role) && (p.owner === "" || (editingId !== undefined && p.owner === `mod_${editingId}`) || alsoOwnedBy.includes(p.gpio)))
    .sort((a, b) => a.gpio - b.gpio);
}

/** GPIOs another add-on on `bus` uses for `role` (those may be shared). */
export function siblingBusPins(role: string, bus: string, instances: readonly ModuleInstance[], editingId?: string): number[] {
  return instances
    .filter((i) => i.id !== editingId && i.bus === bus && i.enabled && i.pins[role] !== undefined)
    .map((i) => i.pins[role] as number);
}

/** `id_prefix` + the lowest unused number (the firmware's own rule). */
export function defaultAddonId(type: Pick<ModuleCatalogType, "id_prefix">, instances: readonly Pick<ModuleInstance, "id">[]): string {
  const used = new Set(instances.map((i) => i.id));
  let n = 0;
  while (used.has(`${type.id_prefix}${n}`)) n++;
  return `${type.id_prefix}${n}`;
}

export function instanceCount(type: Pick<ModuleCatalogType, "type">, instances: readonly Pick<ModuleInstance, "type">[]): number {
  return instances.filter((i) => i.type === type.type).length;
}

export function typeAtLimit(type: ModuleCatalogType, instances: readonly ModuleInstance[]): boolean {
  return instanceCount(type, instances) >= type.max_instances;
}

/** Bus pins (role -> gpio) for the chosen bus. */
function busPins(hardware: Hardware | null, bus: string): Record<string, number> {
  return hardware?.buses.find((b) => b.id === bus)?.pins ?? {};
}

/** Pre-fill the pins of `type` on `bus`: bus pins for bus roles, the bus's same-named pin when free, else the first free pin for required roles. */
export function defaultPins(type: ModuleCatalogType, bus: string, hardware: Hardware | null, instances: readonly ModuleInstance[], editingId?: string): Record<string, number | undefined> {
  const bp = busPins(hardware, bus);
  const out: Record<string, number | undefined> = {};
  const taken = new Set<number>();
  for (const role of type.pins) {
    const sibling = siblingBusPins(role.role, bus, instances, editingId);
    const free = freePinsFor(role, hardware, editingId, role.share === "bus" ? sibling : []).filter((p) => !taken.has(p.gpio));
    const fromBus = bp[role.role];
    let pick: number | undefined;
    if (role.share === "bus") {
      pick = sibling[0] ?? fromBus;
    } else if (fromBus !== undefined && free.some((p) => p.gpio === fromBus)) {
      pick = fromBus;
    } else if (role.required) {
      pick = (free.find((p) => !p.strap) ?? free[0])?.gpio;
    }
    out[role.role] = pick;
    if (pick !== undefined) taken.add(pick);
  }
  return out;
}

export function defaultSettings(type: ModuleCatalogType): Record<string, SettingValue> {
  return Object.fromEntries(type.settings.map((s) => [s.key, s.def]));
}

/** Blank form for a new add-on of `type`. */
export function defaultForm(type: ModuleCatalogType, hardware: Hardware | null, instances: readonly ModuleInstance[]): AddonForm {
  const buses = busesOfKind(hardware, type.bus);
  const bus = buses.some((b) => b.id === type.default_bus) ? type.default_bus : (buses[0]?.id ?? type.default_bus);
  return { type: type.type, id: defaultAddonId(type, instances), bus, pins: defaultPins(type, bus, hardware, instances), settings: defaultSettings(type) };
}

/** Form for editing an existing instance (settings missing on the device fall back to the catalog default). */
export function formFromInstance(inst: ModuleInstance, type: ModuleCatalogType): AddonForm {
  const settings: Record<string, SettingValue | undefined> = {};
  for (const s of type.settings) settings[s.key] = inst.settings?.[s.key] ?? s.def;
  const pins: Record<string, number | undefined> = {};
  for (const p of type.pins) pins[p.role] = inst.pins[p.role];
  return { type: inst.type, id: inst.id, bus: inst.bus, pins, settings };
}

export interface AddonErrors {
  id?: string;
  bus?: string;
  /** Limit reached etc.: not tied to one field. */
  general?: string;
  pins: Record<string, string>;
  settings: Record<string, string>;
}

export interface AddonValidation {
  errors: AddonErrors;
  valid: boolean;
  /** Step-level flags so the wizard can gate "Next". */
  pinsOk: boolean;
  settingsOk: boolean;
}

export interface AddonContext {
  type: ModuleCatalogType;
  hardware: Hardware | null;
  instances: readonly ModuleInstance[];
  /** Set when editing: the id is fixed and the add-on's own pins count as free. */
  editingId?: string;
}

/** Mirrors the firmware's checks (spec 2.5 `module.add`) so most mistakes are caught before sending. */
export function validateAddonForm(form: AddonForm, ctx: AddonContext): AddonValidation {
  const { type, hardware, instances, editingId } = ctx;
  const errors: AddonErrors = { pins: {}, settings: {} };

  if (editingId === undefined) {
    if (!ADDON_ID_PATTERN.test(form.id)) errors.id = "Use a-z, 0-9 and _, start with a letter, at most 16 characters.";
    else if (instances.some((i) => i.id === form.id)) errors.id = "id already in use";
    if (typeAtLimit(type, instances)) errors.general = `${type.type} limited to ${type.max_instances} instances`;
  }

  const buses = busesOfKind(hardware, type.bus);
  if (!buses.some((b) => b.id === form.bus)) errors.bus = `Bus must be ${buses.map((b) => b.id).join(" or ") || "one of the device's buses"}.`;

  const seen = new Map<number, string>();
  for (const role of type.pins) {
    const gpio = form.pins[role.role];
    if (gpio === undefined) {
      if (role.required) errors.pins[role.role] = `${roleLabel(role.role)} is required`;
      continue;
    }
    const pin = hwPin(hardware, gpio);
    if (!pin) {
      errors.pins[role.role] = `GPIO ${gpio} does not exist on this board`;
      continue;
    }
    if (pin.flash) errors.pins[role.role] = `GPIO ${gpio} is used by the flash chip`;
    else if (!pinFitsRole(pin, role)) errors.pins[role.role] = role.cap === "in" ? `GPIO ${gpio} cannot be used as an input` : `GPIO ${gpio} cannot be used as an output`;
    else if (seen.has(gpio)) errors.pins[role.role] = `module pins must be unique (GPIO ${gpio} is also ${roleLabel(seen.get(gpio) as string)})`;
    seen.set(gpio, role.role);
    if (errors.pins[role.role]) continue;
    const shared = role.share === "bus" ? siblingBusPins(role.role, form.bus, instances, editingId) : [];
    const owner = pin.owner;
    if (owner !== "" && owner !== `mod_${editingId ?? ""}` && !shared.includes(gpio)) errors.pins[role.role] = `GPIO ${gpio} is in use (${owner})`;
    else if (role.share === "bus" && shared.length > 0 && !shared.includes(gpio)) errors.pins[role.role] = "shared bus pins must match the other add-on on this bus";
  }

  for (const s of type.settings) {
    const v = form.settings[s.key];
    const msg = validateSetting(s, v);
    if (msg) errors.settings[s.key] = msg;
    else if (type.bus === "i2c" && s.key === "addr") {
      const clash = instances.find((i) => i.id !== editingId && i.bus === form.bus && i.type === type.type && i.enabled && (i.settings?.[s.key] ?? s.def) === v);
      if (clash) errors.settings[s.key] = `Already used by ${clash.id} on ${form.bus}. Two sensors on one bus need different addresses.`;
    }
  }

  const pinsOk = !errors.bus && Object.keys(errors.pins).length === 0 && !errors.id && !errors.general;
  const settingsOk = Object.keys(errors.settings).length === 0;
  return { errors, valid: pinsOk && settingsOk, pinsOk, settingsOk };
}

export function validateSetting(s: ModuleCatalogSetting, v: SettingValue | undefined): string | null {
  if (s.kind === "enum") {
    return s.choices?.some((c) => c.value === v) ? null : `Choose one of the listed values`;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) return "Enter a whole number";
  if (s.min !== undefined && v < s.min) return `Must be at least ${s.min}`;
  if (s.max !== undefined && v > s.max) return `Must be at most ${s.max}`;
  return null;
}

function definedPins(pins: AddonForm["pins"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(pins)) if (v !== undefined) out[k] = v;
  return out;
}

function definedSettings(settings: AddonForm["settings"]): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [k, v] of Object.entries(settings)) if (v !== undefined) out[k] = v;
  return out;
}

export type ModuleAddBody = {
  cmd: "module.add";
  type: string;
  id: string;
  bus: string;
  pins: Record<string, number>;
  settings: Record<string, SettingValue>;
};

export function buildModuleAdd(form: AddonForm): ModuleAddBody {
  return { cmd: "module.add", type: form.type, id: form.id, bus: form.bus, pins: definedPins(form.pins), settings: definedSettings(form.settings) };
}

export type ModuleConfigureBody = {
  cmd: "module.configure";
  id: string;
  bus?: string;
  pins?: Record<string, number>;
  settings?: Record<string, SettingValue>;
  enabled?: boolean;
};

const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
};

/**
 * `module.configure` with only the fields that changed (missing fields inherit on the device). `pins` and
 * `settings` are sent whole when any entry of them changed. `null` = nothing changed.
 */
export function buildModuleConfigure(form: AddonForm, original: ModuleInstance, type: ModuleCatalogType): ModuleConfigureBody | null {
  const body: ModuleConfigureBody = { cmd: "module.configure", id: original.id };
  let changed = false;
  if (form.bus !== original.bus) {
    body.bus = form.bus;
    changed = true;
  }
  const pins = definedPins(form.pins);
  if (form.bus !== original.bus || !sameRecord(pins, original.pins)) {
    body.pins = pins;
    changed = true;
  }
  const before = formFromInstance(original, type).settings;
  const settings = definedSettings(form.settings);
  if (!sameRecord(settings, definedSettings(before))) {
    body.settings = settings;
    changed = true;
  }
  return changed ? body : null;
}

// ---- Live readings ---------------------------------------------------------------------------------------------

export interface AddonReading {
  /** Headline value ("23.4 °C", "Tag 04A1B2"); `null` when there is nothing to show. */
  primary: string;
  secondary?: string;
  /** True for "No sensor" / "No tag" (rendered muted). */
  empty: boolean;
}

/** One-line live summary of an add-on state (BME280, MFRC522); unknown types show nothing special. */
export function describeReading(state: Bme280State | Mfrc522State | undefined | null, enabled = true): AddonReading {
  if (!enabled) return { primary: "Disabled", empty: true };
  if (!state) return { primary: "No reading yet", empty: true };
  if (state.type === "bme280") {
    if (!state.ok || state.t_c === undefined) return { primary: "No sensor", empty: true };
    const parts: string[] = [];
    if (state.rh !== undefined) parts.push(`${state.rh.toFixed(0)} %RH`);
    if (state.p_hpa !== undefined) parts.push(`${state.p_hpa.toFixed(0)} hPa`);
    return { primary: `${state.t_c.toFixed(1)} °C`, secondary: parts.join(" · ") || undefined, empty: false };
  }
  if (state.type === "mfrc522") {
    return state.present && state.uid ? { primary: `Tag ${state.uid}`, secondary: "Latest tag read", empty: false } : { primary: "No tag", empty: true };
  }
  return { primary: "No reading yet", empty: true };
}

export function pinSummary(type: ModuleCatalogType | undefined, inst: ModuleInstance): string {
  const roles = type ? type.pins.map((p) => p.role) : Object.keys(inst.pins);
  return roles
    .filter((r) => inst.pins[r] !== undefined)
    .map((r) => `${roleLabel(r)} ${inst.pins[r]}`)
    .join(" · ");
}

export function settingText(s: ModuleCatalogSetting, v: SettingValue | undefined): string {
  const value = v ?? s.def;
  if (s.kind === "enum") return s.choices?.find((c) => c.value === value)?.label ?? String(value);
  return String(value);
}

export function busLabel(type: ModuleCatalogType | undefined, bus: string): string {
  const kind = type?.bus === "i2c" ? "I²C" : type?.bus === "spi" ? "SPI" : "";
  return kind ? `${kind} · ${bus}` : bus;
}
