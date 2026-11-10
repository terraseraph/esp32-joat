import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type {
  AccessPoint,
  DeviceStatus,
  Hardware,
  IdentitySetNameResult,
  IoMap,
  ModuleCatalog,
  ModuleList,
  MqttStatus,
  NetworkStatus,
  PinConfig,
  PinSetResult,
  RuleList,
  WifiSetResult,
} from "../src/types/device-api";
import { COMMAND_NAMES } from "./fake/commands";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, cmd, failsWith, fetchPins, get, level, result, sleep, statusOf } from "./fake/testkit";

describe("pin.configure", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST });
  });
  after(() => dev.close());
  const configure = (pin: Record<string, unknown>) => cmd<PinConfig>(dev, { cmd: "pin.configure", pin });

  it("out and in: defaults are filled into the result", async () => {
    assert.deepEqual(result(await configure({ gpio: 13, mode: "out" })), { gpio: 13, mode: "out", pull_up: false, pull_down: false, invert: false, boot: 0 });
    assert.deepEqual(result(await configure({ gpio: 14, mode: "in" })), { gpio: 14, mode: "in", pull_up: false, pull_down: false, invert: false, irq: true, debounce_ms: 50 });
    const io = await fetchPins(dev);
    assert.deepEqual(io["gpio_13"], { id: "gpio_13", mode: "out", gpio: 13, level: 0 });
    assert.deepEqual(io["gpio_14"], { id: "gpio_14", mode: "in", gpio: 14, level: 0, debounce_ms: 50 });
    const r = result(await configure({ gpio: 16, mode: "out", boot: 1, invert: true, pull_up: true }));
    assert.equal(r.boot, 1);
    assert.equal((await fetchPins(dev))["gpio_16"]?.level, 1);
    assert.equal(result(await configure({ gpio: 17, mode: "in", debounce_ms: 999, irq: false })).debounce_ms, 500);
    assert.equal(result(await configure({ gpio: 17, mode: "in", debounce_ms: 999, irq: false })).irq, false);
    assert.equal(result(await configure({ gpio: 17, mode: "in", debounce_ms: -5 })).debounce_ms, 0);
  });

  it("pwm, servo and adc: clamping and defaults", async () => {
    assert.deepEqual(result(await configure({ gpio: 18, mode: "pwm" })), { gpio: 18, mode: "pwm", hz: 1000, duty: 0 });
    assert.equal(result(await configure({ gpio: 18, mode: "pwm", hz: 10, duty: 5000 })).hz, 50);
    assert.equal(result(await configure({ gpio: 18, mode: "pwm", hz: 99999, duty: -1 })).hz, 20000);
    assert.equal(result(await configure({ gpio: 18, mode: "pwm", hz: 99999, duty: -1 })).duty, 0);
    assert.equal(result(await configure({ gpio: 18, mode: "pwm", duty: 5000 })).duty, 1000);
    const servo = result(await configure({ gpio: 23, mode: "servo" }));
    assert.deepEqual([servo.angle, servo.min_us, servo.max_us], [90, 500, 2500]);
    const s2 = result(await configure({ gpio: 23, mode: "servo", angle: 300, min_us: 0, max_us: 9999 }));
    assert.deepEqual([s2.angle, s2.min_us, s2.max_us], [180, 500, 2500]);
    const s3 = result(await configure({ gpio: 23, mode: "servo", min_us: 9999, max_us: 0 }));
    assert.deepEqual([s3.min_us, s3.max_us], [1500, 1500]);
    const adc = result(await configure({ gpio: 32, mode: "adc" }));
    assert.deepEqual([adc.sample_ms, adc.hysteresis_mv, adc.smooth], [50, 20, 70]);
    const adc2 = result(await configure({ gpio: 32, mode: "adc", sample_ms: 1, hysteresis_mv: 9999, smooth: 99 }));
    assert.deepEqual([adc2.sample_ms, adc2.hysteresis_mv, adc2.smooth], [20, 500, 90]);
    const io = await fetchPins(dev);
    assert.equal(io["pwm_18"]?.mode, "pwm");
    assert.equal(io["servo_23"]?.mode, "servo");
    assert.equal(io["adc_32"]?.mode, "adc");
  });

  it("the whole pin object is persisted verbatim, extra keys included", async () => {
    await configure({ gpio: 26, mode: "out", name: "Relay", invert: true });
    const persisted = dev.state.pins.find((p) => p.gpio === 26);
    assert.deepEqual(persisted, { gpio: 26, mode: "out", name: "Relay", invert: true });
    assert.equal(result(await configure({ gpio: 26, mode: "out", name: "Relay" })).name, "Relay");
    assert.deepEqual(dev.state.pins.filter((p) => p.gpio === 26), [{ gpio: 26, mode: "out", name: "Relay" }], "re-configuring replaces");
  });

  it("changing the mode replaces the io key; disabled removes it and the persisted pin", async () => {
    await configure({ gpio: 33, mode: "out" });
    assert.ok((await fetchPins(dev))["gpio_33"]);
    await configure({ gpio: 33, mode: "pwm" });
    let io = await fetchPins(dev);
    assert.ok(!("gpio_33" in io));
    assert.ok(io["pwm_33"]);
    assert.deepEqual(result(await configure({ gpio: 33, mode: "disabled" })), { gpio: 33, mode: "disabled" });
    io = await fetchPins(dev);
    assert.ok(!("pwm_33" in io));
    assert.ok(!dev.state.pins.some((p) => p.gpio === 33));
    const hw = (await get<Hardware>(dev, "/hardware")).body;
    assert.equal(hw.pins.find((p) => p.gpio === 33)?.owner, "");
  });

  it("accepts the pin fields at the top level too", async () => {
    const r = result(await cmd<PinConfig>(dev, { cmd: "pin.configure", gpio: 27, mode: "out" }));
    assert.equal(r.gpio, 27);
    assert.ok(!("cmd" in r));
    assert.ok(!("cmd" in (dev.state.pins.find((p) => p.gpio === 27) ?? {})));
  });

  it("capability errors from the hardware flags", async () => {
    for (const g of [6, 7, 8, 9, 10, 11]) {
      for (const mode of ["out", "in", "pwm", "servo", "adc"]) failsWith(await configure({ gpio: g, mode }), `GPIO ${g} is reserved for SPI flash`);
    }
    failsWith(await configure({ gpio: 4, mode: "adc" }), "ADC2 cannot be used while Wi-Fi is on");
    failsWith(await configure({ gpio: 25, mode: "adc" }), "ADC2 cannot be used while Wi-Fi is on");
    failsWith(await configure({ gpio: 16, mode: "adc" }), /no ADC1/);
    for (const mode of ["out", "pwm", "servo"]) failsWith(await configure({ gpio: 34, mode }), /input-only/);
    assert.equal(result(await configure({ gpio: 34, mode: "in" })).mode, "in");
    assert.equal(result(await configure({ gpio: 34, mode: "adc" })).mode, "adc");
    failsWith(await configure({ gpio: 20, mode: "out" }), /does not exist/);
    failsWith(await configure({ mode: "out" }), "gpio required");
    failsWith(await configure({ gpio: 13, mode: "banana" }), "unknown mode");
    failsWith(await configure({ gpio: 13 }), "unknown mode");
  });

  it("delivery is accepted, validated, and persisted", async () => {
    assert.equal(result(await configure({ gpio: 12, mode: "in", delivery: "latest" })).delivery, "latest");
    assert.equal(result(await cmd<PinConfig>(dev, { cmd: "pin.configure", gpio: 12, mode: "in", delivery: "reliable" })).delivery, "reliable");
    failsWith(await configure({ gpio: 12, mode: "in", delivery: "sometimes" }), "delivery must be reliable or latest");
    failsWith(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 12, mode: "in" }, delivery: "x" }), "delivery must be reliable or latest");
    assert.equal(dev.state.pins.find((p) => p.gpio === 12)?.delivery, "reliable");
  });

  it("pins owned by a module cannot be reconfigured; a servo may only be retargeted as servo", async () => {
    result(await cmd(dev, { cmd: "module.add", type: "bme280", pins: { sda: 21, scl: 22 } }));
    failsWith(await configure({ gpio: 21, mode: "out" }), "GPIO 21 is owned by mod_env0");
    failsWith(await configure({ gpio: 22, mode: "disabled" }), "GPIO 22 is owned by mod_env0");
    result(await configure({ gpio: 19, mode: "servo" }));
    failsWith(await configure({ gpio: 19, mode: "out" }), /servo/);
    assert.equal(result(await configure({ gpio: 19, mode: "servo", angle: 10 })).angle, 10);
    assert.equal(result(await configure({ gpio: 19, mode: "disabled" })).mode, "disabled");
  });

  it("the io map holds at most 48 keys", async () => {
    const d = await startFakeDevice({ ...FAST });
    try {
      for (let i = 0; i < 48; i++) d.state.io[`pwm_${100 + i}`] = { id: `pwm_${100 + i}`, mode: "pwm", gpio: 100 + i, hz: 1000, duty: 0 };
      failsWith(await cmd(d, { cmd: "pin.configure", pin: { gpio: 13, mode: "out" } }), /registry full/);
    } finally {
      await d.close();
    }
  });
});

