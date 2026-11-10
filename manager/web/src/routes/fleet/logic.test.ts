import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDevice } from "./fixtures";
import { attentionText, DEFAULT_PREFS, filterCounts, filterDevices, loadPrefs, matchesSearch, nameList, PREFS_KEY, savePrefs, sortDevices, summarize } from "./logic";

const NOW = Date.parse("2026-11-10T10:00:00.000Z");

const workshop = makeDevice({ id: "a4cf12b3c4d5", name: "Workshop node", host: "192.168.1.42", uptime_s: 5220, rssi: -58 });
const greenhouse = makeDevice({ id: "a4cf12e81f20", label: "Greenhouse", name: "esp32-x", host: "192.168.1.57", uptime_s: 536_000, rssi: -71 });
const garage = makeDevice({ id: "3c71bf0a9e11", name: "Garage door", host: "192.168.1.63", attention: ["mqtt_disconnected"], mqtt: { configured: true, connected: false }, rssi: -66, uptime_s: 1_000_000 });
const gate = makeDevice({ id: "3c71bf44d702", name: "Front gate RFID", host: "192.168.1.71", attention: ["safe_mode"], safe_reason: "boot loop: 3 resets before healthy", uptime_s: 64, rssi: null });
const kitchen = makeDevice({ id: "246f28c0ffee", name: "Kitchen relay", host: "192.168.1.88", health: "offline", lastSeen: "2026-11-10T08:00:00.000Z", uptime_s: 99, rssi: -50 });
const lamp = makeDevice({ id: "08b61f22c4e7", name: "Desk lamp", host: "192.168.1.112", health: "unreachable", lastSeen: "2026-11-10T09:59:15.000Z" });
const nameless = makeDevice({ id: "7821849a3b6c", hostname: "esp32-9a3b6c", host: "192.168.1.104", attention: ["ota_pending_verify"], uptime_s: 42 });
const FLEET = [workshop, greenhouse, garage, gate, kitchen, lamp, nameless];

describe("summarize", () => {
  it("counts online, offline (offline + unreachable), attention and keeps firmware unknown without a target", () => {
    const s = summarize(FLEET);
    expect(s).toMatchObject({ total: 7, online: 5, offline: 2, offlineOnly: 1, unreachable: 1, attention: 3, onlineAttention: 3, differs: null });
    expect(s.flags.sort()).toEqual(["mqtt_disconnected", "ota_pending_verify", "safe_mode"]);
  });

  it("counts firmware differences once any device has a verdict", () => {
    const s = summarize([{ ...workshop, fwMatchesTarget: true }, { ...garage, fwMatchesTarget: false }, kitchen]);
    expect(s.differs).toBe(1);
  });

  it("handles an empty fleet", () => {
    expect(summarize([])).toMatchObject({ total: 0, online: 0, offline: 0, attention: 0, differs: null });
  });

  it("gives the chip counts", () => {
    expect(filterCounts(FLEET)).toEqual({ all: 7, online: 5, offline: 2, attention: 3, differs: null });
  });
});

describe("search and filter", () => {
  it("matches name, label, hostname, host and id case-insensitively", () => {
    expect(matchesSearch(workshop, "WORKSHOP")).toBe(true);
    expect(matchesSearch(greenhouse, "greenh")).toBe(true); // label
    expect(matchesSearch(greenhouse, "esp32-x")).toBe(true); // name
    expect(matchesSearch(nameless, "9a3b6c")).toBe(true); // hostname and id
    expect(matchesSearch(garage, "192.168.1.63")).toBe(true);
    expect(matchesSearch(garage, "0a9e11")).toBe(true);
    expect(matchesSearch(garage, "nothing like this")).toBe(false);
    expect(matchesSearch(garage, "   ")).toBe(true);
  });

  it("filters by health, attention and firmware", () => {
    const ids = (f: Parameters<typeof filterDevices>[1]) => filterDevices(FLEET, f, "").map((d) => d.id);
    expect(ids("all")).toHaveLength(7);
    expect(ids("online")).toEqual([workshop.id, greenhouse.id, garage.id, gate.id, nameless.id]);
    expect(ids("offline")).toEqual([kitchen.id, lamp.id]);
    expect(ids("attention")).toEqual([garage.id, gate.id, nameless.id]);
    expect(ids("differs")).toEqual([]);
    expect(filterDevices([{ ...garage, fwMatchesTarget: false }, workshop], "differs", "").map((d) => d.id)).toEqual([garage.id]);
  });

  it("combines filter and search", () => {
    expect(filterDevices(FLEET, "online", "192.168.1.7").map((d) => d.id)).toEqual([gate.id]);
    expect(filterDevices(FLEET, "offline", "garage")).toEqual([]);
  });
});

