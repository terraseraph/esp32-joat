import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DeviceConfigState, LivePin } from "../src/backups/deviceState";
import { normalizePin, planBackup, resolveInclude, type ResolvedInclude } from "../src/backups/planner";
import type { BackupFile, BackupModule, BackupPin, BackupRule } from "../src/types/api-backups";

const ALL = resolveInclude({ name: true }, { clone: false });

function backup(over: Partial<BackupFile> = {}): BackupFile {
  return {
    kind: "de-esp32-backup",
    v: 1,
    createdAt: "2026-11-10T10:00:00.000Z",
    manager: "0.1.0",
    source: { id: "a4cf12b3c4d5", name: "Source", app_version: "9dcba89" },
    name: "Source",
    pins: [],
    modules: [],
    rules: [],
    mqtt: null,
    gaps: [],
    ...over,
  };
}

function target(over: Partial<DeviceConfigState> = {}): DeviceConfigState {
  return { name: "Source", appVersion: "9dcba89", pins: [], modules: [], rules: [], mqtt: null, ...over };
}

const pin = (gpio: number, mode: BackupPin["mode"], extra: Record<string, unknown> = {}, from: BackupPin["_from"] = "shadow"): BackupPin => ({ gpio, mode, _from: from, ...extra }) as BackupPin;
const live = (gpio: number, mode: LivePin["mode"], extra: Record<string, unknown> = {}, from: LivePin["from"] = "shadow"): LivePin => ({ gpio, mode, config: { gpio, mode, ...extra }, from });
const bme = (over: Partial<BackupModule> = {}): BackupModule => ({ id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 }, settings: { addr: 118 }, ...over });
const rule = (id: string, over: Partial<BackupRule> = {}): BackupRule => ({ id, enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, ...over });
const ids = (p: ReturnType<typeof planBackup>): string[] => p.steps.map((s) => s.id);

describe("planner: pins", () => {
  test("an empty target gets every pin as one configure step with a plain summary", () => {
    const p = planBackup(backup({ pins: [pin(4, "out", { invert: true }), pin(27, "in", { pull_up: true })] }), target(), ALL);
    assert.deepEqual(ids(p), ["pin.configure:4", "pin.configure:27"]);
    assert.equal(p.steps[0]?.summary, "Set GPIO 4 to output (inverted)");
    assert.equal(p.steps[1]?.summary, "Set GPIO 27 to input (pull-up)");
    assert.deepEqual(p.steps[0]?.cmd, { cmd: "pin.configure", gpio: 4, mode: "out", invert: true }, "no _from in the command");
    assert.deepEqual(p.unchanged, { pins: 0, modules: 0, rules: 0 });
  });

  test("equal pins need no step, defaults count as equal, differences do", () => {
    const b = backup({ pins: [pin(4, "out", { boot: 0 }), pin(27, "in", { pull_up: true }), pin(18, "pwm", { hz: 1000, duty: 250 })] });
    const t = target({ pins: [live(4, "out"), live(27, "in", { pull_up: true, irq: true }), live(18, "pwm", { duty: 100 })] });
    const p = planBackup(b, t, ALL);
    assert.deepEqual(ids(p), ["pin.configure:18"]);
    assert.deepEqual(p.unchanged, { pins: 2, modules: 0, rules: 0 });
  });

  test("a pin on the target that the backup lacks is turned off before pins are configured", () => {
    const p = planBackup(backup({ pins: [pin(4, "out")] }), target({ pins: [live(7, "out"), live(8, "in")] }), ALL);
    assert.deepEqual(ids(p), ["pin.disable:7", "pin.disable:8", "pin.configure:4"]);
    assert.deepEqual(p.steps[0]?.cmd, { cmd: "pin.configure", gpio: 7, mode: "disabled" });
    assert.equal(p.steps[0]?.summary, "Turn off GPIO 7");
  });

  test("a mode change on the same GPIO is one configure step", () => {
    const p = planBackup(backup({ pins: [pin(4, "pwm", { hz: 500 })] }), target({ pins: [live(4, "out")] }), ALL);
    assert.deepEqual(ids(p), ["pin.configure:4"]);
    assert.match(p.steps[0]?.summary ?? "", /PWM output \(500 Hz, duty 0\)/);
  });

  test("pins read from the live state warn that options are restored as defaults", () => {
    const p = planBackup(backup({ pins: [pin(13, "out", {}, "live"), pin(18, "pwm", {}, "live")] }), target(), ALL);
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0] ?? "", /GPIO 13 could not be read|Some options of GPIO 13/);
    assert.ok(!(p.warnings[0] ?? "").includes("18"), "pwm pins are fully known from live state");
  });

  test("include.pins=false leaves pins alone", () => {
    const p = planBackup(backup({ pins: [pin(4, "out")] }), target({ pins: [live(7, "out")] }), { ...ALL, pins: false });
    assert.deepEqual(ids(p), []);
  });

  test("normalizePin fills the device defaults", () => {
    assert.deepEqual(normalizePin({ gpio: 4, mode: "out", boot: true }), { gpio: 4, mode: "out", invert: false, pull_up: false, pull_down: false, boot: 1 });
  });
});