describe("pin.set and io.hydrate", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo" });
  });
  after(() => dev.close());

  it("sets an output level (mode defaults to out)", async () => {
    assert.deepEqual(result<PinSetResult>(await cmd(dev, { cmd: "pin.set", gpio: 4, value: 1 })), { gpio: 4, value: 1 });
    assert.equal(await level(dev, "gpio_4"), 1);
    assert.deepEqual(result(await cmd(dev, { cmd: "pin.set", gpio: 4, value: 0, mode: "out" })), { gpio: 4, value: 0 });
  });

  it("pwm duty and servo angle are clamped", async () => {
    assert.deepEqual(result(await cmd(dev, { cmd: "pin.set", gpio: 18, value: 5000, mode: "pwm" })), { gpio: 18, value: 1000 });
    assert.deepEqual(result(await cmd(dev, { cmd: "pin.set", gpio: 19, value: 45, mode: "servo" })), { gpio: 19, value: 45 });
    const servo = (await fetchPins(dev))["servo_19"] as { angle: number; pulse_us: number };
    assert.equal(servo.angle, 45);
    assert.equal(servo.pulse_us, 1000);
  });

  it("a pin that is not in that mode answers ESP_ERR_INVALID_STATE", async () => {
    failsWith(await cmd(dev, { cmd: "pin.set", gpio: 27, value: 1 }), "ESP_ERR_INVALID_STATE"); // an input
    failsWith(await cmd(dev, { cmd: "pin.set", gpio: 4, value: 1, mode: "pwm" }), "ESP_ERR_INVALID_STATE");
    failsWith(await cmd(dev, { cmd: "pin.set", gpio: 13, value: 1 }), "ESP_ERR_INVALID_STATE"); // unconfigured
    failsWith(await cmd(dev, { cmd: "pin.set", gpio: 13, value: 1, mode: "banana" }), "unknown mode");
    failsWith(await cmd(dev, { cmd: "pin.set", value: 1 }), "gpio required");
    failsWith(await cmd(dev, { cmd: "pin.set", gpio: 4 }), "value required");
  });

  it("pin.set is not persisted: a reboot returns to the configured boot level", async () => {
    result(await cmd(dev, { cmd: "pin.set", gpio: 4, value: 1 }));
    await dev.reboot();
    assert.equal(await level(dev, "gpio_4"), 0);
  });

  it("io.hydrate reports the number of io keys", async () => {
    const io = await fetchPins(dev);
    assert.deepEqual(result(await cmd(dev, { cmd: "io.hydrate" })), { pins: Object.keys(io).length });
    assert.equal(Object.keys(io).length, 6);
  });
});

