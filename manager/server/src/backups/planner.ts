import type { BackupFile, BackupInclude, BackupModule, BackupPin, BackupPlan, BackupPlanStep, BackupRule, BackupStepOp } from "../types/api-backups";
import type { DeviceConfigState } from "./deviceState";

/**
 * The planner: a pure function from (backup, what the target looks like now, what to include) to the steps that make the
 * target match. Nothing already equal produces a step. Order (spec 3.8): remove rules, remove add-ons, disable pins,
 * configure pins, add/configure add-ons, set rules, MQTT, name.
 */

export type ResolvedInclude = Required<BackupInclude>;

export function resolveInclude(include: BackupInclude | undefined, _opts: { clone: boolean }): ResolvedInclude {
  return {
    pins: include?.pins ?? true,
    modules: include?.modules ?? true,
    rules: include?.rules ?? true,
    mqtt: include?.mqtt ?? true,
    name: include?.name ?? false,
  };
}

export type PlanBody = Pick<BackupPlan, "steps" | "conflicts" | "warnings" | "unchanged">;

type Cfg = Record<string, unknown>;

const truthy = (v: unknown, def = false): boolean => (v === undefined || v === null ? def : v === true || v === 1);
const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);

/** A pin config with the device's defaults filled in, so "not set" and "set to the default" compare equal. */
export function normalizePin(cfg: Cfg): Cfg {
  const n: Cfg = { gpio: cfg.gpio, mode: cfg.mode };
  switch (cfg.mode) {
    case "out":
      n.invert = truthy(cfg.invert);
      n.pull_up = truthy(cfg.pull_up);
      n.pull_down = truthy(cfg.pull_down);
      n.boot = truthy(cfg.boot) ? 1 : 0;
      break;
    case "in":
      n.invert = truthy(cfg.invert);
      n.pull_up = truthy(cfg.pull_up);
      n.pull_down = truthy(cfg.pull_down);
      n.irq = truthy(cfg.irq, true);
      n.debounce_ms = num(cfg.debounce_ms, 50);
      break;
    case "pwm":
      n.hz = num(cfg.hz, 1000);
      n.duty = num(cfg.duty, 0);
      break;
    case "servo":
      n.angle = num(cfg.angle, 90);
      n.min_us = num(cfg.min_us, 500);
      n.max_us = num(cfg.max_us, 2500);
      break;
    case "adc":
      n.sample_ms = num(cfg.sample_ms, 50);
      n.hysteresis_mv = num(cfg.hysteresis_mv, 20);
      n.smooth = num(cfg.smooth, 70);
      break;
  }
  if (cfg.delivery !== undefined) n.delivery = cfg.delivery;
  return n;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function normalizeRule(r: { enabled: boolean; on: BackupRule["on"]; then: BackupRule["then"]; else?: BackupRule["else"] }): Cfg {
  return { enabled: r.enabled, on: { gpio: r.on.gpio, op: r.on.op, value: r.on.value }, then: { gpio: r.then.gpio, value: r.then.value }, ...(r.else ? { else: { gpio: r.else.gpio, value: r.else.value } } : {}) };
}

const OP_TEXT: Record<string, string> = { gt: ">", ge: ">=", lt: "<", le: "<=", eq: "=", ne: "!=" };

const moduleLabel = (type: string): string => type.toUpperCase();
const quoted = (s: string): string => `"${s}"`;

function pinSummary(cfg: Cfg): string {
  const gpio = String(cfg.gpio);
  const n = normalizePin(cfg);
  const extras: string[] = [];
  let what: string;
  switch (n.mode) {
    case "out":
      what = "output";
      if (n.invert) extras.push("inverted");
      if (n.boot === 1) extras.push("starts high");
      if (n.pull_up) extras.push("pull-up");
      if (n.pull_down) extras.push("pull-down");
      break;
    case "in":
      what = "input";
      if (n.pull_up) extras.push("pull-up");
      if (n.pull_down) extras.push("pull-down");
      if (n.invert) extras.push("inverted");
      if (n.irq === false) extras.push("no change events");
      if (n.debounce_ms !== 50) extras.push(`${String(n.debounce_ms)} ms debounce`);
      break;
    case "pwm":
      what = "PWM output";
      extras.push(`${String(n.hz)} Hz`, `duty ${String(n.duty)}`);
      break;
    case "servo":
      what = "servo";
      extras.push(`angle ${String(n.angle)}`);
      break;
    default:
      what = "analog input";
  }
  return `Set GPIO ${gpio} to ${what}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function ruleSummary(r: BackupRule): string {
  const els = r.else ? `, otherwise ${r.else.value}${r.else.gpio === r.then.gpio ? "" : ` on GPIO ${r.else.gpio}`}` : "";
  return `Set rule ${r.id}: when GPIO ${r.on.gpio} ${OP_TEXT[r.on.op] ?? r.on.op} ${r.on.value}, set GPIO ${r.then.gpio} to ${r.then.value}${els}`;
}

function modulePinsText(m: BackupModule): string {
  const parts = Object.entries(m.pins).map(([role, g]) => `${role} ${g}`);
  return `${m.bus ? `${m.bus}, ` : ""}${parts.join(", ")}`;
}

/** The target's add-on matches the backup's when the bus, enabled flag, every pin role and every listed setting agree. */
function sameModule(b: BackupModule, t: { bus: string; enabled: boolean; pins: Record<string, number>; settings?: Record<string, number | string> }): boolean {
  if (b.bus !== t.bus || b.enabled !== t.enabled) return false;
  for (const [role, g] of Object.entries(b.pins)) if (t.pins[role] !== g) return false;
  for (const [k, v] of Object.entries(b.settings ?? {})) if (String(t.settings?.[k]) !== String(v)) return false;
  return true;
}

function pinOfCmd(p: BackupPin): Cfg {
  const { _from: _ignored, ...rest } = p;
  void _ignored;
  return rest;
}

export function planBackup(backup: BackupFile, target: DeviceConfigState, include: ResolvedInclude): PlanBody {
  const removeRules: BackupPlanStep[] = [];
  const removeModules: BackupPlanStep[] = [];
  const disablePins: BackupPlanStep[] = [];
  const configurePins: BackupPlanStep[] = [];
  const addModules: BackupPlanStep[] = [];
  const setRules: BackupPlanStep[] = [];
  const tail: BackupPlanStep[] = [];
  const conflicts: { message: string }[] = [];
  const warnings: string[] = [];
  const unchanged = { pins: 0, modules: 0, rules: 0 };
  const step = (list: BackupPlanStep[], id: string, op: BackupStepOp, summary: string, cmd: Cfg): void => {
    list.push({ id, op, summary, cmd });
  };

  const useModules = include.modules && !backup.gaps.includes("modules_unavailable") && target.modules !== null;
  const useRules = include.rules && !backup.gaps.includes("rules_unavailable") && target.rules !== null;
  if (include.modules && backup.gaps.includes("modules_unavailable")) warnings.push("This backup has no add-on list (the device did not report one), so the add-ons on the target are left as they are.");
  else if (include.modules && target.modules === null) warnings.push("This device did not report its add-ons, so they are left as they are.");
  if (include.rules && backup.gaps.includes("rules_unavailable")) warnings.push("This backup has no rule list (the device did not report one), so the rules on the target are left as they are.");
  else if (include.rules && target.rules === null) warnings.push("This device did not report its rules, so they are left as they are.");

  // ---- add-ons: what stays on the target decides which GPIOs are taken -------------------------------------------
  const backupModuleKey = new Map(backup.modules.map((m) => [m.id, m]));
  const targetModules = target.modules ?? [];
  const staysAfter = new Map<string, { id: string; pins: Record<string, number>; enabled: boolean }>();
  if (useModules) {
    for (const m of backup.modules) staysAfter.set(m.id, m);
  } else {
    for (const m of targetModules) staysAfter.set(m.id, m);
  }
  const moduleOwner = new Map<number, string>();
  for (const m of staysAfter.values()) if (m.enabled) for (const g of Object.values(m.pins)) moduleOwner.set(g, m.id);

  // ---- pins -----------------------------------------------------------------------------------------------------
  const targetPins = new Map(target.pins.map((p) => [p.gpio, p]));
  const backupPinGpios = new Set(backup.pins.map((p) => p.gpio));
  const disabled = new Set<number>();
  const lossy: number[] = [];
  const pinsAfter = new Set<number>(include.pins ? [] : target.pins.map((p) => p.gpio));
  if (include.pins) {
    for (const t of target.pins) {
      if (backupPinGpios.has(t.gpio)) continue;
      disabled.add(t.gpio);
      step(disablePins, `pin.disable:${t.gpio}`, "pin.disable", `Turn off GPIO ${t.gpio}`, { cmd: "pin.configure", gpio: t.gpio, mode: "disabled" });
    }
    for (const p of backup.pins) {
      const owner = moduleOwner.get(p.gpio);
      if (owner !== undefined) {
        conflicts.push({ message: `GPIO ${p.gpio} is used by the add-on ${quoted(owner)} on the target, so it cannot also be set up as a pin.` });
        continue;
      }
      const cfg = pinOfCmd(p);
      const t = targetPins.get(p.gpio);
      if (t && sameJson(normalizePin(t.config), normalizePin(cfg))) {
        unchanged.pins++;
        pinsAfter.add(p.gpio);
        continue;
      }
      pinsAfter.add(p.gpio);
      step(configurePins, `pin.configure:${p.gpio}`, "pin.configure", pinSummary(cfg), { cmd: "pin.configure", ...cfg });
      if (p._from === "live" && (p.mode === "out" || p.mode === "in")) lossy.push(p.gpio);
    }
    if (lossy.length > 0) {
      warnings.push(`Some options of GPIO ${lossy.join(", ")} could not be read when this backup was made (inversion, pull-ups, start level), so ${lossy.length === 1 ? "that pin is" : "those pins are"} restored with default options.`);
    }
  }

  // ---- add-ons: the steps ---------------------------------------------------------------------------------------
  if (useModules) {
    for (const t of targetModules) {
      const b = backupModuleKey.get(t.id);
      if (!b || b.type !== t.type) step(removeModules, `module.remove:${t.id}`, "module.remove", `Remove the ${moduleLabel(t.type)} add-on ${quoted(t.id)}`, { cmd: "module.remove", id: t.id });
    }
    for (const b of backup.modules) {
      const clash = b.enabled ? Object.values(b.pins).find((g) => pinsAfter.has(g)) : undefined;
      if (clash !== undefined) {
        conflicts.push({ message: `The add-on ${quoted(b.id)} needs GPIO ${clash}, which is set up as a pin on the target and stays that way.` });
        continue;
      }
      const t = targetModules.find((m) => m.id === b.id && m.type === b.type);
      const fields: Cfg = { id: b.id, bus: b.bus, enabled: b.enabled, pins: { ...b.pins }, ...(b.settings ? { settings: { ...b.settings } } : {}) };
      if (t) {
        if (sameModule(b, t)) unchanged.modules++;
        else step(addModules, `module.configure:${b.id}`, "module.configure", `Update the ${moduleLabel(b.type)} add-on ${quoted(b.id)} (${modulePinsText(b)})`, { cmd: "module.configure", ...fields });
      } else {
        step(addModules, `module.add:${b.id}`, "module.add", `Add the ${moduleLabel(b.type)} add-on ${quoted(b.id)} (${modulePinsText(b)})`, { cmd: "module.add", type: b.type, ...fields });
      }
    }
  }

  // ---- rules ----------------------------------------------------------------------------------------------------
  if (useRules) {
    const backupRuleIds = new Set(backup.rules.map((r) => r.id));
    for (const t of target.rules ?? []) {
      if (!backupRuleIds.has(t.id)) step(removeRules, `rule.remove:${t.id}`, "rule.remove", `Remove rule ${t.id}`, { cmd: "rule.remove", id: t.id });
    }
    for (const r of backup.rules) {
      const t = (target.rules ?? []).find((x) => x.id === r.id);
      if (t && sameJson(normalizeRule(t), normalizeRule(r))) {
        unchanged.rules++;
        continue;
      }
      step(setRules, `rule.set:${r.id}`, "rule.set", ruleSummary(r), { cmd: "rule.set", rule: { id: r.id, enabled: r.enabled, on: { ...r.on }, then: { ...r.then }, ...(r.else ? { else: { ...r.else } } : {}) } });
    }
    const known = (g: number): boolean => pinsAfter.has(g) || moduleOwner.has(g);
    for (const r of backup.rules) {
      const missing = [r.on.gpio, r.then.gpio, ...(r.else ? [r.else.gpio] : [])].filter((g) => !known(g));
      if (missing.length > 0) warnings.push(`Rule ${r.id} uses GPIO ${[...new Set(missing)].join(", ")}, which will not be set up on the target.`);
    }
  } else if (include.pins && disabled.size > 0) {
    for (const t of target.rules ?? []) {
      const used = [t.on.gpio, t.then.gpio, ...(t.else ? [t.else.gpio] : [])].filter((g) => disabled.has(g));
      if (used.length > 0) warnings.push(`Rule ${t.id} (kept as it is) uses GPIO ${[...new Set(used)].join(", ")}, which this restore turns off.`);
    }
  }

  // ---- MQTT and name --------------------------------------------------------------------------------------------
  if (include.mqtt) {
    if (backup.mqtt === null) {
      if (target.mqtt) warnings.push("This backup has no MQTT settings, and a device cannot switch MQTT off, so it keeps its current ones.");
    } else if (!target.mqtt || target.mqtt.uri !== backup.mqtt.uri || (backup.mqtt.root !== "" && target.mqtt.root !== backup.mqtt.root)) {
      step(tail, "mqtt.configure", "mqtt.configure", `Point MQTT at ${backup.mqtt.uri}${backup.mqtt.root ? ` (topic root ${quoted(backup.mqtt.root)})` : ""}`, {
        cmd: "mqtt.configure",
        uri: backup.mqtt.uri,
        ...(backup.mqtt.root ? { root: backup.mqtt.root } : {}),
      });
      warnings.push("MQTT user names and passwords are not stored in backups. The device keeps the login it already has; if the broker needs one, enter it on the device afterwards.");
    }
  }
  if (include.name && backup.name !== "" && backup.name !== target.name) {
    step(tail, "identity.set_name", "identity.set_name", `Rename the device to ${quoted(backup.name)}`, { cmd: "identity.set_name", name: backup.name });
  }

  return {
    steps: [...removeRules, ...removeModules, ...disablePins, ...configurePins, ...addModules, ...setRules, ...tail],
    conflicts,
    warnings,
    unchanged,
  };
}