describe("planner: add-ons", () => {
  test("an add-on missing on the target is added, with its pins in the summary", () => {
    const p = planBackup(backup({ modules: [bme()] }), target(), ALL);
    assert.deepEqual(ids(p), ["module.add:env0"]);
    assert.equal(p.steps[0]?.summary, 'Add the BME280 add-on "env0" (i2c0, sda 21, scl 22)');
    assert.deepEqual(p.steps[0]?.cmd, { cmd: "module.add", type: "bme280", id: "env0", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 }, settings: { addr: 118 } });
  });

  test("same id and type: equal = nothing (backup settings may be a subset), different = configure", () => {
    const t = target({ modules: [{ id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 }, settings: { addr: 118, sample_ms: 1000 } }] });
    assert.deepEqual(ids(planBackup(backup({ modules: [bme()] }), t, ALL)), []);
    const changed = planBackup(backup({ modules: [bme({ settings: { addr: 119 } })] }), t, ALL);
    assert.deepEqual(ids(changed), ["module.configure:env0"]);
    assert.equal(changed.unchanged.modules, 0);
  });

  test("a target add-on that is not in the backup, or has another type, is removed first", () => {
    const t = target({ modules: [{ id: "old", type: "mfrc522", bus: "vspi", enabled: true, pins: { sda: 5 } }, { id: "env0", type: "mfrc522", bus: "vspi", enabled: true, pins: {} }] });
    const p = planBackup(backup({ modules: [bme()] }), t, ALL);
    assert.deepEqual(ids(p), ["module.remove:old", "module.remove:env0", "module.add:env0"]);
  });

  test("an add-on whose pin the target uses as a pin: the pin is turned off first when the backup has no such pin", () => {
    const p = planBackup(backup({ modules: [bme()] }), target({ pins: [live(21, "out")] }), ALL);
    assert.deepEqual(ids(p), ["pin.disable:21", "module.add:env0"]);
    assert.deepEqual(p.conflicts, []);
  });

  test("conflict: a backup pin on a GPIO of an add-on that stays (modules excluded)", () => {
    const t = target({ modules: [{ id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 } }] });
    const p = planBackup(backup({ pins: [pin(21, "out"), pin(4, "out")] }), t, { ...ALL, modules: false });
    assert.deepEqual(ids(p), ["pin.configure:4"], "the colliding step is left out");
    assert.equal(p.conflicts.length, 1);
    assert.match(p.conflicts[0]?.message ?? "", /GPIO 21 is used by the add-on "env0"/);
  });

  test("conflict: a backup add-on that needs a GPIO the target keeps as a pin (pins excluded)", () => {
    const p = planBackup(backup({ modules: [bme()] }), target({ pins: [live(22, "in")] }), { ...ALL, pins: false });
    assert.deepEqual(ids(p), []);
    assert.match(p.conflicts[0]?.message ?? "", /needs GPIO 22/);
  });

  test("conflict: a backup pin on an add-on's GPIO inside the same backup", () => {
    const p = planBackup(backup({ pins: [pin(21, "out")], modules: [bme()] }), target(), ALL);
    assert.deepEqual(ids(p), ["module.add:env0"]);
    assert.equal(p.conflicts.length, 1);
  });

  test("a backup without an add-on list leaves the target's add-ons alone and says so", () => {
    const t = target({ modules: [{ id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 } }] });
    const p = planBackup(backup({ gaps: ["modules_unavailable"] }), t, ALL);
    assert.deepEqual(ids(p), []);
    assert.match(p.warnings[0] ?? "", /no add-on list/);
  });

  test("a target that does not report add-ons leaves them alone and says so", () => {
    const p = planBackup(backup({ modules: [bme()] }), target({ modules: null }), ALL);
    assert.deepEqual(ids(p), []);
    assert.match(p.warnings[0] ?? "", /did not report its add-ons/);
  });
});

