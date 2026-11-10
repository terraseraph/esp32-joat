import { describe, expect, it } from "vitest";
import { makeJob } from "../../../../test/jobs";
import { cannotMoveReason, networkChoices, validateWifiForm, wifiMoveOutcome } from "./logic";

describe("validateWifiForm", () => {
  it("name 1-32 bytes, password empty or 8-63", () => {
    expect(validateWifiForm("Home", "")).toEqual({});
    expect(validateWifiForm("Home", "12345678")).toEqual({});
    expect(validateWifiForm("", "")).toHaveProperty("ssid");
    expect(validateWifiForm("a".repeat(33), "")).toHaveProperty("ssid");
    expect(validateWifiForm("é".repeat(17), "")).toHaveProperty("ssid"); // 34 bytes
    expect(validateWifiForm("Home", "1234567")).toHaveProperty("password");
    expect(validateWifiForm("Home", "x".repeat(64))).toHaveProperty("password");
  });
});

describe("networkChoices", () => {
  it("drops hidden names, keeps the strongest of each name, sorts by signal, marks secured ones", () => {
    const out = networkChoices([
      { ssid: "", rssi: -30, channel: 1, auth: 3 },
      { ssid: "b", rssi: -70, channel: 1, auth: 0 },
      { ssid: "a", rssi: -50, channel: 1, auth: 3 },
      { ssid: "b", rssi: -60, channel: 6, auth: 0 },
    ]);
    expect(out.map((n) => [n.ssid, n.rssi, n.secured])).toEqual([["a", -50, true], ["b", -60, false]]);
  });
});

describe("cannotMoveReason", () => {
  it("says why, nothing when it can", () => {
    expect(cannotMoveReason(false, false)).toBeNull();
    expect(cannotMoveReason(true, false)).toMatch(/isn't answering/);
    expect(cannotMoveReason(false, true)).toMatch(/dismiss/);
  });
});

describe("wifiMoveOutcome", () => {
  const base = { reason: null, reasonCode: null, restoredPrevious: null, oldHost: "a", newHost: null, addressChanged: false, staticIpReset: false, ssid: "Net" };
  it("nothing while running", () => {
    expect(wifiMoveOutcome(makeJob({ id: "1", kind: "wifi-move" }), null)).toBeNull();
  });
  it("ok, same address and new address", () => {
    const j = makeJob({ id: "1", kind: "wifi-move", state: "succeeded" });
    expect(wifiMoveOutcome(j, { ...base, outcome: "ok", newHost: "1.2.3.4" })?.body).toMatch(/address did not change at 1\.2\.3\.4/);
    expect(wifiMoveOutcome(j, { ...base, outcome: "ok", newHost: "1.2.3.4", addressChanged: true })?.body).toMatch(/address changed/);
  });
  it("failed: restored or not (save_failed)", () => {
    const j = makeJob({ id: "1", kind: "wifi-move", state: "failed", error: { code: "auth", message: "The network refused the password.", step: "switch" } });
    const back = wifiMoveOutcome(j, { ...base, outcome: "failed", restoredPrevious: true });
    expect(back?.tone).toBe("warn");
    expect(back?.body).toMatch(/refused the password.*previous network/);
    const save = wifiMoveOutcome({ ...j, error: { code: "save_failed", message: "It could not save.", step: "switch" } }, { ...base, outcome: "failed", restoredPrevious: false });
    expect(save?.tone).toBe("bad");
    expect(save?.body).toBe("It could not save.");
  });
  it("not found and cancelled", () => {
    const j = makeJob({ id: "1", kind: "wifi-move", state: "failed", error: { code: "not_found", message: "x", step: "find" } });
    expect(wifiMoveOutcome(j, { ...base, outcome: "not_found" })?.body).toMatch(/setup Wi-Fi/);
    expect(wifiMoveOutcome(makeJob({ id: "1", kind: "wifi-move", state: "cancelled" }), { ...base, outcome: "unknown" })?.title).toBe("Stopped waiting.");
  });
});
