import { describe, expect, it } from "vitest";
import { CATALOG, ENV0, RFID0, makeHardware } from "./addonFixtures";
import {
  buildModuleAdd, buildModuleConfigure, defaultAddonId, defaultForm, describeReading, formFromInstance, freePinsFor, pinSummary, validateAddonForm,
} from "./addonLogic";

const bme = CATALOG.types[0]!;
const rfid = CATALOG.types[1]!;
const owners = { 21: "mod_env0", 22: "mod_env0", 4: "gpio_4", 18: "mod_rfid0", 19: "mod_rfid0", 23: "mod_rfid0", 5: "mod_rfid0", 27: "mod_rfid0" };

describe("freePinsFor", () => {
  const hw = makeHardware(owners);
  it("lists capable, free, non-flash pins sorted", () => {
    const out = freePinsFor({ cap: "out" }, hw).map((p) => p.gpio);
    expect(out).toEqual([2, 12, 13, 14, 15, 16, 17, 25, 26, 32, 33]);
    expect(out).not.toContain(6);
    expect(out).not.toContain(34); // input-only
    expect(out).not.toContain(4); // owned by gpio_4
  });
  it("inputs may be input-only pins", () => {
    expect(freePinsFor({ cap: "in" }, hw).map((p) => p.gpio)).toContain(34);
  });
  it("counts the add-on's own pins as free when editing", () => {
    expect(freePinsFor({ cap: "out" }, hw, "rfid0").map((p) => p.gpio)).toEqual(expect.arrayContaining([5, 18, 23, 27]));
    expect(freePinsFor({ cap: "out" }, hw).map((p) => p.gpio)).not.toContain(5);
  });
  it("allows explicitly shared pins", () => {
    expect(freePinsFor({ cap: "out" }, hw, undefined, [21]).map((p) => p.gpio)).toContain(21);
  });
  it("is empty without hardware", () => {
    expect(freePinsFor({ cap: "out" }, null)).toEqual([]);
  });
});

describe("defaultAddonId", () => {
  it("uses the lowest free number", () => {
    expect(defaultAddonId(bme, [])).toBe("env0");
    expect(defaultAddonId(bme, [{ id: "env0" }, { id: "env2" }])).toBe("env1");
  });
});

describe("defaultForm", () => {
  const hw = makeHardware(owners);
  it("pre-fills bus, bus pins, free instance pins and setting defaults", () => {
    const f = defaultForm(rfid, makeHardware(), []);
    expect(f).toMatchObject({ type: "mfrc522", id: "rfid0", bus: "vspi", pins: { sck: 18, miso: 19, mosi: 23, ss: 5 }, settings: { poll_ms: 100, rx_gain: 4 } });
    expect(f.pins.rst).toBeUndefined();
  });
  it("picks another free CS when the bus default is taken and shares bus pins with a sibling", () => {
    const f = defaultForm(rfid, hw, [RFID0]);
    expect(f.id).toBe("rfid1");
    expect(f.pins).toMatchObject({ sck: 18, miso: 19, mosi: 23 });
    expect(f.pins.ss).not.toBe(5);
    expect(f.pins.ss).toBeDefined();
  });
});

