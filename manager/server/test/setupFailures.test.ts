import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import type { Job } from "../src/types/api-jobs";
import { startPlainServer, type PlainServer } from "./helpers/net";
import { AP_SSID, DEVICE_ID, HOME, apiGet, apiPost, finish, networkIsBack, startJob, startRig, stepStatuses, waitForStep, type Rig } from "./setupKit";

const rigs: Rig[] = [];
const plains: PlainServer[] = [];
const rig = async (...a: Parameters<typeof startRig>): Promise<Rig> => {
  const r = await startRig(...a);
  rigs.push(r);
  return r;
};
after(async () => {
  for (const r of rigs) await r.close();
  for (const p of plains) await p.close();
});

const WIFI = { ssid: "workshop-wifi", password: "hunter2hunter2" };

async function failedJob(r: Rig, body: Record<string, unknown> = { ssid: AP_SSID, wifi: WIFI }): Promise<Job> {
  const job = await startJob(r, body);
  const end = await finish(r, job.id);
  assert.equal(end.state, "failed", `expected a failed job, got ${end.state} ${JSON.stringify(end.result)}`);
  return end;
}

const restored = (r: Rig): void => assert.deepEqual(networkIsBack(r), { ok: true, why: "" });

describe("setup job: before the device is reached", () => {
  test("adapter unsupported: 409, and the adapter route says why", async () => {
    const reason = "This PC has no Wi-Fi adapter the Manager can control";
    const r = await rig({ wifi: { faults: { unsupported: reason } } });
    const res = await apiPost<{ code: string; error: string }>(r, "/api/setup/jobs", { ssid: AP_SSID, wifi: WIFI });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "adapter_unsupported");
    assert.equal(res.body.error, reason);
    const status = await apiGet<{ supported: boolean; reason: string }>(r, "/api/setup/adapter");
    assert.equal(status.body.supported, false);
    assert.equal(status.body.reason, reason);
    assert.deepEqual(r.wifi.calls, []); // nothing was touched
  });

  test("the setup Wi-Fi vanished: ap_not_found, network restored", async () => {
    const r = await rig({ wifi: { faults: { apDisappears: true } } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "ap_not_found");
    assert.match(end.error?.message ?? "", /no longer visible/);
    assert.equal(end.error?.step, "join_ap");
    assert.equal(stepStatuses(end).join_ap, "failed");
    restored(r);
  });

  test("wrong setup Wi-Fi password: ap_password_wrong", async () => {
    const r = await rig({ ap: { password: "rightpass1" } });
    const end = await failedJob(r, { ssid: AP_SSID, apPassword: "wrongpass1", wifi: WIFI });
    assert.equal(end.error?.code, "ap_password_wrong");
    assert.equal(end.error?.message, "The setup Wi-Fi password was not accepted.");
    restored(r);
  });

  test("no setup Wi-Fi password given for a secured one says so", async () => {
    const r = await rig({ ap: { password: "rightpass1" } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "ap_password_wrong");
    assert.match(end.error?.message ?? "", /needs a password/);
    restored(r);
  });

  test("the join does not come up on a visible open network: ap_not_found with the reason", async () => {
    const r = await rig({ wifi: { faults: { connectFails: true } } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "ap_not_found");
    restored(r);
  });

  test("the join does not come up on a visible secured network: the password is blamed", async () => {
    const r = await rig({ ap: { password: "rightpass1" }, wifi: { faults: { connectFails: true } } });
    const end = await failedJob(r, { ssid: AP_SSID, apPassword: "rightpass1", wifi: WIFI });
    assert.equal(end.error?.code, "ap_password_wrong");
    restored(r);
  });

  test("this PC's Wi-Fi refuses to save the temporary network: adapter_failed", async () => {
    const r = await rig({ wifi: { faults: { addProfileFails: true } } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "adapter_failed");
    restored(r);
  });

  test("the device does not answer on its setup address: device_not_responding (refused and hanging)", async () => {
    for (const mode of ["refuse", "hang"] as const) {
      const r = await rig();
      await r.dev.goOffline(mode);
      const end = await failedJob(r);
      assert.equal(end.error?.code, "device_not_responding", mode);
      assert.match(end.error?.message ?? "", /192\.168\.4\.1/);
      assert.equal(end.error?.step, "fingerprint");
      restored(r);
    }
  });

  test("something that is not a de-esp32 device answers: not_our_device, nothing is sent", async () => {
    const seen: string[] = [];
    const plain = await startPlainServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });
    plains.push(plain);
    const r = await rig({ ap: { host: plain.host } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "not_our_device");
    assert.deepEqual(seen, ["GET /api/v1/status"]);
    restored(r);
  });

  test("a captive portal that redirects is not our device either", async () => {
    const plain = await startPlainServer((_req, res) => {
      res.writeHead(302, { Location: "http://192.168.4.1/" });
      res.end();
    });
    plains.push(plain);
    const r = await rig({ ap: { host: plain.host } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "not_our_device");
    restored(r);
  });

  test("recover mode: a different device behind the same-looking setup Wi-Fi is refused", async () => {
    const r = await rig();
    // Same last six characters, different device.
    const end = await failedJob(r, { ssid: AP_SSID, deviceId: "ffffffb3c4d5", wifi: WIFI });
    assert.equal(end.error?.code, "not_our_device");
    assert.match(end.error?.message ?? "", new RegExp(DEVICE_ID));
    assert.equal(r.dev.state.network.provisioned, false); // nothing was changed on the device
    restored(r);
  });

  test("recover mode: deviceId that does not fit the setup Wi-Fi name is a 400", async () => {
    const r = await rig();
    const res = await apiPost<{ code: string }>(r, "/api/setup/jobs", { ssid: AP_SSID, deviceId: "a4cf12000000", wifi: WIFI });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "invalid_body");
  });
});

describe("setup job: factory reset", () => {
  test("factory reset first: the device restarts, comes back on its setup Wi-Fi and is then set up", async () => {
    const r = await rig({ device: { factoryResetReturns: true } });
    const job = await startJob(r, { ssid: AP_SSID, wifi: WIFI, factoryResetFirst: true });
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    assert.equal(stepStatuses(end).factory_reset, "done");
    assert.equal(r.dev.state.boot_count, 2);
    assert.equal(end.params.factoryResetFirst, true);
    // After the reset the setup Wi-Fi is open, so a second (open) profile was made.
    assert.equal(r.wifi.calls.filter((c) => c.op === "addTempProfile").length, 2);
    restored(r);
  });

  test("the device never comes back after the reset: device_not_responding, network restored", async () => {
    const r = await rig({ device: { factoryResetReturns: false }, timings: { factoryResetWaitMs: 500 } });
    const end = await failedJob(r, { ssid: AP_SSID, wifi: WIFI, factoryResetFirst: true });
    assert.equal(end.error?.code, "device_not_responding");
    assert.equal(end.error?.step, "factory_reset");
    restored(r);
  });

  test("factory reset can be chosen together with the network", async () => {
    const r = await rig({ device: { factoryResetReturns: true } });
    const job = await startJob(r, { ssid: AP_SSID });
    await waitForStep(r, job.id, "choose");
    await apiPost(r, `/api/setup/jobs/${job.id}/wifi`, { ...WIFI, factoryResetFirst: true });
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    assert.equal(stepStatuses(end).factory_reset, "done");
  });
});

describe("setup job: the device could not join the network", () => {
  const cases: [string, string, string][] = [
    ["fail", "wifi_auth", "password was wrong"],
    ["noap", "wifi_no_ap", "was not found by the device"],
    ["noip", "wifi_no_ip", "did not get an address"],
    ["timeout", "wifi_failed", "in time"],
    ["connect", "wifi_failed", "could not connect"],
  ];
  for (const [ssid, code, text] of cases) {
    test(`wifi_change reason for "${ssid}" becomes ${code}`, async () => {
      const r = await rig({ device: { pendingFirmware: true } });
      const end = await failedJob(r, { ssid: AP_SSID, wifi: { ssid, password: "whatever123" } });
      assert.equal(end.error?.code, code);
      assert.ok((end.error?.message ?? "").includes(text), end.error?.message);
      assert.ok((end.error?.message ?? "").includes(`"${ssid}"`));
      assert.equal(end.error?.step, "check_result");
      assert.equal(end.devices[0]?.state, "failed");
      assert.equal(r.dev.state.network.provisioned, false);
      restored(r);
    });
  }

  test("the answer is lost on the way but the device reports the failure afterwards", async () => {
    const r = await rig({ device: { pendingFirmware: true, wifiSetDropsResponse: true } });
    const end = await failedJob(r, { ssid: AP_SSID, wifi: { ssid: "fail", password: "whatever123" } });
    assert.equal(end.error?.code, "wifi_auth");
    restored(r);
  });

  test("the answer is lost on the way but the device joined (older firmware)", async () => {
    const r = await rig({ device: { wifiSetDropsResponse: true } });
    const job = await startJob(r, { ssid: AP_SSID, wifi: WIFI });
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    restored(r);
  });

  test("older firmware says only 'wifi test failed': wifi_failed with the likely reason", async () => {
    const r = await rig({ device: { wifiSetFails: true } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "wifi_failed");
    assert.match(end.error?.message ?? "", /wrong password/);
    restored(r);
  });

  test("a lost answer and no news afterwards: wifi_failed", async () => {
    const r = await rig({ device: { wifiSetFails: true, wifiSetDropsResponse: true }, timings: { wifiResultMs: 300 } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "wifi_failed");
    assert.match(end.error?.message ?? "", /did not say whether it joined/);
    restored(r);
  });
});

describe("setup job: after the device joined", () => {
  test("the device does not appear on the network: device_not_on_lan", async () => {
    const r = await rig({ noLan: true, timings: { lanWaitMs: 400 } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "device_not_on_lan");
    assert.match(end.error?.message ?? "", /did not appear on your network/);
    assert.ok(!(end.error?.message ?? "").includes("--no-network-scan"));
    assert.equal(end.error?.step, "wait_lan");
    assert.equal(r.dev.state.network.provisioned, true); // it did join
    assert.equal((await apiGet<unknown[]>(r, "/api/devices")).body.length, 0);
    restored(r); // the PC is back on its own network anyway
  });

  test("with network scanning off the message says that only known addresses were checked", async () => {
    const r = await rig({ noLan: true, timings: { lanWaitMs: 300 }, server: { networkScan: false } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "device_not_on_lan");
    assert.match(end.error?.message ?? "", /--no-network-scan/);
  });
});

describe("setup job: putting this PC's Wi-Fi back fails", () => {
  const markerPath = (r: Rig): string => path.join(r.dataDir, "setup-recovery.json");

  test("restore_failed keeps the marker; Restore network fixes it; Dismiss clears it", async () => {
    const r = await rig({ wifi: { faults: { rejoinFails: true } } });
    const end = await failedJob(r);
    assert.equal(end.error?.code, "restore_failed");
    assert.match(end.error?.message ?? "", /Could not rejoin "HomeNet"/);
    assert.match(end.error?.message ?? "", /Restore network/);
    assert.equal(end.error?.step, "leave_ap");
    // The marker stays, with what is needed to put things right and no password.
    assert.equal(existsSync(markerPath(r)), true);
    const marker = JSON.parse(readFileSync(markerPath(r), "utf8")) as { originalSsid: string };
    assert.equal(marker.originalSsid, HOME);
    const rec = await apiGet<{ pending: boolean; marker: { jobId: string; originalSsid: string; profiles: string[] } }>(r, "/api/setup/recovery");
    assert.equal(rec.body.pending, true);
    assert.equal(rec.body.marker.jobId, end.id);
    assert.equal(rec.body.marker.originalSsid, HOME);
    assert.ok(!("originalProfile" in rec.body.marker));

    // A new setup is refused until the PC's Wi-Fi was dealt with.
    const blocked = await apiPost<{ code: string }>(r, "/api/setup/jobs", { ssid: AP_SSID, wifi: WIFI });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "recovery_pending");

    // Restoring while the fault persists fails and keeps the marker.
    const again = await apiPost<{ restored: boolean; message: string }>(r, "/api/setup/recovery/restore");
    assert.equal(again.status, 200);
    assert.equal(again.body.restored, false);
    assert.match(again.body.message, /Could not rejoin "HomeNet"/);
    assert.equal(existsSync(markerPath(r)), true);

    r.wifi.faults.rejoinFails = false;
    const ok = await apiPost<{ restored: boolean; message: string }>(r, "/api/setup/recovery/restore");
    assert.equal(ok.body.restored, true);
    assert.match(ok.body.message, /back on "HomeNet"/);
    assert.equal(r.wifi.connection.ssid, HOME);
    assert.equal(existsSync(markerPath(r)), false);
    assert.equal((await apiGet<{ pending: boolean }>(r, "/api/setup/recovery")).body.pending, false);
    assert.deepEqual(await apiPost(r, "/api/setup/recovery/restore").then((x) => x.body), { restored: false, message: "There is nothing to restore." });
  });

  test("dismiss forgets the marker without touching the network", async () => {
    const r = await rig({ wifi: { faults: { rejoinFails: true } } });
    await failedJob(r);
    const before = r.wifi.calls.length;
    const res = await apiPost(r, "/api/setup/recovery/dismiss");
    assert.equal(res.status, 204);
    assert.equal(existsSync(markerPath(r)), false);
    assert.equal(r.wifi.calls.length, before);
    assert.equal((await apiGet<{ pending: boolean }>(r, "/api/setup/recovery")).body.pending, false);
  });

  test("when the setup itself failed too, the message says both", async () => {
    const r = await rig({ device: { pendingFirmware: true }, wifi: { faults: { rejoinFails: true } } });
    const end = await failedJob(r, { ssid: AP_SSID, wifi: { ssid: "fail", password: "whatever123" } });
    assert.equal(end.error?.code, "restore_failed");
    assert.match(end.error?.message ?? "", /password was wrong/);
  });
});
