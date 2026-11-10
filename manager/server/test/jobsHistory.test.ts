import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import type { StartOptions } from "../src/app";
import { defineRoute } from "../src/http/router";
import { createJobService, type JobControl, type JobService } from "../src/jobs";
import { INTERRUPTED_MESSAGE } from "../src/jobs/history";
import type { ErrorResponse, Job } from "../src/types/api";
import { sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, tmpDataDir } from "./helpers";

const HISTORY = (dir: string): string => path.join(dir, "jobs.json");
const open = (dataDir: string, keepFinished?: number): { jobs: JobService; logs: string[] } => {
  const logs: string[] = [];
  const jobs = createJobService({ dataDir, log: (m) => logs.push(m), config: { wsThrottleMs: 0, persistDebounceMs: 10, ...(keepFinished !== undefined ? { keepFinished } : {}) } });
  return { jobs, logs };
};
const readFile = (dir: string): { version: number; jobs: Job[] } => JSON.parse(readFileSync(HISTORY(dir), "utf8")) as { version: number; jobs: Job[] };
const never = (ctl: JobControl): Promise<void> => new Promise<void>((r) => ctl.signal.addEventListener("abort", () => r(), { once: true }));

describe("persisted job history (jobs.json)", () => {
  test("finished jobs are written (debounced) and come back after a restart exactly as the API returned them", async () => {
    const dir = tmpDataDir();
    const a = open(dir);
    const ok = a.jobs.create({ kind: "ota", title: "Update", params: { version: "1.2.3", password: "pw-SECRET" }, steps: [{ id: "s", label: "Step" }], devices: [{ deviceId: "aaaaaaaaaaaa", name: "One" }] }, (ctl) => {
      ctl.step("s", "done");
      ctl.device("aaaaaaaaaaaa", { state: "done", message: "fine" });
      ctl.result({ version: "1.2.3", apiKey: "k-SECRET" });
    });
    const bad = a.jobs.create({ kind: "setup", title: "Broken", supports: { retry: true }, deviceIds: [] }, () => {
      throw new Error("boom");
    });
    const okFinal = await a.jobs.whenDone(ok.id);
    const badFinal = await a.jobs.whenDone(bad.id);
    await waitUntil(() => existsSync(HISTORY(dir)) && readFile(dir).jobs.length === 2);
    await a.jobs.close();

    const file = readFileSync(HISTORY(dir), "utf8");
    assert.ok(!file.includes("SECRET"), "no secret reaches the file");

    const b = open(dir);
    const back = b.jobs.get(ok.id) as Job;
    assert.deepEqual({ ...back, result: undefined }, { ...okFinal, result: undefined });
    assert.deepEqual(back.params, { version: "1.2.3" });
    assert.deepEqual(back.result, { version: "1.2.3" });
    assert.equal(b.jobs.get(bad.id)?.state, "failed");
    assert.deepEqual(b.jobs.get(bad.id)?.actions, [], "a restored job offers no actions");
    assert.equal(badFinal.state, "failed");
    assert.deepEqual(b.jobs.list().map((j) => j.id), [bad.id, ok.id], "newest first");
    assert.equal(b.jobs.list({ active: false }).length, 2);
    assert.equal((await b.jobs.whenDone(ok.id)).state, "succeeded");
    await b.jobs.close();
  });

  test("a job running when the service closes comes back as interrupted", async () => {
    const dir = tmpDataDir();
    const a = open(dir);
    const running = a.jobs.create({ kind: "ota", title: "Long", steps: [{ id: "s1", label: "One" }, { id: "s2", label: "Two" }], devices: [{ deviceId: "bbbbbbbbbbbb" }, { deviceId: "cccccccccccc" }] }, async (ctl) => {
      ctl.step("s1", "running");
      ctl.device("bbbbbbbbbbbb", { state: "running", progress: 0.3 });
      await never(ctl);
    });
    const other = a.jobs.create({ kind: "ota", title: "Another" }, never);
    await waitUntil(() => a.jobs.get(running.id)?.state === "running" && a.jobs.get(other.id)?.state === "running");
    await a.jobs.close();

    const b = open(dir);
    for (const id of [running.id, other.id]) {
      const j = b.jobs.get(id) as Job;
      assert.equal(j.state, "interrupted");
      assert.equal(j.message, INTERRUPTED_MESSAGE);
      assert.deepEqual(j.actions, []);
      assert.ok(j.finishedAt, "finishedAt is set");
      assert.equal(j.error?.code, "interrupted");
    }
    const j = b.jobs.get(running.id) as Job;
    assert.deepEqual(j.steps.map((s) => s.status), ["failed", "skipped"]);
    assert.deepEqual(j.devices.map((d) => d.state), ["failed", "skipped"]);
    assert.equal((await b.jobs.whenDone(running.id)).state, "interrupted");
    assert.deepEqual(b.jobs.list({ active: true }), []);
    await b.jobs.close();
    assert.equal((readFile(dir).jobs.find((x) => x.id === running.id) as Job).state, "interrupted", "the converted state is saved again");
  });

  test("an unclean stop (no close) also yields interrupted: the file holds the running job", async () => {
    const dir = tmpDataDir();
    const a = open(dir);
    const job = a.jobs.create({ kind: "ota", title: "Crash" }, never);
    await waitUntil(() => existsSync(HISTORY(dir)) && readFile(dir).jobs.some((j) => j.id === job.id && j.state === "running"));
    const b = open(dir); // the first service is simply abandoned, as after a crash
    assert.equal(b.jobs.get(job.id)?.state, "interrupted");
    await b.jobs.close();
    await a.jobs.close();
  });

  test("the file is bounded to keepFinished finished jobs, also across restarts", async () => {
    const dir = tmpDataDir();
    const a = open(dir, 3);
    for (let i = 0; i < 6; i++) {
      const j = a.jobs.create({ kind: "ota", title: `Job ${i}` }, () => {});
      await a.jobs.whenDone(j.id);
    }
    await a.jobs.close();
    assert.deepEqual(readFile(dir).jobs.map((j) => j.title), ["Job 3", "Job 4", "Job 5"]);

    const b = open(dir, 2); // a smaller limit on the next start
    assert.deepEqual(b.jobs.list().map((j) => j.title), ["Job 5", "Job 4"]);
    const extra = b.jobs.create({ kind: "ota", title: "Job 6" }, () => {});
    await b.jobs.whenDone(extra.id);
    assert.deepEqual(b.jobs.list().map((j) => j.title), ["Job 6", "Job 5"]);
    await b.jobs.close();
    assert.deepEqual(readFile(dir).jobs.map((j) => j.title), ["Job 5", "Job 6"]);
  });

  test("secrets in params, results, device results and error details are stripped again on write", async () => {
    const dir = tmpDataDir();
    const a = open(dir);
    const j = a.jobs.create({ kind: "setup", title: "Secrets", devices: [{ deviceId: "dddddddddddd" }] }, (ctl) => {
      ctl.device("dddddddddddd", { state: "done", result: { token: "t-SECRET", ok: true } });
      ctl.result({ nested: { wifiPsk: "psk-SECRET", fine: 1 } });
      ctl.fail({ code: "x", message: "failed", details: { password: "d-SECRET", host: "h" } });
    });
    await a.jobs.whenDone(j.id);
    await a.jobs.close();
    const text = readFileSync(HISTORY(dir), "utf8");
    assert.ok(!text.includes("SECRET"), text);
    const saved = readFile(dir).jobs[0] as Job;
    assert.deepEqual(saved.result, { nested: { fine: 1 } });
    assert.deepEqual(saved.devices[0]?.result, { ok: true });
    assert.deepEqual(saved.error?.details, { host: "h" });
  });

  test("a corrupt file is logged and moved aside, never fatal; the service works and writes a fresh file", async () => {
    const dir = tmpDataDir();
    writeFileSync(HISTORY(dir), '{"version":1,"jobs":[{"id":');
    const a = open(dir);
    assert.deepEqual(a.jobs.list(), []);
    assert.ok(a.logs.some((l) => /job history .*ignored/.test(l)), a.logs.join("\n"));
    assert.ok(readdirSync(dir).some((f) => f.startsWith("jobs.json.corrupt-")));
    const j = a.jobs.create({ kind: "ota", title: "After" }, () => {});
    await a.jobs.whenDone(j.id);
    await a.jobs.close();
    assert.deepEqual(readFile(dir).jobs.map((x) => x.title), ["After"]);

    // valid JSON of the wrong shape, and entries that are not jobs
    writeFileSync(HISTORY(dir), JSON.stringify({ jobs: "nope" }));
    assert.deepEqual(open(dir).jobs.list(), []);
    writeFileSync(HISTORY(dir), JSON.stringify({ version: 1, jobs: [{ id: "x" }, 5, null] }));
    assert.deepEqual(open(dir).jobs.list(), []);
  });

  test("retry of a restored failed job is refused with a plain 409", async () => {
    const dir = tmpDataDir();
    const a = open(dir);
    const j = a.jobs.create({ kind: "ota", title: "Retryable", supports: { retry: true }, deviceIds: [] }, () => {
      throw new Error("x");
    });
    await a.jobs.whenDone(j.id);
    await a.jobs.close();
    const b = open(dir);
    await assert.rejects(b.jobs.retry(j.id), (e: { status?: number; code?: string; message?: string }) => e.status === 409 && e.code === "job_action_unavailable" && /restart/i.test(e.message ?? ""));
    await b.jobs.close();
  });
});

