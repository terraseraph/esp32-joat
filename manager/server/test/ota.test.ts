import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { DeviceSummary, ErrorResponse } from "../src/types/api";
import type { FirmwareImage, OtaDeviceResult } from "../src/types/api-firmware";
import type { Job } from "../src/types/api-jobs";
import { makeFakeImage } from "./fake/fakeDevice";
import { sleep, statusOf, waitUntil } from "./fake/testkit";
import { startGateProxy, startOtaEnv, type OtaEnv } from "./otaKit";

let env: OtaEnv;
before(async () => {
  env = await startOtaEnv();
});
after(() => env.close());

const image = async (version: string, size = 200_000): Promise<FirmwareImage> => {
  const r = await env.upload(makeFakeImage({ version, size }));
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
  return r.body;
};
const start = (deviceId: string, firmwareId: string) => env.send<Job & ErrorResponse>("POST", `/api/devices/${deviceId}/ota`, { firmwareId });

describe("single-device update (M9)", () => {
  test("success: steps, device row, result, new version in the summary", async () => {
    const dev = await env.fake({ appVersion: "0ld0001" });
    await env.addDevice(dev);
    const img = await image("n3w0001");
    const r = await start(dev.id, img.id);
    assert.equal(r.status, 201);
    assert.equal(r.body.kind, "ota");
    assert.equal(r.body.params.action, "update");
    assert.deepEqual(r.body.steps.map((s) => s.id), ["checking", "uploading", "rebooting", "verifying"]);
    assert.deepEqual(r.body.deviceIds, [dev.id]);

    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    assert.equal(job.progress, 1);
    const row = job.devices[0];
    assert.equal(row?.state, "done");
    const result = row?.result as OtaDeviceResult;
    assert.deepEqual(result, { fromVersion: "0ld0001", toVersion: "n3w0001", partition: "ota_1" });
    assert.deepEqual(job.result, result);
    assert.ok(job.steps.every((s) => s.status === "done"), JSON.stringify(job.steps));

    const st = await statusOf(dev);
    assert.equal(st.ota.app_version, "n3w0001");
    assert.equal(st.ota.image_state, "valid", "pending_verify became valid before the job finished");
    await waitUntil(async () => (await env.summary(dev.id)).app_version === "n3w0001", 3000, "summary shows the new version");
    const s = await env.summary(dev.id);
    assert.equal(s.health, "online");
    assert.equal(s.ota.running_partition, "ota_1");
  });

  test("health reads 'updating' while the job runs and 'online' after", async () => {
    const dev = await env.fake({ appVersion: "0ld0002", verifyMs: 300 });
    await env.addDevice(dev);
    const img = await image("n3w0002");
    const r = await start(dev.id, img.id);
    let updating = false;
    for (let i = 0; i < 300 && !updating; i++) {
      updating = (await env.summary(dev.id)).health === "updating";
      await sleep(10);
    }
    assert.ok(updating, "the summary said 'updating' during the job");
    await env.waitJob(r.body.id);
    await waitUntil(async () => (await env.summary(dev.id)).health === "online", 3000, "back online after the job");
  });

  test("pending_verify -> valid: waits for the device to confirm", async () => {
    const dev = await env.fake({ appVersion: "0ld0003", verifyMs: 500 });
    await env.addDevice(dev);
    const img = await image("n3w0003");
    const r = await start(dev.id, img.id);
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    assert.equal((await statusOf(dev)).ota.image_state, "valid");
  });

  test("an image that never confirms itself fails with 'not_confirmed'", async () => {
    const dev = await env.fake({ appVersion: "0ld0004", verifyMs: 60_000 });
    await env.addDevice(dev);
    const e2 = await startOtaEnv({ firmware: { pendingVerifyMs: 250 } });
    try {
      await e2.addDevice(dev);
      const up = await e2.upload(makeFakeImage({ version: "n3w0004", size: 200_000 }));
      const r = await e2.send<Job>("POST", `/api/devices/${dev.id}/ota`, { firmwareId: up.body.id });
      const job = await e2.waitJob(r.body.id);
      assert.equal(job.state, "failed");
      assert.equal(job.error?.code, "not_confirmed");
      assert.equal(job.error?.step, "verifying");
    } finally {
      await e2.srv.close();
    }
  });

  test("upload failure (connection dies mid-way): failed at 'uploading', old firmware kept, device back to normal", async () => {
    const dev = await env.fake({ appVersion: "0ld0005", faults: { otaFailAtBytes: 20_000 } });
    await env.addDevice(dev);
    const img = await image("n3w0005", 300_000);
    const r = await start(dev.id, img.id);
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "failed", JSON.stringify(job));
    assert.equal(job.error?.code, "upload_failed");
    assert.equal(job.error?.step, "uploading");
    assert.match(job.error?.message ?? "", /still on 0ld0005/);
    assert.equal(job.devices[0]?.state, "failed");
    assert.equal(job.steps.find((s) => s.id === "uploading")?.status, "failed");
    assert.equal((await statusOf(dev)).ota.app_version, "0ld0005");
    await waitUntil(async () => (await env.summary(dev.id)).health === "online", 3000, "online again");
  });

  test("rollback detected: the device restarts but stays on the old firmware -> rolled_back", async () => {
    const dev = await env.fake({ appVersion: "0ld0007", faults: { otaRollback: true } });
    await env.addDevice(dev);
    const img = await image("n3w0007");
    const r = await start(dev.id, img.id);
    const job = await env.waitJob(r.body.id);
    assert.equal(job.devices[0]?.state, "rolled_back", JSON.stringify(job));
    assert.equal(job.devices[0]?.error?.code, "rolled_back");
    assert.equal(job.state, "failed");
    assert.match(job.devices[0]?.message ?? "", /did not start/);
    assert.equal((await statusOf(dev)).ota.app_version, "0ld0007");
  });

  test("refusals before anything is sent", async () => {
    const dev = await env.fake({ appVersion: "0ld0008" });
    await env.addDevice(dev);
    const img = await image("n3w0008");

    let r = await start("000000000000", img.id);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "unknown_device");
    r = await start(dev.id, "f".repeat(64));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "unknown_image");

    dev.state.ota.session = "writing";
    r = await start(dev.id, img.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "ota_busy");
    dev.state.ota.session = "idle";

    dev.state.ota.image_state = "pending_verify";
    r = await start(dev.id, img.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "pending_verify");
    dev.state.ota.image_state = "valid";

    const huge = await env.upload(makeFakeImage({ version: "huge001", size: 1_900_000 }));
    r = await start(dev.id, huge.body.id);
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "image_too_large");

    await dev.goOffline("refuse");
    r = await start(dev.id, img.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "device_offline");
    await dev.goOnline();

    assert.equal((await statusOf(dev)).ota.app_version, "0ld0008", "nothing was flashed");
    assert.equal(dev.requestLog.filter((e) => e.method === "POST" && e.path.endsWith("/ota")).length, 0);
  });

  test("a second update of a device that is already updating: 409 ota_running; delete of the image: 409 image_in_use", async () => {
    const dev = await env.fake({ appVersion: "0ld0009", verifyMs: 300 });
    await env.addDevice(dev);
    const img = await image("n3w0009");
    const first = await start(dev.id, img.id);
    assert.equal(first.status, 201);
    const second = await start(dev.id, img.id);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "ota_running");
    const del = await env.send<ErrorResponse>("DELETE", `/api/firmware/${img.id}`);
    assert.equal(del.status, 409);
    assert.equal(del.body.code, "image_in_use");
    const bulk = await env.send<ErrorResponse>("POST", "/api/firmware/update", { deviceIds: [dev.id], firmwareId: img.id });
    assert.equal(bulk.status, 409);
    assert.equal(bulk.body.code, "ota_running");
    await env.waitJob(first.body.id);
    // free again
    assert.equal((await env.send("DELETE", `/api/firmware/${img.id}`)).status, 204);
  });

  test("cancel mid-upload aborts the request; the device keeps its firmware", async () => {
    const dev = await env.fake({ appVersion: "0ld0010" });
    const proxy = await startGateProxy(dev.port, 100_000);
    try {
      const added = await env.addDevice({ port: proxy.port });
      assert.equal(added.id, dev.id);
      const img = await image("n3w0010", 1_800_000);
      const r = await start(dev.id, img.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await env.waitJob(r.body.id, (j) => (j.devices[0]?.progress ?? 0) > 0 && j.devices[0]?.step === "uploading");
      await sleep(100);
      const cancelled = await env.send<Job>("POST", `/api/jobs/${r.body.id}/cancel`);
      assert.equal(cancelled.status, 200);
      const job = await env.waitJob(r.body.id);
      assert.equal(job.state, "cancelled", JSON.stringify(job));
      assert.equal(job.devices[0]?.state, "cancelled");
      proxy.release();
      await waitUntil(async () => (await statusOf(dev)).ota.session !== "writing", 3000, "the device dropped the half upload");
      assert.equal((await statusOf(dev)).ota.app_version, "0ld0010");
    } finally {
      await proxy.close();
    }
  });
});

