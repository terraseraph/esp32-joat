import { describe, expect, it } from "vitest";
import { makeJob } from "../../../test/jobs";
import { chooseResult, doneResult, failureHint, isRemoteBrowser, setupApSsid, signalBars, sortNetworks } from "./logic";

describe("isRemoteBrowser", () => {
  it("is only true in LAN mode for a non-loopback host", () => {
    expect(isRemoteBrowser(false, "192.168.1.5")).toBe(false);
    expect(isRemoteBrowser(true, "localhost")).toBe(false);
    expect(isRemoteBrowser(true, "127.0.0.1")).toBe(false);
    expect(isRemoteBrowser(true, "app.localhost")).toBe(false);
    expect(isRemoteBrowser(true, "192.168.1.5")).toBe(true);
    expect(isRemoteBrowser(true, "manager.lan")).toBe(true);
  });
});

describe("helpers", () => {
  it("builds the setup AP name from the last six characters of the id", () => {
    expect(setupApSsid("A4CF12B3C4D5")).toBe("esp32-b3c4d5");
  });
  it("maps signal to bars", () => {
    expect([null, 0, 10, 30, 60, 90].map(signalBars)).toEqual([0, 0, 1, 2, 3, 4]);
  });
  it("sorts networks strongest first", () => {
    const sorted = sortNetworks([
      { ssid: "b", rssi: -80 },
      { ssid: "c", rssi: -50 },
      { ssid: "a", rssi: -80 },
    ]);
    expect(sorted.map((n) => n.ssid)).toEqual(["c", "a", "b"]);
  });
  it("reads the choose result only while that step runs", () => {
    const result = { networks: [{ ssid: "Home", rssi: -50, secure: true }], device: { id: "x", name: "n", fw: "0.1.0", app_version: "v" } };
    const waiting = makeJob({ id: "j", kind: "setup", steps: [{ id: "choose", label: "Choose a network", status: "running" }], result });
    expect(chooseResult(waiting)?.networks).toHaveLength(1);
    expect(chooseResult({ ...waiting, steps: [{ id: "choose", label: "Choose a network", status: "done" }] })).toBeNull();
    expect(chooseResult({ ...waiting, result: undefined })).toBeNull();
  });
  it("reads the done result only for a succeeded job", () => {
    const result = { deviceId: "a4cf12b3c4d5", host: "192.168.1.9", name: "Node", added: true };
    expect(doneResult(makeJob({ id: "j", state: "succeeded", result }))).toEqual(result);
    expect(doneResult(makeJob({ id: "j", state: "running", result }))).toBeNull();
  });
  it("has a hint for the failures a person can fix", () => {
    expect(failureHint("restore_failed")).toMatch(/Restore network/);
    expect(failureHint("wifi_auth")).toMatch(/password/);
    expect(failureHint("something_else")).toBeNull();
  });
});
