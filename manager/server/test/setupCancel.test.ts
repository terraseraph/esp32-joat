import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDataDir } from "./helpers";
import { AP_SSID, HOME, apiGet, apiPost, cancelAt, finish, networkIsBack, startJob, startRig, stepStatuses, waitForStep, type Rig } from "./setupKit";

const rigs: Rig[] = [];
const rig = async (...a: Parameters<typeof startRig>): Promise<Rig> => {
  const r = await startRig(...a);
  rigs.push(r);
  return r;
};
after(async () => {
  for (const r of rigs) await r.close();
});

const WIFI = { ssid: "workshop-wifi", password: "hunter2hunter2" };
const restored = (r: Rig): void => assert.deepEqual(networkIsBack(r), { ok: true, why: "" });

describe("cancel at every phase puts this PC's Wi-Fi back", () => {
  test("while joining the setup Wi-Fi", async () => {
    const r = await rig({ wifi: { connectDelayMs: 400 } });
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI }, "join_ap");
    assert.equal(end.state, "cancelled");
    assert.equal(stepStatuses(end).join_ap, "cancelled");
    restored(r);
  });

  test("while checking the device (it does not answer)", async () => {
    const r = await rig({ timings: { apReachMs: 5000 } });
    await r.dev.goOffline("hang");
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI }, "fingerprint");
    assert.equal(end.state, "cancelled");
    restored(r);
  });

  test("while waiting for the choice of a network", async () => {
    const r = await rig();
    const end = await cancelAt(r, { ssid: AP_SSID }, "choose");
    assert.equal(end.state, "cancelled");
    assert.equal(stepStatuses(end).choose, "cancelled");
    assert.equal(stepStatuses(end).leave_ap, "done", "the PC was put back, so the step is done");
    assert.equal(end.steps.find((s) => s.id === "leave_ap")?.detail, `Back on "${HOME}"`);
    assert.equal(stepStatuses(end).wait_lan, "cancelled", "steps that never ran stay cancelled");
    assert.equal(r.dev.state.network.provisioned, false);
    restored(r);
  });

  test("cancelled on the setup Wi-Fi and the PC cannot be put back: leave_ap failed", async () => {
    const r = await rig({ wifi: { faults: { rejoinFails: true } } });
    const end = await cancelAt(r, { ssid: AP_SSID }, "choose");
    assert.equal(stepStatuses(end).leave_ap, "failed");
    assert.equal(end.error?.code, "restore_failed");
  });

  test("while the device restarts for a factory reset", async () => {
    const r = await rig({ device: { factoryResetReturns: false }, timings: { factoryResetWaitMs: 5000 } });
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI, factoryResetFirst: true }, "factory_reset");
    assert.equal(end.state, "cancelled");
    restored(r);
  });

  test("while the device tests the network (the Wi-Fi call is slow)", async () => {
    const r = await rig({ device: { wifiSetDelayMs: 1500 } });
    const t0 = Date.now();
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI }, "send_wifi");
    assert.equal(end.state, "cancelled");
    assert.ok(Date.now() - t0 < 1200, "cancel must not wait for the device");
    restored(r);
  });

  test("while waiting for the device's answer", async () => {
    const r = await rig({ device: { wifiSetFails: true, wifiSetDropsResponse: true }, timings: { wifiResultMs: 5000 } });
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI }, "check_result");
    assert.equal(end.state, "cancelled");
    restored(r);
  });

  test("while looking for the device on the network", async () => {
    const r = await rig({ noLan: true, timings: { lanWaitMs: 5000 } });
    const end = await cancelAt(r, { ssid: AP_SSID, wifi: WIFI }, "wait_lan");
    assert.equal(end.state, "cancelled");
    assert.equal(stepStatuses(end).leave_ap, "done"); // the PC was already back; cancelling does not undo the device's new network
    restored(r);
  });

  test("cancelling is fast and idempotent, also after the job ended", async () => {
    const r = await rig();
    const job = await startJob(r, { ssid: AP_SSID });
    await waitForStep(r, job.id, "choose");
    const a = await apiPost<{ state: string }>(r, `/api/jobs/${job.id}/cancel`);
    assert.equal(a.status, 200);
    const end = await finish(r, job.id);
    assert.equal(end.state, "cancelled");
    const b = await apiPost<{ state: string }>(r, `/api/jobs/${job.id}/cancel`);
    assert.equal(b.body.state, "cancelled");
  });
});

