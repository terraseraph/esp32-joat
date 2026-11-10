import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import type { Job } from "../src/types/api-jobs";
import type { SetupChooseResult, SetupJobResult } from "../src/types/api-setup";
import { AP_SSID, DEVICE_ID, HOME, apiGet, apiPost, finish, networkIsBack, startJob, startRig, stepStatuses, waitForStep, type Rig } from "./setupKit";

const rigs: Rig[] = [];
const rig = async (...a: Parameters<typeof startRig>): Promise<Rig> => {
  const r = await startRig(...a);
  rigs.push(r);
  return r;
};
after(async () => {
  for (const r of rigs) await r.close();
});

const ALL_DONE = {
  remember: "done",
  join_ap: "done",
  fingerprint: "done",
  scan: "skipped",
  choose: "skipped",
  factory_reset: "skipped",
  send_wifi: "done",
  check_result: "done",
  leave_ap: "done",
  wait_lan: "done",
  add: "done",
};

describe("setup job: success", () => {
  for (const pending of [false, true]) {
    test(`wifi given up front, ${pending ? "with" : "without"} wifi_change firmware`, async () => {
      const r = await rig({ device: { pendingFirmware: pending } });
      const job = await startJob(r, { ssid: AP_SSID, wifi: { ssid: "workshop-wifi", password: "hunter2hunter2" } });
      assert.equal(job.kind, "setup");
      assert.equal(job.state, "queued");
      const end = await finish(r, job.id);
      assert.equal(end.state, "succeeded", JSON.stringify(end.error));
      assert.deepEqual(stepStatuses(end), ALL_DONE);
      const result = end.result as SetupJobResult;
      assert.equal(result.deviceId, DEVICE_ID);
      assert.equal(result.added, true);
      assert.equal(result.host, `127.0.0.1:${r.dev.port}`);
      // The device is in the fleet and joined the network.
      assert.equal((await apiGet<{ id: string }[]>(r, "/api/devices")).body.some((d) => d.id === DEVICE_ID), true);
      assert.equal(r.dev.state.network.state, "sta_connected");
      assert.equal(r.dev.state.network.provisioned, true);
      // The PC's network is back, nothing is left behind.
      assert.deepEqual(networkIsBack(r), { ok: true, why: "" });
      // Order of the network calls: add temp profile, join the AP, rejoin home, delete the temp profile.
      const ops = r.wifi.calls.filter((c) => c.op !== "scan").map((c) => (c.op === "connect" ? `connect:${c.ssid}` : c.op));
      assert.deepEqual(ops, ["addTempProfile", `connect:${AP_SSID}`, `connect:${HOME}`, "deleteProfile"]);
      // Only safe params are public.
      assert.deepEqual(end.params, { ssid: AP_SSID, wifiSsid: "workshop-wifi", factoryResetFirst: false });
      assert.equal(end.devices.length, 1);
      assert.equal(end.devices[0]?.state, "done");
    });
  }

  test("an open setup Wi-Fi needs no password and the marker lives only while the job runs", async () => {
    const r = await rig();
    const job = await startJob(r, { ssid: AP_SSID, wifi: { ssid: "guest" } });
    const markerFile = path.join(r.dataDir, "setup-recovery.json");
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    assert.equal(existsSync(markerFile), false);
    assert.equal(r.wifi.calls.find((c) => c.op === "addTempProfile" && c.secured), undefined);
  });

  test("the marker is on disk, without any password, while the PC is on the setup Wi-Fi", async () => {
    const r = await rig({ ap: { password: "apsecret99" }, wifi: { connectDelayMs: 150 } });
    const job = await startJob(r, { ssid: AP_SSID, apPassword: "apsecret99" });
    await waitForStep(r, job.id, "choose");
    const file = path.join(r.dataDir, "setup-recovery.json");
    const text = readFileSync(file, "utf8");
    const marker = JSON.parse(text) as { jobId: string; originalSsid: string; profiles: string[]; v: number };
    assert.equal(marker.jobId, job.id);
    assert.equal(marker.originalSsid, HOME);
    assert.equal(marker.profiles.length, 1);
    assert.match(marker.profiles[0] ?? "", /^de-esp32-setup-/);
    assert.ok(!text.includes("apsecret99"));
    await apiPost(r, `/api/jobs/${job.id}/cancel`);
    assert.equal((await finish(r, job.id)).state, "cancelled");
    assert.equal(existsSync(file), false);
  });

  test("a device that was already in the fleet is not added twice (recover mode)", async () => {
    const r = await rig({ device: { name: "Bench node" } });
    // Known device whose address is outdated.
    await apiPost(r, "/api/devices", { host: `127.0.0.1:${r.dev.port}` }).catch(() => undefined);
    const job = await startJob(r, { ssid: AP_SSID, deviceId: DEVICE_ID, wifi: { ssid: "workshop-wifi", password: "hunter2hunter2" } });
    assert.equal(job.title.startsWith("Recover"), true);
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    const devices = (await apiGet<{ id: string }[]>(r, "/api/devices")).body.filter((d) => d.id === DEVICE_ID);
    assert.equal(devices.length, 1);
  });
});