const testRoutes = [
  defineRoute({
    method: "POST",
    path: "/api/test/hang-job",
    summary: "a job that runs until aborted",
    tags: ["test"],
    response: Type.Unknown(),
    handler: ({ app }) => ({ status: 201, body: app.jobs.create({ kind: "backup-apply", title: "Hangs", params: { secretToken: "x" } }, never) }),
  }),
  defineRoute({
    method: "POST",
    path: "/api/test/quick-job",
    summary: "a job that ends at once",
    tags: ["test"],
    response: Type.Unknown(),
    handler: ({ app }) => ({
      status: 201,
      body: app.jobs.create({ kind: "ota", title: "Quick", supports: { retry: true }, deviceIds: [] }, () => {
        throw new Error("x");
      }),
    }),
  }),
];

describe("history over a server restart (same data dir)", () => {
  test("GET /api/jobs shows the old jobs; the running one is interrupted; retry is a 409", async () => {
    const dataDir = tmpDataDir();
    const opts: Partial<StartOptions> = { dataDir, jobs: { wsThrottleMs: 0, persistDebounceMs: 10 }, discovery: { mdns: false, interfaces: () => [] }, extraRoutes: testRoutes };
    const one = await startTestServer(opts);
    const post = <T>(base: string, p: string) => fetchJson<T>(`${base}${p}`, { method: "POST" });
    const quick = (await post<Job>(one.base, "/api/test/quick-job")).body;
    const hang = (await post<Job>(one.base, "/api/test/hang-job")).body;
    await waitUntil(async () => (await fetchJson<Job>(`${one.base}/api/jobs/${hang.id}`)).body.state === "running");
    await waitUntil(async () => (await fetchJson<Job>(`${one.base}/api/jobs/${quick.id}`)).body.state === "failed");
    await one.close();

    const two = await startTestServer(opts);
    try {
      const list = await fetchJson<Job[]>(`${two.base}/api/jobs`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.map((j) => [j.title, j.state]).sort(), [["Hangs", "interrupted"], ["Quick", "failed"]]);
      const got = await fetchJson<Job>(`${two.base}/api/jobs/${hang.id}`);
      assert.equal(got.body.message, INTERRUPTED_MESSAGE);
      assert.deepEqual(got.body.params, {}, "the secret-looking param never existed");
      assert.equal((await fetchJson<Job[]>(`${two.base}/api/jobs?active=true`)).body.length, 0);
      const retry = await post<ErrorResponse>(two.base, `/api/jobs/${quick.id}/retry`);
      assert.equal(retry.status, 409);
      assert.equal(retry.body.code, "job_action_unavailable");
      assert.equal((await post<Job>(two.base, `/api/jobs/${hang.id}/cancel`)).body.state, "interrupted", "cancel on a finished job is a no-op");
      await sleep(30);
    } finally {
      await two.close();
    }
  });
});