describe("shutdown and crashes", () => {
  test("closing the Manager during a job puts the network back before it returns", async () => {
    const r = await rig();
    const job = await startJob(r, { ssid: AP_SSID });
    await waitForStep(r, job.id, "choose");
    assert.equal(r.wifi.connection.ssid, AP_SSID);
    await r.close();
    assert.equal(r.wifi.connection.ssid, HOME);
    restored(r);
  });

  test("a marker left by a crashed run is reported at start-up, nothing is switched by itself, Restore fixes it", async () => {
    const dataDir = tmpDataDir();
    mkdirSync(dataDir, { recursive: true });
    const marker = { v: 1, jobId: "dead-job", startedAt: "2026-11-10T09:00:00.000Z", originalSsid: HOME, originalProfile: HOME, profiles: ["de-esp32-setup-dead0000"] };
    writeFileSync(path.join(dataDir, "setup-recovery.json"), JSON.stringify(marker));
    const r = await rig({ dataDir });
    assert.ok(r.logs.some((l) => l.includes("did not finish") && l.includes("dead-job")), r.logs.join("\n"));
    // Pretend the crash left the PC on the device's Wi-Fi.
    await r.wifi.addTempProfile(AP_SSID, undefined, "de-esp32-setup-dead0000");
    await r.wifi.connect("de-esp32-setup-dead0000", AP_SSID);
    const callsBefore = r.wifi.calls.length;

    const rec = await apiGet<{ pending: boolean; marker: { jobId: string; originalSsid: string; profiles: string[]; startedAt: string } }>(r, "/api/setup/recovery");
    assert.equal(rec.body.pending, true);
    assert.deepEqual(rec.body.marker, { jobId: "dead-job", startedAt: marker.startedAt, originalSsid: HOME, profiles: ["de-esp32-setup-dead0000"] });
    assert.equal(r.wifi.calls.length, callsBefore, "reading the marker must not touch the network");
    assert.equal(r.wifi.connection.ssid, AP_SSID);

    const res = await apiPost<{ restored: boolean; message: string }>(r, "/api/setup/recovery/restore");
    assert.equal(res.body.restored, true, res.body.message);
    assert.equal(r.wifi.connection.ssid, HOME);
    assert.deepEqual(r.wifi.profileNames(), [HOME]);
    assert.equal(existsSync(path.join(dataDir, "setup-recovery.json")), false);
    assert.equal((await apiGet<{ pending: boolean }>(r, "/api/setup/recovery")).body.pending, false);
  });

  test("a marker file that cannot be read is set aside instead of blocking setup", async () => {
    const dataDir = tmpDataDir();
    writeFileSync(path.join(dataDir, "setup-recovery.json"), "{ not json");
    const r = await rig({ dataDir });
    assert.equal((await apiGet<{ pending: boolean }>(r, "/api/setup/recovery")).body.pending, false);
    assert.equal(existsSync(path.join(dataDir, "setup-recovery.json.bad")), true);
    assert.equal(readFileSync(path.join(dataDir, "setup-recovery.json.bad"), "utf8"), "{ not json");
    const job = await startJob(r, { ssid: AP_SSID, wifi: WIFI });
    assert.equal((await finish(r, job.id)).state, "succeeded");
  });

  test("restore is refused while a setup runs", async () => {
    const r = await rig();
    const job = await startJob(r, { ssid: AP_SSID });
    await waitForStep(r, job.id, "choose");
    const res = await apiPost<{ code: string }>(r, "/api/setup/recovery/restore");
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "setup_running");
    // The running job's own marker is not a leftover.
    assert.equal((await apiGet<{ pending: boolean }>(r, "/api/setup/recovery")).body.pending, false);
    await apiPost(r, `/api/jobs/${job.id}/cancel`);
    await finish(r, job.id);
  });
});
