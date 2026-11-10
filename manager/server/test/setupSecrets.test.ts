import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AP_SSID, FrameRecorder, apiGet, apiPost, finish, readAllFiles, startJob, startRig, waitForStep, type Rig } from "./setupKit";

const AP_PASSWORD = "APpass-LEAK-7391";
const WIFI_PASSWORD = "WIFIpass-LEAK-5528";

const rigs: Rig[] = [];
after(async () => {
  for (const r of rigs) await r.close();
});

/** Everything a client, a log reader or a disk inspector could see. */
async function everything(r: Rig, rec: FrameRecorder, responses: string[]): Promise<string> {
  for (const p of ["/api/jobs", "/api/setup/adapter", "/api/setup/aps?refresh=true", "/api/setup/recovery", "/api/devices", "/api/openapi.json"]) {
    responses.push(JSON.stringify((await apiGet(r, p)).body));
  }
  await new Promise((resolve) => setTimeout(resolve, 80)); // let the last WebSocket frames arrive
  return [
    ...responses,
    ...rec.frames,
    readAllFiles(r.dataDir),
    r.logs.join("\n"),
    JSON.stringify(r.wifi.calls),
    JSON.stringify(r.wifi.profileNames()),
  ].join("\n----\n");
}

for (const failing of [false, true]) {
  test(`a distinctive password appears in no response, WebSocket frame, data file or log line (${failing ? "failed" : "successful"} run)`, async () => {
    const r = await startRig({ ap: { password: AP_PASSWORD }, device: { pendingFirmware: true }, wifi: { connectDelayMs: 30 } });
    rigs.push(r);
    const rec = await FrameRecorder.connect(r);
    const responses: string[] = [];

    const start = await apiPost(r, "/api/setup/jobs", { ssid: AP_SSID, apPassword: AP_PASSWORD });
    responses.push(JSON.stringify(start.body));
    const job = start.body as { id: string };
    await waitForStep(r, job.id, "choose");
    // While it waits: the marker is on disk and the job is readable.
    responses.push(JSON.stringify((await apiGet(r, `/api/jobs/${job.id}`)).body));
    const choice = await apiPost(r, `/api/setup/jobs/${job.id}/wifi`, { ssid: failing ? "fail" : "workshop-wifi", password: WIFI_PASSWORD });
    responses.push(JSON.stringify(choice.body));
    const end = await finish(r, job.id);
    assert.equal(end.state, failing ? "failed" : "succeeded", JSON.stringify(end.error));
    responses.push(JSON.stringify(end));

    const all = await everything(r, rec, responses);
    rec.close();
    assert.ok(all.includes("de-esp32-setup-"), "sanity: the snapshot does contain job data");
    for (const secret of [AP_PASSWORD, WIFI_PASSWORD]) {
      assert.ok(!all.includes(secret), `the password ${secret} leaked`);
      // Not even a distinctive piece of it.
      assert.ok(!all.includes(secret.slice(2, -2)), `part of ${secret} leaked`);
    }
  });
}

test("a password typed on the command line of the fake adapter is not echoed either", async () => {
  const r = await startRig({ ap: { password: AP_PASSWORD } });
  rigs.push(r);
  const aps = await apiGet<{ aps: unknown[] }>(r, "/api/setup/aps?refresh=true");
  assert.ok(!JSON.stringify(aps.body).includes(AP_PASSWORD));
  const adapter = await apiGet(r, "/api/setup/adapter");
  assert.ok(!JSON.stringify(adapter.body).includes(AP_PASSWORD));
  const job = await startJob(r, { ssid: AP_SSID, apPassword: AP_PASSWORD, wifi: { ssid: "workshop-wifi", password: WIFI_PASSWORD } });
  assert.ok(!JSON.stringify(job).includes(AP_PASSWORD) && !JSON.stringify(job).includes(WIFI_PASSWORD));
  await finish(r, job.id);
});