describe("planner: rules", () => {
  test("missing rules are set; equal rules are not; other rules on the target are removed first", () => {
    const t = target({
      pins: [live(4, "out"), live(32, "adc")],
      rules: [
        { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 } },
        { id: "x1", enabled: true, on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 4, value: 0 } },
      ],
    });
    const b = backup({ pins: [pin(4, "out"), pin(32, "adc")], rules: [rule("r32"), rule("r9", { on: { gpio: 32, op: "lt", value: 10 }, then: { gpio: 4, value: 0 } })] });
    const p = planBackup(b, t, ALL);
    assert.deepEqual(ids(p), ["rule.remove:x1", "rule.set:r9"]);
    assert.equal(p.unchanged.rules, 1);
    assert.equal(p.steps[1]?.summary, "Set rule r9: when GPIO 32 < 10, set GPIO 4 to 0");
    assert.deepEqual(p.steps[0]?.cmd, { cmd: "rule.remove", id: "x1" });
  });

  test("a changed rule with the same id is set again", () => {
    const t = target({ pins: [live(4, "out"), live(32, "adc")], rules: [{ id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 500 }, then: { gpio: 4, value: 1 } }] });
    const p = planBackup(backup({ pins: [pin(4, "out"), pin(32, "adc")], rules: [rule("r32", { else: { gpio: 4, value: 0 } })] }), t, ALL);
    assert.deepEqual(ids(p), ["rule.set:r32"]);
    assert.match(p.steps[0]?.summary ?? "", /otherwise 0/);
  });

  test("rules referencing pins that are being turned off: kept rules warn", () => {
    const t = target({ pins: [live(7, "out")], rules: [{ id: "r5", enabled: true, on: { gpio: 5, op: "gt", value: 1 }, then: { gpio: 7, value: 1 } }] });
    const p = planBackup(backup(), t, { ...ALL, rules: false });
    assert.deepEqual(ids(p), ["pin.disable:7"]);
    assert.match(p.warnings.join(" "), /Rule r5 \(kept as it is\) uses GPIO 7/);
  });

  test("rules referencing pins that are being turned off: included rules are removed before the pin goes", () => {
    const t = target({ pins: [live(7, "out")], rules: [{ id: "r5", enabled: true, on: { gpio: 5, op: "gt", value: 1 }, then: { gpio: 7, value: 1 } }] });
    const p = planBackup(backup(), t, ALL);
    assert.deepEqual(ids(p), ["rule.remove:r5", "pin.disable:7"]);
  });

  test("a backup rule that uses a GPIO the target will not have warns", () => {
    const p = planBackup(backup({ rules: [rule("r32")] }), target(), ALL);
    assert.match(p.warnings.join(" "), /Rule r32 uses GPIO 32, 4/);
  });

  test("backup without a rule list leaves rules alone", () => {
    const t = target({ rules: [{ id: "r1", enabled: true, on: { gpio: 1, op: "gt", value: 1 }, then: { gpio: 2, value: 1 } }] });
    assert.deepEqual(ids(planBackup(backup({ gaps: ["rules_unavailable"] }), t, ALL)), []);
  });
});

describe("planner: MQTT, name and order", () => {
  test("MQTT: set when different, nothing when equal, never wipes; the credentials warning is shown with the step", () => {
    const b = backup({ mqtt: { uri: "mqtt://10.0.0.2:1883", root: "devices" } });
    const p = planBackup(b, target(), ALL);
    assert.deepEqual(ids(p), ["mqtt.configure"]);
    assert.deepEqual(p.steps[0]?.cmd, { cmd: "mqtt.configure", uri: "mqtt://10.0.0.2:1883", root: "devices" }, "no user/password keys, so the device keeps its login");
    assert.match(p.warnings.join(" "), /not stored in backups/);
    assert.deepEqual(ids(planBackup(b, target({ mqtt: { uri: "mqtt://10.0.0.2:1883", root: "devices" } }), ALL)), []);
    const none = planBackup(backup({ mqtt: null }), target({ mqtt: { uri: "mqtt://x", root: "devices" } }), ALL);
    assert.deepEqual(ids(none), []);
    assert.match(none.warnings.join(" "), /cannot switch MQTT off/);
  });

  test("name only when included and different", () => {
    assert.deepEqual(ids(planBackup(backup({ name: "Workshop" }), target(), ALL)), ["identity.set_name"]);
    assert.deepEqual(ids(planBackup(backup({ name: "Workshop" }), target({ name: "Workshop" }), ALL)), []);
    assert.equal(resolveInclude(undefined, { clone: false }).name, false, "restore: name is opt-in");
    const clone: ResolvedInclude = resolveInclude(undefined, { clone: true });
    assert.equal(clone.name, false);
    assert.deepEqual(ids(planBackup(backup({ name: "Workshop" }), target(), clone)), []);
    assert.deepEqual(resolveInclude({ name: true }, { clone: true }).name, true);
  });

  test("all kinds together run in the order of spec 3.8", () => {
    const t = target({
      pins: [live(7, "out")],
      modules: [{ id: "old", type: "mfrc522", bus: "vspi", enabled: true, pins: {} }],
      rules: [{ id: "x1", enabled: true, on: { gpio: 7, op: "eq", value: 1 }, then: { gpio: 7, value: 0 } }],
    });
    const b = backup({ name: "N", mqtt: { uri: "mqtt://h", root: "devices" }, pins: [pin(4, "out"), pin(32, "adc")], modules: [bme()], rules: [rule("r32")] });
    assert.deepEqual(ids(planBackup(b, t, ALL)), [
      "rule.remove:x1",
      "module.remove:old",
      "pin.disable:7",
      "pin.configure:4",
      "pin.configure:32",
      "module.add:env0",
      "rule.set:r32",
      "mqtt.configure",
      "identity.set_name",
    ]);
  });
});