describe("modules", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST });
  });
  after(() => dev.close());
  const add = (body: Record<string, unknown>) => cmd<ModuleList>(dev, { cmd: "module.add", ...body });
  const bme = { type: "bme280", pins: { sda: 21, scl: 22 } };

  it("module.catalog describes both types", async () => {
    const c = result<ModuleCatalog>(await cmd(dev, { cmd: "module.catalog" }));
    assert.deepEqual(c.types.map((t) => t.type), ["bme280", "mfrc522"]);
    const [b, m] = c.types;
    assert.deepEqual([b?.bus, b?.default_bus, b?.id_prefix, b?.max_instances], ["i2c", "i2c0", "env", 2]);
    assert.deepEqual([m?.bus, m?.default_bus, m?.id_prefix, m?.max_instances], ["spi", "vspi", "rfid", 4]);
    assert.deepEqual(b?.pins.map((p) => p.role), ["sda", "scl"]);
    assert.ok(m?.pins.some((p) => p.role === "ss" && p.share === "instance" && p.required));
    assert.ok(m?.pins.some((p) => p.role === "rst" && !p.required));
    for (const t of c.types) {
      for (const s of t.settings) {
        assert.ok(s.kind === "int" || s.kind === "enum");
        if (s.kind === "int") assert.ok(s.min !== undefined && s.max !== undefined);
        else assert.ok(Array.isArray(s.choices) && s.choices.length > 0);
      }
    }
    assert.equal(b?.settings.find((s) => s.key === "addr")?.def, 118);
  });

  it("add, list, configure, remove a bme280", async () => {
    const added = result(await add(bme));
    assert.equal(added.v, 1);
    assert.equal(added.modules.length, 1);
    const m = added.modules[0]!;
    assert.deepEqual([m.id, m.type, m.bus, m.enabled], ["env0", "bme280", "i2c0", true]);
    assert.deepEqual(m.settings, { addr: 118, sample_ms: 1000, osrs_t: 1, osrs_p: 1, osrs_h: 1, filter: 0, mode: "normal" });
    assert.deepEqual(m.state, { id: "env0", type: "bme280", ok: true, addr: 118, t_c: 22.5, p_hpa: 1013.2, rh: 45.1 });
    assert.deepEqual((await fetchPins(dev))["mod_env0"], m.state);
    const hw = (await get<Hardware>(dev, "/hardware")).body;
    assert.equal(hw.pins.find((p) => p.gpio === 21)?.owner, "mod_env0");

    const listed = result<ModuleList>(await cmd(dev, { cmd: "module.list" }));
    assert.deepEqual(listed, added);

    const conf = result(await cmd<ModuleList>(dev, { cmd: "module.configure", id: "env0", settings: { sample_ms: 50 } }));
    assert.equal(conf.modules[0]?.settings?.sample_ms, 100, "int settings are clamped to the catalog range");
    assert.equal(conf.modules[0]?.settings?.addr, 118, "missing fields inherit");

    const off = result(await cmd<ModuleList>(dev, { cmd: "module.configure", id: "env0", enabled: false }));
    assert.equal(off.modules[0]?.enabled, false);
    assert.ok(!("state" in off.modules[0]!));
    assert.ok(!("mod_env0" in (await fetchPins(dev))));
    assert.equal(((await get<Hardware>(dev, "/hardware")).body).pins.find((p) => p.gpio === 21)?.owner, "");
    const on = result(await cmd<ModuleList>(dev, { cmd: "module.configure", id: "env0", enabled: true }));
    assert.ok(on.modules[0]?.state);

    const gone = result(await cmd<ModuleList>(dev, { cmd: "module.remove", id: "env0" }));
    assert.deepEqual(gone, { v: 1, modules: [] });
    assert.ok(!("mod_env0" in (await fetchPins(dev))));
  });

  it("validates ids, pins, settings and types", async () => {
    failsWith(await add({ ...bme, id: "Bad Id" }), /invalid module id/);
    failsWith(await add({ ...bme, id: "1abc" }), /invalid module id/);
    failsWith(await add({ ...bme, id: "a".repeat(17) }), /invalid module id/);
    failsWith(await add({ type: "bme280", pins: { sda: 21 } }), "pin scl required");
    failsWith(await add({ type: "bme280", pins: {} }), "pin sda required");
    failsWith(await add({ type: "bme280", pins: { sda: 21, scl: 21 } }), "module pins must be unique");
    failsWith(await add({ type: "bme280", pins: { sda: 6, scl: 22 } }), /cannot be used as sda/);
    failsWith(await add({ type: "bme280", pins: { sda: 34, scl: 22 } }), /cannot be used as sda/);
    failsWith(await add({ type: "nothing", pins: {} }), "unknown module type");
    failsWith(await add({ ...bme, bus: "vspi" }), "bus must be i2c0|i2c1");
    failsWith(await add({ type: "mfrc522", bus: "i2c0", pins: {} }), "bus must be vspi|hspi");
    failsWith(await add({ ...bme, settings: { addr: 5 } }), /setting addr/);
    failsWith(await add({ ...bme, settings: { sample_ms: "fast" } }), /setting sample_ms/);
    failsWith(await add({ ...bme, delivery: "x" }), "delivery must be reliable or latest");
    assert.equal(dev.state.modules.length, 0, "failures change nothing");
  });

  it("id already in use, instance limits, unique I2C address and shared-bus rules", async () => {
    result(await add({ ...bme, id: "env0" }));
    failsWith(await add({ ...bme, id: "env0", settings: { addr: 119 } }), "id already in use");
    failsWith(await add(bme), /I2C address 118 already used on i2c0/);
    const second = result(await add({ ...bme, settings: { addr: 119 } }));
    assert.deepEqual(second.modules.map((m) => m.id), ["env0", "env1"], "ids are auto-assigned from id_prefix");
    failsWith(await add({ ...bme, settings: { addr: 119 } }), "bme280 limited to 2 instances");
    failsWith(await add({ type: "bme280", id: "env5", bus: "i2c0", pins: { sda: 21, scl: 23 }, settings: { addr: 119 } }), "bme280 limited to 2 instances");
    result(await cmd(dev, { cmd: "module.remove", id: "env1" }));
    failsWith(await add({ type: "bme280", id: "env5", pins: { sda: 21, scl: 23 }, settings: { addr: 119 } }), "shared bus pins must match");
    const other = result(await add({ type: "bme280", id: "env5", pins: { sda: 25, scl: 26 }, bus: "i2c1" }));
    assert.equal(other.modules.find((m) => m.id === "env5")?.bus, "i2c1", "a second I2C bus has its own pins and address space");
    result(await cmd(dev, { cmd: "module.remove", id: "env5" }));
    result(await cmd(dev, { cmd: "module.remove", id: "env0" }));
  });

  it("mfrc522: SPI pins, one CS per instance, at most 4", async () => {
    const spi = { sck: 18, miso: 19, mosi: 23 };
    const r0 = result(await add({ type: "mfrc522", pins: { ...spi, ss: 5, rst: 16 } }));
    const m0 = r0.modules[0]!;
    assert.deepEqual([m0.id, m0.bus], ["rfid0", "vspi"]);
    assert.deepEqual(m0.state, { id: "rfid0", type: "mfrc522", present: false, uid: "", version: 146, tx: 3 });
    failsWith(await add({ type: "mfrc522", pins: { ...spi, ss: 5 } }), /in use \(mod_rfid0\)/);
    failsWith(await add({ type: "mfrc522", pins: { sck: 18, miso: 19, mosi: 14, ss: 17 } }), "shared bus pins must match");
    failsWith(await add({ type: "mfrc522", pins: { sck: 18, miso: 19, mosi: 23 } }), "pin ss required");
    for (const ss of [17, 4, 2]) result(await add({ type: "mfrc522", pins: { ...spi, ss } }));
    assert.equal(dev.state.modules.length, 4);
    failsWith(await add({ type: "mfrc522", pins: { ...spi, ss: 13 } }), "mfrc522 limited to 4 instances");
    assert.deepEqual(dev.state.modules.map((m) => m.id), ["rfid0", "rfid1", "rfid2", "rfid3"]);
    for (const m of [...dev.state.modules]) result(await cmd(dev, { cmd: "module.remove", id: m.id }));
  });

  it("module pins conflict with configured pins; memory admission; nested module object", async () => {
    result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 21, mode: "out" } }));
    failsWith(await add(bme), "GPIO 21 is in use (gpio_21)");
    result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 21, mode: "disabled" } }));
    dev.state.memory.internal.largest = 1000;
    failsWith(await add(bme), /^need 6144 bytes, largest 1000, free 151200$/);
    dev.state.memory.internal.largest = 90112;
    const nested = result(await add({ module: { type: "bme280", id: "n1", pins: { sda: 21, scl: 22 } } }));
    assert.equal(nested.modules[0]?.id, "n1");
    result(await cmd(dev, { cmd: "module.remove", id: "n1" }));
  });

  it("module.configure and module.remove error strings; module.cmd has no commands", async () => {
    failsWith(await cmd(dev, { cmd: "module.configure", id: "ghost", enabled: false }), "unknown module id");
    failsWith(await cmd(dev, { cmd: "module.remove", id: "ghost" }), "unknown module id");
    failsWith(await cmd(dev, { cmd: "module.cmd", id: "ghost" }), "unknown module id");
    result(await add(bme));
    failsWith(await cmd(dev, { cmd: "module.cmd", id: "env0", name: "x" }), "module has no commands");
  });
});