describe("sortDevices", () => {
  const ids = (l: typeof FLEET) => l.map((d) => d.id);
  it("sorts by display name", () => {
    // Desk lamp, esp32-9a3b6c (no name: hostname), Front gate RFID, Garage door, Greenhouse (label), Kitchen relay, Workshop node
    expect(ids(sortDevices(FLEET, "name"))).toEqual([lamp.id, nameless.id, gate.id, garage.id, greenhouse.id, kitchen.id, workshop.id]);
  });

  it("sorts the worst health first, attention before healthy", () => {
    expect(ids(sortDevices(FLEET, "health"))).toEqual([kitchen.id, lamp.id, nameless.id, gate.id, garage.id, greenhouse.id, workshop.id]);
  });

  it("sorts by last seen, newest first, never-seen last", () => {
    const never = makeDevice({ id: "000000000001", name: "Never", lastSeen: null, health: "unknown" });
    const out = sortDevices([kitchen, never, lamp, workshop], "seen");
    expect(ids(out)).toEqual([workshop.id, lamp.id, kitchen.id, never.id]);
  });

  it("sorts by uptime (longest first) and treats unreachable devices as unknown", () => {
    // kitchen reports uptime 99 but is offline, so it counts as unknown
    expect(ids(sortDevices(FLEET, "uptime"))).toEqual([garage.id, greenhouse.id, workshop.id, gate.id, nameless.id, lamp.id, kitchen.id]);
  });

  it("sorts by signal, strongest first, no signal (or offline) last", () => {
    // -58, -60 (fixture default), -66, -71, then unknown by name
    expect(ids(sortDevices(FLEET, "rssi"))).toEqual([workshop.id, nameless.id, garage.id, greenhouse.id, lamp.id, gate.id, kitchen.id]);
  });

  it("does not mutate its input", () => {
    const copy = [...FLEET];
    sortDevices(FLEET, "health");
    expect(FLEET).toEqual(copy);
  });
});

describe("attentionText", () => {
  it("says no issues for a healthy device", () => {
    expect(attentionText(workshop, NOW)).toEqual({ tone: "none", icon: "none", text: "No issues" });
  });
  it("explains safe mode with its reason and marks it bad", () => {
    expect(attentionText(gate, NOW)).toEqual({ tone: "bad", icon: "alert", text: "Safe mode: boot loop: 3 resets before healthy" });
  });
  it("uses plain words for other flags", () => {
    expect(attentionText(garage, NOW)).toMatchObject({ tone: "warn", text: "MQTT disconnected" });
    expect(attentionText(nameless, NOW).text).toBe("Update waiting to be confirmed");
  });
  it("shows last seen for offline and unreachable devices", () => {
    expect(attentionText(kitchen, NOW).text).toBe("Last seen 2 h ago");
    expect(attentionText(lamp, NOW)).toMatchObject({ tone: "warn", text: "Not answering · last seen 45 s ago" });
  });
  it("covers the in-between states", () => {
    expect(attentionText({ ...workshop, health: "unknown" }, NOW).text).toBe("Checking this device");
    expect(attentionText({ ...workshop, health: "rebooting" }, NOW).text).toMatch(/Restarting/);
  });
});

describe("nameList", () => {
  it("lists a few names and counts the rest", () => {
    expect(nameList([workshop, garage])).toBe("Workshop node, Garage door");
    expect(nameList(FLEET, 2)).toBe("Workshop node, Greenhouse and 5 more");
  });
});

describe("remembered preferences", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips view and sort", () => {
    savePrefs({ view: "table", sort: "rssi" });
    expect(loadPrefs()).toEqual({ view: "table", sort: "rssi" });
  });
  it("falls back to defaults on nothing, junk or unknown values", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, "{not json");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: "tiles", sort: "colour" }));
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs({ view: "table", sort: "name" })).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});
