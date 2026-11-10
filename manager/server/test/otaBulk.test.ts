import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ErrorResponse } from "../src/types/api";
import type { FirmwareImage, OtaBulkResult, OtaDeviceResult } from "../src/types/api-firmware";
import type { Job } from "../src/types/api-jobs";
import { makeFakeImage, type FakeDevice } from "./fake/fakeDevice";
import { sleep, statusOf, waitUntil } from "./fake/testkit";
import { startGateProxy, startOtaEnv, type OtaEnv } from "./otaKit";

let env: OtaEnv;
before(async () => {
  env = await startOtaEnv();
});
after(() => env.close());

let n = 0;
const image = async (size = 200_000): Promise<FirmwareImage> => {
  const r = await env.upload(makeFakeImage({ version: `bulk${String(++n).padStart(3, "0")}`, size }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const devices = async (count: number, extra: Parameters<typeof env.fake>[0] = {}): Promise<FakeDevice[]> => {
  const out: FakeDevice[] = [];
  for (let i = 0; i < count; i++) {
    const d = await env.fake({ appVersion: "0ldbulk", ...extra });
    await env.addDevice(d);
    out.push(d);
  }
  return out;
};
const bulk = (body: Record<string, unknown>) => env.send<Job & ErrorResponse>("POST", "/api/firmware/update", body);
const row = (job: Job, id: string) => job.devices.find((d) => d.deviceId === id);

describe("bulk update (M10)", () => {
  test("concurrency is respected (1 and 2) and everything succeeds", async () => {
    for (const concurrency of [1, 2]) {
      const devs = await devices(4, { verifyMs: 200 });
      const img = await image();
      const r = await bulk({ deviceIds: devs.map((d) => d.id), firmwareId: img.id, concurrency });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.kind, "ota");
      assert.equal(r.body.params.action, "bulk");
      assert.deepEqual(r.body.actions.sort(), ["cancel"]);
      let max = 0;
      const job = await env.waitJob(r.body.id, (j) => {
        max = Math.max(max, j.devices.filter((d) => d.state === "running").length);
        return ["succeeded", "failed", "partial", "cancelled"].includes(j.state);
      });
      assert.equal(job.state, "succeeded", JSON.stringify(job));
      assert.equal(max, concurrency, `most devices running at once (concurrency ${concurrency})`);
      for (const d of devs) {
        assert.equal(row(job, d.id)?.state, "done");
        assert.equal((row(job, d.id)?.result as OtaDeviceResult).toVersion, img.version);
        assert.equal((await statusOf(d)).ota.app_version, img.version);
      }
      assert.deepEqual(job.result as OtaBulkResult, { updated: 4, skipped: 0, failed: 0, rolledBack: 0, cancelled: 0 });
      assert.match(job.message ?? "", /4 updated/);
    }
  });

  test("one device fails mid-upload, one rolls back, one works: partial, with stopOnFailures high enough not to pause", async () => {
    const [good, failing, rolling] = await devices(3);
    failing!.options.faults.otaFailAtBytes = 20_000;
    rolling!.options.faults.otaRollback = true;
    const img = await image(300_000);
    const r = await bulk({ deviceIds: [failing!.id, rolling!.id, good!.id], firmwareId: img.id, concurrency: 1, stopOnFailures: 5 });
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "partial", JSON.stringify(job));
    assert.equal(row(job, good!.id)?.state, "done");
    assert.equal(row(job, failing!.id)?.state, "failed");
    assert.equal(row(job, failing!.id)?.error?.code, "upload_failed");
    assert.equal(row(job, failing!.id)?.error?.step, "uploading");
    assert.equal(row(job, rolling!.id)?.state, "rolled_back");
    assert.equal(row(job, rolling!.id)?.error?.code, "rolled_back");
    assert.deepEqual(job.result as OtaBulkResult, { updated: 1, skipped: 0, failed: 1, rolledBack: 1, cancelled: 0 });
    assert.deepEqual(job.actions, ["retry"]);
  });

  test("an offline device fails alone; the others carry on", async () => {
    const [a, b] = await devices(2);
    await b!.goOffline("refuse");
    const img = await image();
    const r = await bulk({ deviceIds: [b!.id, a!.id], firmwareId: img.id, stopOnFailures: 3 });
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "partial", JSON.stringify(job));
    assert.equal(row(job, b!.id)?.error?.code, "device_offline");
    assert.equal(row(job, a!.id)?.state, "done");
    await b!.goOnline();
  });

  test("pauses itself after the first failure, then resume finishes the rest", async () => {
    const [failing, ok1, ok2] = await devices(3);
    failing!.options.faults.otaFailAtBytes = 20_000;
    const img = await image(300_000);
    const r = await bulk({ deviceIds: [failing!.id, ok1!.id, ok2!.id], firmwareId: img.id, concurrency: 1 }); // stopOnFailures default 1
    const paused = await env.waitJob(r.body.id, (j) => j.state === "paused");
    assert.match(paused.message ?? "", /Paused/);
    assert.deepEqual(paused.actions.sort(), ["cancel", "resume"]);
    assert.equal(row(paused, failing!.id)?.state, "failed");
    assert.equal(row(paused, ok1!.id)?.state, "queued");
    assert.equal(row(paused, ok2!.id)?.state, "queued");
    await sleep(250);
    const still = (await env.send<Job>("GET", `/api/jobs/${r.body.id}`)).body;
    assert.equal(still.state, "paused", "nothing starts while paused");
    assert.equal(row(still, ok1!.id)?.state, "queued");
    assert.equal((await statusOf(ok1!)).ota.app_version, "0ldbulk");

    const resumed = await env.send<Job>("POST", `/api/jobs/${r.body.id}/resume`);
    assert.equal(resumed.status, 200);
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "partial", JSON.stringify(job));
    assert.equal(row(job, ok1!.id)?.state, "done");
    assert.equal(row(job, ok2!.id)?.state, "done");
  });

  test("cancel mid-upload aborts the request and starts nobody else", async () => {
    const stuck = await env.fake({ appVersion: "0ldbulk" });
    const proxy = await startGateProxy(stuck.port, 100_000);
    try {
      await env.addDevice({ port: proxy.port });
      const [next] = await devices(1);
      const img = await image(1_800_000);
      const r = await bulk({ deviceIds: [stuck.id, next!.id], firmwareId: img.id, concurrency: 1 });
      await env.waitJob(r.body.id, (j) => row(j, stuck.id)?.step === "uploading" && (row(j, stuck.id)?.progress ?? 0) > 0);
      await sleep(100);
      assert.equal((await env.send<Job>("POST", `/api/jobs/${r.body.id}/cancel`)).status, 200);
      const job = await env.waitJob(r.body.id);
      assert.equal(job.state, "cancelled", JSON.stringify(job));
      assert.equal(row(job, stuck.id)?.state, "cancelled");
      assert.equal(row(job, next!.id)?.state, "cancelled");
      assert.equal((await statusOf(next!)).ota.app_version, "0ldbulk");
      assert.equal(next!.requestLog.filter((e) => e.method === "POST" && e.path.endsWith("/ota")).length, 0);
      proxy.release();
      await waitUntil(async () => (await statusOf(stuck)).ota.session !== "writing", 3000, "half upload dropped");
      assert.equal((await statusOf(stuck)).ota.app_version, "0ldbulk");
    } finally {
      await proxy.close();
    }
  });

  test("a cancelled retry reports the same cancelled count as its device rows", async () => {
    const stuck = await env.fake({ appVersion: "0ldbulk" });
    const proxy = await startGateProxy(stuck.port, 100_000);
    try {
      await env.addDevice({ port: proxy.port });
      const [next] = await devices(1);
      const img = await image(1_800_000);
      const ids = [stuck.id, next!.id];
      const first = await bulk({ deviceIds: ids, firmwareId: img.id, concurrency: 1 });
      await env.waitJob(first.body.id, (j) => row(j, stuck.id)?.step === "uploading");
      await env.send("POST", `/api/jobs/${first.body.id}/cancel`);
      const firstEnd = await env.waitJob(first.body.id);
      assert.equal(firstEnd.state, "cancelled");
      assert.deepEqual(firstEnd.result as OtaBulkResult, { updated: 0, skipped: 0, failed: 0, rolledBack: 0, cancelled: 2 });

      await waitUntil(async () => (await statusOf(stuck)).ota.session !== "writing", 3000, "half upload dropped");

      const retry = await env.send<Job>("POST", `/api/jobs/${first.body.id}/retry`);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      await env.waitJob(retry.body.id, (j) => row(j, stuck.id)?.step === "uploading");
      await env.send("POST", `/api/jobs/${retry.body.id}/cancel`);
      const job = await env.waitJob(retry.body.id);
      assert.equal(job.state, "cancelled", JSON.stringify(job));
      const rows = job.devices.filter((d) => d.state === "cancelled").length;
      assert.equal(rows, 2, "both rows are cancelled");
      assert.deepEqual(job.result as OtaBulkResult, { updated: 0, skipped: 0, failed: 0, rolledBack: 0, cancelled: rows });
    } finally {
      proxy.release();
      await proxy.close();
    }
  });

  test("retry starts a new job with only the failed devices", async () => {
    const [good, failing] = await devices(2);
    failing!.options.faults.otaFailAtBytes = 20_000;
    const img = await image(300_000);
    const r = await bulk({ deviceIds: [good!.id, failing!.id], firmwareId: img.id, concurrency: 1, stopOnFailures: 5 });
    const first = await env.waitJob(r.body.id);
    assert.equal(first.state, "partial");
    assert.deepEqual(first.actions, ["retry"]);

    delete failing!.options.faults.otaFailAtBytes;
    const retry = await env.send<Job>("POST", `/api/jobs/${r.body.id}/retry`);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.notEqual(retry.body.id, r.body.id);
    assert.deepEqual(retry.body.deviceIds, [failing!.id]);
    const second = await env.waitJob(retry.body.id);
    assert.equal(second.state, "succeeded", JSON.stringify(second));
    assert.equal((await statusOf(failing!)).ota.app_version, img.version);
    const again = await env.send<ErrorResponse>("POST", `/api/jobs/${r.body.id}/retry`);
    assert.equal(again.status, 409, "only once");
  });

  test("skipSame: a device already on the image is skipped (and updated when skipSame is false)", async () => {
    const same = await env.fake({ appVersion: "same001" });
    await env.addDevice(same);
    const [other] = await devices(1);
    const up = await env.upload(makeFakeImage({ version: "same001", size: 50_000 })); // the fake's default build date and time
    const r = await bulk({ deviceIds: [same.id, other!.id], firmwareId: up.body.id });
    const job = await env.waitJob(r.body.id);
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    assert.equal(row(job, same.id)?.state, "skipped");
    assert.match(row(job, same.id)?.message ?? "", /Already on same001/);
    assert.equal(row(job, other!.id)?.state, "done");
    assert.deepEqual(job.result as OtaBulkResult, { updated: 1, skipped: 1, failed: 0, rolledBack: 0, cancelled: 0 });
    assert.equal((await statusOf(same)).ota.running_partition, "ota_0", "untouched");

    const forced = await env.waitJob((await bulk({ deviceIds: [same.id], firmwareId: up.body.id, skipSame: false })).body.id);
    assert.equal(forced.state, "succeeded", JSON.stringify(forced));
    assert.equal(row(forced, same.id)?.state, "done");
    assert.equal((await statusOf(same)).ota.running_partition, "ota_1");
  });

  test("request checks: unknown device or image, a device already in a job, validation", async () => {
    const [dev] = await devices(1, { verifyMs: 300 });
    const img = await image();
    let r = await bulk({ deviceIds: ["000000000000"], firmwareId: img.id });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "unknown_device");
    r = await bulk({ deviceIds: [dev!.id], firmwareId: "e".repeat(64) });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "unknown_image");
    for (const bad of [{ deviceIds: [], firmwareId: img.id }, { deviceIds: [dev!.id], firmwareId: img.id, concurrency: 5 }, { deviceIds: [dev!.id], firmwareId: img.id, extra: 1 }]) {
      assert.equal((await bulk(bad)).status, 400);
    }
    const first = await bulk({ deviceIds: [dev!.id], firmwareId: img.id });
    assert.equal(first.status, 201);
    const second = await bulk({ deviceIds: [dev!.id], firmwareId: img.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "ota_running");
    assert.deepEqual((second.body.details as { deviceIds: string[] }).deviceIds, [dev!.id]);
    await env.waitJob(first.body.id);
  });
});