describe("rules", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST });
    for (const g of [4, 13, 14]) await cmd(dev, { cmd: "pin.configure", pin: { gpio: g, mode: "out" } });
    await cmd(dev, { cmd: "pin.configure", pin: { gpio: 27, mode: "in" } });
    await cmd(dev, { cmd: "pin.configure", pin: { gpio: 32, mode: "adc", hysteresis_mv: 5 } });
  });
  after(() => dev.close());
  const set = (rule: Record<string, unknown>) => cmd<RuleList>(dev, { cmd: "rule.set", rule });

  it("rule.set applies defaults, aliases and echoes the list", async () => {
    const r = result(await set({ on: { gpio: 32, op: ">=", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } }));
    assert.deepEqual(r, { v: 1, rules: [{ id: "r32", enabled: true, on: { gpio: 32, op: "ge", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } }] });
    assert.deepEqual(result(await cmd(dev, { cmd: "rule.list" })), r);
    for (const [alias, word] of [[">", "gt"], ["<", "lt"], ["<=", "le"], ["==", "eq"], ["!=", "ne"], ["gt", "gt"], ["ne", "ne"]] as const) {
      const out = result(await set({ id: "alias", on: { gpio: 27, op: alias, value: 0 }, then: { gpio: 13, value: 1 } }));
      assert.equal(out.rules.find((x) => x.id === "alias")?.on.op, word);
    }
    result(await cmd(dev, { cmd: "rule.remove", id: "alias" }));
  });

  it("ids are truncated to 7 chars; upsert by id then by source gpio", async () => {
    const out = result(await set({ id: "abcdefghij", on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 13, value: 1 } }));
    assert.deepEqual(out.rules.map((r) => r.id), ["r32", "abcdefg"]);
    const byId = result(await set({ id: "abcdefghij", enabled: false, on: { gpio: 27, op: "eq", value: 0 }, then: { gpio: 13, value: 0 } }));
    assert.equal(byId.rules.length, 2);
    assert.equal(byId.rules[1]?.enabled, false);
    const bySource = result(await set({ id: "other", on: { gpio: 27, op: "ne", value: 5 }, then: { gpio: 14, value: 1 } }));
    assert.equal(bySource.rules.length, 2, "one rule per source gpio");
    assert.deepEqual(bySource.rules[1], { id: "other", enabled: true, on: { gpio: 27, op: "ne", value: 5 }, then: { gpio: 14, value: 1 } });
  });

  it("validates", async () => {
    failsWith(await set({ on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 27, value: 1 } }), "rule.then.gpio must differ from on.gpio");
    failsWith(await set({ on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 4, value: 1 }, else: { gpio: 27, value: 0 } }), "rule.else.gpio must differ from on.gpio");
    failsWith(await set({ on: { gpio: 27, op: "approx", value: 1 }, then: { gpio: 4, value: 1 } }), "unknown op");
    failsWith(await set({ on: { gpio: 27, op: "eq" }, then: { gpio: 4, value: 1 } }), /rule.on/);
    failsWith(await set({ on: { gpio: 27, op: "eq", value: 1 } }), /rule.then/);
    failsWith(await cmd(dev, { cmd: "rule.set" }), "rule required");
  });

  it("an inert destination is accepted (and logged)", async () => {
    const out = result(await set({ id: "inert", on: { gpio: 36, op: "gt", value: 1 }, then: { gpio: 25, value: 1 } }));
    assert.ok(out.rules.some((r) => r.id === "inert"));
    assert.ok(dev.state.logs.some((l) => /inert/.test(l)));
    result(await cmd(dev, { cmd: "rule.remove", id: "inert" }));
  });

  it("rule.remove by id or gpio; 'rule not found'", async () => {
    failsWith(await cmd(dev, { cmd: "rule.remove", id: "zzz" }), "rule not found");
    failsWith(await cmd(dev, { cmd: "rule.remove", gpio: 5 }), "rule not found");
    failsWith(await cmd(dev, { cmd: "rule.remove" }), "rule not found");
    const left = result<RuleList>(await cmd(dev, { cmd: "rule.remove", gpio: 27 }));
    assert.deepEqual(left.rules.map((r) => r.id), ["r32"]);
    assert.equal(result<RuleList>(await cmd(dev, { cmd: "rule.remove", id: "r32" })).rules.length, 0);
  });

  it("rules fire on source changes (digital level and ADC millivolts)", async () => {
    result(await set({ on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 13, value: 1 }, else: { gpio: 13, value: 0 } }));
    dev.setInput(27, 1);
    assert.equal(await level(dev, "gpio_13"), 1);
    dev.setInput(27, 0);
    assert.equal(await level(dev, "gpio_13"), 0);
    result(await set({ on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 14, value: 1 }, else: { gpio: 14, value: 0 } }));
    dev.setInput(32, 2000);
    assert.equal(await level(dev, "gpio_14"), 1);
    dev.setInput(32, 100);
    assert.equal(await level(dev, "gpio_14"), 0);
    await cmd(dev, { cmd: "rule.remove", gpio: 27 });
    await cmd(dev, { cmd: "rule.remove", gpio: 32 });
  });

  it("at most 8 rules", async () => {
    const d = await startFakeDevice({ ...FAST });
    try {
      const sources = [13, 14, 16, 17, 18, 19, 21, 22, 23];
      for (let i = 0; i < 8; i++) result(await cmd(d, { cmd: "rule.set", rule: { on: { gpio: sources[i], op: "eq", value: 1 }, then: { gpio: 4, value: 1 } } }));
      failsWith(await cmd(d, { cmd: "rule.set", rule: { on: { gpio: sources[8], op: "eq", value: 1 }, then: { gpio: 4, value: 1 } } }), "too many rules (max 8)");
      result(await cmd(d, { cmd: "rule.set", rule: { on: { gpio: 13, op: "ne", value: 1 }, then: { gpio: 4, value: 1 } } })); // upsert still fine at the limit
      assert.equal(d.state.rules.length, 8);
    } finally {
      await d.close();
    }
  });
});