describe("setup job: choosing the network", () => {
  test("the job waits in `choose`, offers the device's networks and continues after the choice", async () => {
    const r = await rig({ device: { pendingFirmware: true } });
    const job = await startJob(r, { ssid: AP_SSID });
    const waiting = await waitForStep(r, job.id, "choose");
    assert.equal(waiting.message, "Choose the network for the device");
    assert.equal(waiting.state, "running");
    const offer = waiting.result as SetupChooseResult;
    assert.equal(offer.device.id, DEVICE_ID);
    assert.equal(offer.device.name, "esp32-b3c4d5");
    assert.deepEqual(
      offer.networks.map((n) => n.ssid),
      ["workshop-wifi", "guest", "fail", "neighbour-5g", "FRITZ!Box 7590"].sort((a, b) => {
        const ra = r.dev.state.scan.find((x) => x.ssid === a)?.rssi ?? -100;
        const rb = r.dev.state.scan.find((x) => x.ssid === b)?.rssi ?? -100;
        return rb - ra;
      }),
    );
    assert.deepEqual(offer.networks.find((n) => n.ssid === "guest"), { ssid: "guest", rssi: -61, secure: false });
    assert.equal(offer.networks.find((n) => n.ssid === "workshop-wifi")?.secure, true);
    assert.deepEqual({ scan: stepStatuses(waiting).scan, choose: stepStatuses(waiting).choose }, { scan: "done", choose: "running" });

    const answered = await apiPost<Job>(r, `/api/setup/jobs/${job.id}/wifi`, { ssid: "workshop-wifi", password: "hunter2hunter2" });
    assert.equal(answered.status, 200);
    const end = await finish(r, job.id);
    assert.equal(end.state, "succeeded", JSON.stringify(end.error));
    assert.equal(stepStatuses(end).choose, "done");
    assert.deepEqual(networkIsBack(r), { ok: true, why: "" });
  });

  test("answering when the job is not waiting is 409 job_not_waiting; an unknown job is 404", async () => {
    const r = await rig();
    const none = await apiPost<{ code: string }>(r, "/api/setup/jobs/does-not-exist/wifi", { ssid: "x" });
    assert.equal(none.status, 404);
    const job = await startJob(r, { ssid: AP_SSID, wifi: { ssid: "guest" } });
    const early = await apiPost<{ code: string }>(r, `/api/setup/jobs/${job.id}/wifi`, { ssid: "guest" });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "job_not_waiting");
    await finish(r, job.id);
    const late = await apiPost<{ code: string }>(r, `/api/setup/jobs/${job.id}/wifi`, { ssid: "guest" });
    assert.equal(late.status, 409);
  });

  test("nobody chooses: choose_timeout, and the network is restored", async () => {
    const r = await rig({ timings: { chooseTimeoutMs: 150 } });
    const job = await startJob(r, { ssid: AP_SSID });
    const end = await finish(r, job.id);
    assert.equal(end.state, "failed");
    assert.equal(end.error?.code, "choose_timeout");
    assert.deepEqual(networkIsBack(r), { ok: true, why: "" });
  });

  test("only one setup at a time: setup_running", async () => {
    const r = await rig();
    const first = await startJob(r, { ssid: AP_SSID });
    await waitForStep(r, first.id, "choose");
    const second = await apiPost<{ code: string }>(r, "/api/setup/jobs", { ssid: AP_SSID });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "setup_running");
    await apiPost(r, `/api/jobs/${first.id}/cancel`);
    await finish(r, first.id);
    const third = await apiPost(r, "/api/setup/jobs", { ssid: AP_SSID, wifi: { ssid: "guest" } });
    assert.equal(third.status, 201);
    await finish(r, (third.body as Job).id);
  });
});