describe("manual rollback job (M9)", () => {
  test("goes back to the other partition and reports the version", async () => {
    const dev = await env.fake({ appVersion: "cur0001" }); // demo seed: slot 1 holds 5e3c76f
    await env.addDevice(dev);
    const r = await env.send<Job & ErrorResponse>("POST", `/api/devices/${dev.id}/rollback`);
    assert.equal(r.status, 201);
    assert.equal(r.body.kind, "ota");
    assert.equal(r.body.params.action, "rollback");
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    const res = job.devices[0]?.result as OtaDeviceResult;
    assert.deepEqual(res, { fromVersion: "cur0001", toVersion: "5e3c76f", partition: "ota_1" });
    assert.equal((await statusOf(dev)).ota.running_partition, "ota_1");
    await waitUntil(async () => (await env.summary(dev.id)).app_version === "5e3c76f", 3000, "summary updated");
  });

  test("refused when there is no previous firmware, when offline, when unknown", async () => {
    const dev = await env.fake({ seed: "empty" });
    await env.addDevice(dev);
    let r = await env.send<ErrorResponse>("POST", `/api/devices/${dev.id}/rollback`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "rollback_not_possible");
    r = await env.send<ErrorResponse>("POST", "/api/devices/000000000000/rollback");
    assert.equal(r.status, 404);
    await dev.goOffline("refuse");
    r = await env.send<ErrorResponse>("POST", `/api/devices/${dev.id}/rollback`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "device_offline");
    await dev.goOnline();
  });

  test("an update followed by a rollback returns to the first version", async () => {
    const dev = await env.fake({ appVersion: "fir0001" });
    await env.addDevice(dev);
    const img = await image("sec0001");
    const up = await env.waitJob((await start(dev.id, img.id)).body.id);
    assert.equal(up.state, "succeeded", JSON.stringify(up));
    const back = await env.waitJob((await env.send<Job>("POST", `/api/devices/${dev.id}/rollback`)).body.id);
    assert.equal(back.state, "succeeded", JSON.stringify(back));
    assert.equal((back.devices[0]?.result as OtaDeviceResult).toVersion, "fir0001");
    const s: DeviceSummary = await env.summary(dev.id);
    assert.equal(s.ota.running_partition, "ota_0");
  });
});