describe("validateAddonForm", () => {
  const hw = makeHardware(owners);
  const base = (over = {}) => ({ ...defaultForm(bme, hw, [ENV0]), ...over });
  const ctx = (extra = {}) => ({ type: bme, hardware: hw, instances: [ENV0], ...extra });

  it("accepts a second BME280 on the shared bus with another address", () => {
    const f = base({ settings: { addr: 119, sample_ms: 1000, mode: "normal" } });
    expect(f.pins).toEqual({ sda: 21, scl: 22 });
    expect(validateAddonForm(f, ctx()).valid).toBe(true);
  });
  it("flags a clashing I2C address", () => {
    const v = validateAddonForm(base(), ctx());
    expect(v.errors.settings.addr).toMatch(/env0/);
    expect(v.settingsOk).toBe(false);
  });
  it("validates the id pattern and uniqueness", () => {
    expect(validateAddonForm(base({ id: "1bad" }), ctx()).errors.id).toBeDefined();
    expect(validateAddonForm(base({ id: "a".repeat(17) }), ctx()).errors.id).toBeDefined();
    expect(validateAddonForm(base({ id: "env0" }), ctx()).errors.id).toBe("id already in use");
    expect(validateAddonForm(base({ id: "ok_1" }), ctx()).errors.id).toBeUndefined();
  });
  it("enforces the instance limit when adding, not when editing", () => {
    const two = [ENV0, { ...ENV0, id: "env1" }];
    expect(validateAddonForm(base({ id: "env2" }), { ...ctx(), instances: two }).errors.general).toBe("bme280 limited to 2 instances");
    expect(validateAddonForm(formFromInstance(ENV0, bme), { ...ctx(), instances: two, editingId: "env0" }).errors.general).toBeUndefined();
  });
  it("requires required pins and unique pins", () => {
    const f = defaultForm(rfid, makeHardware(), []);
    const c = { type: rfid, hardware: makeHardware(), instances: [] as (typeof ENV0)[] };
    expect(validateAddonForm({ ...f, pins: { ...f.pins, ss: undefined } }, c).errors.pins.ss).toMatch(/required/);
    expect(validateAddonForm({ ...f, pins: { ...f.pins, ss: 18 } }, c).errors.pins.ss).toMatch(/unique/);
  });
  it("rejects pins that are in use, flash pins and incapable pins", () => {
    const f = defaultForm(rfid, makeHardware(), []);
    const c = { type: rfid, hardware: hw, instances: [] as (typeof ENV0)[] };
    expect(validateAddonForm({ ...f, pins: { ...f.pins, rst: 4 } }, c).errors.pins.rst).toMatch(/in use \(gpio_4\)/);
    expect(validateAddonForm({ ...f, pins: { ...f.pins, rst: 6 } }, c).errors.pins.rst).toMatch(/flash/);
    expect(validateAddonForm({ ...f, pins: { ...f.pins, rst: 34 } }, c).errors.pins.rst).toMatch(/output/);
  });
  it("lets a sibling share the bus pins but not move them", () => {
    const f = { ...defaultForm(bme, hw, [ENV0]), settings: { addr: 119, sample_ms: 1000, mode: "normal" } };
    expect(validateAddonForm({ ...f, pins: { sda: 25, scl: 22 } }, ctx()).errors.pins.sda).toBeDefined();
  });
  it("checks settings ranges and enum choices", () => {
    const f = base({ settings: { addr: 119, sample_ms: 50, mode: "turbo" } });
    const v = validateAddonForm(f, ctx());
    expect(v.errors.settings.sample_ms).toBe("Must be at least 100");
    expect(v.errors.settings.mode).toBeDefined();
    expect(validateAddonForm(base({ settings: { addr: 119, sample_ms: 70000, mode: "normal" } }), ctx()).errors.settings.sample_ms).toBe("Must be at most 60000");
    expect(validateAddonForm(base({ settings: { addr: 119, sample_ms: 1.5, mode: "normal" } }), ctx()).errors.settings.sample_ms).toBeDefined();
  });
  it("requires a bus of the right kind", () => {
    expect(validateAddonForm(base({ bus: "vspi" }), ctx()).errors.bus).toBeDefined();
  });
});

describe("command bodies", () => {
  it("buildModuleAdd sends type, id, bus, defined pins and settings", () => {
    const f = defaultForm(rfid, makeHardware(), []);
    expect(buildModuleAdd(f)).toEqual({
      cmd: "module.add", type: "mfrc522", id: "rfid0", bus: "vspi", pins: { sck: 18, miso: 19, mosi: 23, ss: 5 }, settings: { poll_ms: 100, rx_gain: 4 },
    });
  });
  it("buildModuleConfigure sends only changed fields, or null", () => {
    const f = formFromInstance(ENV0, bme);
    expect(buildModuleConfigure(f, ENV0, bme)).toBeNull();
    expect(buildModuleConfigure({ ...f, settings: { ...f.settings, sample_ms: 2000 } }, ENV0, bme)).toEqual({
      cmd: "module.configure", id: "env0", settings: { addr: 118, sample_ms: 2000, mode: "normal" },
    });
    expect(buildModuleConfigure({ ...f, pins: { sda: 25, scl: 22 } }, ENV0, bme)).toEqual({ cmd: "module.configure", id: "env0", pins: { sda: 25, scl: 22 } });
  });
});

describe("display helpers", () => {
  it("describes live readings", () => {
    expect(describeReading(ENV0.state, true)).toEqual({ primary: "23.4 °C", secondary: "48 %RH · 1011 hPa", empty: false });
    expect(describeReading({ id: "e", type: "bme280", ok: false, addr: 118 }, true).primary).toBe("No sensor");
    expect(describeReading(RFID0.state, true).primary).toBe("No tag");
    expect(describeReading({ id: "r", type: "mfrc522", present: true, uid: "04A1", version: 146, tx: 3 }, true).primary).toBe("Tag 04A1");
    expect(describeReading(ENV0.state, false).primary).toBe("Disabled");
    expect(describeReading(undefined, true).empty).toBe(true);
  });
  it("summarises pins in catalog order", () => {
    expect(pinSummary(rfid, RFID0)).toBe("SCK 18 · MISO 19 · MOSI 23 · CS 5 · RST 27");
  });
});