describe("network, mqtt, identity, serial", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo", id: "a4cf12b3c4d5" });
  });
  after(() => dev.close());

  it("network.wifi.set succeeds after wifiSetDelayMs and leaves the SoftAP up", async () => {
    const t0 = Date.now();
    const r = result<WifiSetResult>(await cmd(dev, { cmd: "network.wifi.set", ssid: "workshop-wifi", password: "hunter2hunter2" }));
    assert.ok(Date.now() - t0 >= 70);
    assert.equal(r.state, "apsta_recovery");
    assert.equal(r.sta_connected, true);
    assert.equal(r.provisioned, true);
    assert.ok("mdns" in r);
    failsWith(await cmd(dev, { cmd: "network.wifi.set", password: "x" }), "ssid required");
  });

  it("network.wifi.set fails for ssid 'fail' or the option, and sits in apsta_recovery", async () => {
    failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "fail", password: "whatever1" }), "wifi test failed; credentials not saved");
    let n = (await get<NetworkStatus>(dev, "/network")).body;
    assert.equal(n.state, "apsta_recovery");
    assert.equal(n.sta_connected, false);
    assert.equal(n.sta_ip, "");
    dev.options.wifiSetFails = true;
    failsWith(await cmd(dev, { cmd: "network.wifi.set", ssid: "good", password: "whatever1" }), "wifi test failed; credentials not saved");
    dev.options.wifiSetFails = false;
    await dev.reboot();
    n = (await get<NetworkStatus>(dev, "/network")).body;
    assert.equal(n.state, "sta_connected", "a reboot restores the saved credentials");
  });

  it("wifiSetDropsResponse kills the connection like a real Wi-Fi change", async () => {
    dev.options.wifiSetDropsResponse = true;
    await assert.rejects(fetch(`${dev.url}/api/v1/command`, { method: "POST", body: JSON.stringify({ cmd: "network.wifi.set", ssid: "x", password: "yyyyyyyy" }) }));
    dev.options.wifiSetDropsResponse = false;
    assert.equal((await get(dev, "/status")).status, 200);
  });

  it("network.wifi.scan returns the AP array", async () => {
    const aps = result<AccessPoint[]>(await cmd(dev, { cmd: "network.wifi.scan" }));
    assert.ok(Array.isArray(aps));
    assert.deepEqual(aps, (await get<AccessPoint[]>(dev, "/network/scan")).body);
  });

  it("network.recovery_ap and network.ap.set_password", async () => {
    assert.equal(result<NetworkStatus>(await cmd(dev, { cmd: "network.recovery_ap" })).state, "apsta_recovery");
    assert.equal(result<NetworkStatus>(await cmd(dev, { cmd: "network.ap.set_password", password: "longenough" })).ap_open, false);
    assert.equal(dev.state.apPassword, "longenough");
    assert.equal(result<NetworkStatus>(await cmd(dev, { cmd: "network.ap.set_password", password: "" })).ap_open, true);
    const msg = "AP password must be empty (open) or 8-63 characters";
    failsWith(await cmd(dev, { cmd: "network.ap.set_password", password: "short" }), msg);
    failsWith(await cmd(dev, { cmd: "network.ap.set_password", password: "x".repeat(64) }), msg);
    failsWith(await cmd(dev, { cmd: "network.ap.set_password" }), msg);
    assert.equal(result<NetworkStatus>(await cmd(dev, { cmd: "network.ap.set_password", password: "x".repeat(63) })).ap_open, false);
  });

  it("mqtt.configure: validation, root sanitising, private credentials", async () => {
    const empty = await startFakeDevice({ ...FAST });
    try {
      failsWith(await cmd(empty, { cmd: "mqtt.configure" }), "uri required (mqtt://host:1883)");
      failsWith(await cmd(empty, { cmd: "mqtt.configure", root: "x" }), "uri required (mqtt://host:1883)");
      assert.equal(empty.state.mqtt.enabled, false);
    } finally {
      await empty.close();
    }
    const r = result(await cmd(dev, { cmd: "mqtt.configure", uri: "mqtt://10.1.1.1:1883", root: "my root!/x" }));
    assert.deepEqual(r, { uri: "mqtt://10.1.1.1:1883", root: "myroot/x" });
    assert.equal(dev.state.mqtt.user, "fake", "credentials are only written when user is a string");
    result(await cmd(dev, { cmd: "mqtt.configure", user: "bob", password: "pw1" }));
    assert.deepEqual([dev.state.mqtt.user, dev.state.mqtt.password, dev.state.mqtt.uri], ["bob", "pw1", "mqtt://10.1.1.1:1883"]);
    assert.deepEqual(result(await cmd(dev, { cmd: "mqtt.configure", root: "" })), { uri: "mqtt://10.1.1.1:1883", root: "devices" });
    const m = (await get<MqttStatus>(dev, "/mqtt")).body;
    assert.equal(m.connected, true);
    assert.equal(m.prefix, `devices/${m.topic_id}`);
    assert.ok(!JSON.stringify(m).includes("pw1"));
    assert.ok(!JSON.stringify((await get(dev, "/status")).body).includes("pw1"));
  });

  it("identity.set_name: topic id rule, length limit, default to hostname", async () => {
    const r = result<IdentitySetNameResult>(await cmd(dev, { cmd: "identity.set_name", name: "Shop Floor.2 #1" }));
    assert.deepEqual(r, { name: "Shop Floor.2 #1", topic_id: "Shop_Floor_2_1", id: "a4cf12b3c4d5" });
    const st = await statusOf(dev);
    assert.deepEqual([st.name, st.topic_id], ["Shop Floor.2 #1", "Shop_Floor_2_1"]);
    assert.equal(st.mqtt.topic_id, "Shop_Floor_2_1");
    assert.equal(result<IdentitySetNameResult>(await cmd(dev, { cmd: "identity.set_name", name: "n".repeat(31) })).name.length, 31);
    failsWith(await cmd(dev, { cmd: "identity.set_name", name: "n".repeat(32) }), /name too long/);
    const back = result<IdentitySetNameResult>(await cmd(dev, { cmd: "identity.set_name" }));
    assert.deepEqual([back.name, back.topic_id], ["esp32-b3c4d5", "esp32-b3c4d5"]);
  });

  it("generation grows with every configuration change", async () => {
    const g0 = (await statusOf(dev)).generation;
    result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 13, mode: "out" } }));
    result(await cmd(dev, { cmd: "rule.list" }));
    assert.equal((await statusOf(dev)).generation, g0 + 1);
  });

  it("serial.hello and serial.bye", async () => {
    const hello = result<{ id: string; name: string }>(await cmd(dev, { cmd: "serial.hello" }));
    assert.equal(hello.id, "a4cf12b3c4d5");
    assert.equal(dev.state.serialSession, true);
    assert.deepEqual(result(await cmd(dev, { cmd: "serial.bye" })), { session: false });
    assert.equal(dev.state.serialSession, false);
  });

  it("ota.apply validates its url; ota.rollback needs a previous slot", async () => {
    failsWith(await cmd(dev, { cmd: "ota.apply", url: "ftp://x/fw.bin" }), "url must be http:// or https://");
    failsWith(await cmd(dev, { cmd: "ota.apply" }), "url must be http:// or https://");
    failsWith(await cmd(dev, { cmd: "ota.apply", url: `http://x/${"a".repeat(400)}` }), "url must be http:// or https://");
    const empty = await startFakeDevice({ ...FAST });
    try {
      failsWith(await cmd(empty, { cmd: "ota.rollback" }), "no valid previous slot");
      assert.equal(empty.state.ota.slots[1], null);
    } finally {
      await empty.close();
    }
  });

  it("every cataloged command is answered (none is 'unknown cmd')", async () => {
    const d = await startFakeDevice({ ...FAST, seed: "demo" });
    try {
      for (const c of COMMAND_NAMES) {
        if (/^(system\.|ota\.(apply|rollback)|network\.wifi\.clear)/.test(c)) continue; // tested in the lifecycle suite
        const env = await cmd(d, { cmd: c });
        if (!env.ok) assert.notEqual(env.error, "unknown cmd", c);
      }
      assert.equal(COMMAND_NAMES.length, 25);
      await sleep(1);
    } finally {
      await d.close();
    }
  });

  it("types: status and hardware fields line up with device-api.ts", async () => {
    const st: DeviceStatus = await statusOf(dev);
    const io: IoMap = st.io;
    assert.ok(io);
    const hw: Hardware = (await get<Hardware>(dev, "/hardware")).body;
    assert.equal(hw.pins.length, 34);
  });
});
