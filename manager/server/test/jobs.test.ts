import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import WebSocket from "ws";
import { defineRoute } from "../src/http/router";
import { createJobService, JobFailure, sanitizeParams, type JobControl, type JobService, type JobSpec } from "../src/jobs";
import type { BrowserWsMessage, ErrorResponse, Job } from "../src/types/api";
import { fetchJson, startTestServer, type TestServer } from "./helpers";
import { sleep, waitUntil } from "./fake/testkit";

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({ kind: "ota", title: "Test job", ...over });

function newService(config?: { keepFinished?: number; wsThrottleMs?: number }) {
  const sent: BrowserWsMessage[] = [];
  const logs: string[] = [];
  const jobs = createJobService({ hub: { broadcast: (m) => sent.push(m) }, log: (m) => logs.push(m), config: { wsThrottleMs: 0, ...config } });
  return { jobs, sent, logs };
}

/** A body that blocks until the test releases it (or the job is aborted). */
function gate() {
  let release: () => void = () => {};
  const open = new Promise<void>((r) => (release = r));
  return { open, release };
}

const final = (jobs: JobService, job: Job): Promise<Job> => jobs.whenDone(job.id);

describe("job lifecycle", () => {
  test("queued -> running -> succeeded; steps, progress, result and timestamps", async () => {
    const { jobs } = newService();
    const g = gate();
    const created = jobs.create(spec({ steps: [{ id: "a", label: "First" }, { id: "b", label: "Second" }], deviceIds: ["aaaaaaaaaaaa"] }), async (ctl) => {
      ctl.step("a", "running");
      ctl.step("a", { status: "done", detail: "ok" });
      ctl.step("b", { status: "running", progress: 0.5 });
      ctl.message("Halfway there");
      await g.open;
      ctl.step("b", "done");
      ctl.result({ version: "1.2.3" });
    });
    assert.equal(created.state, "queued");
    assert.deepEqual(created.actions, ["cancel"]);
    assert.equal(created.progress, 0);
    assert.deepEqual(created.steps.map((s) => s.status), ["pending", "pending"]);
    assert.equal(created.startedAt, null);

    await waitUntil(() => jobs.get(created.id)?.message === "Halfway there");
    const mid = jobs.get(created.id) as Job;
    assert.equal(mid.state, "running");
    assert.ok(mid.startedAt);
    assert.equal(mid.progress, 0.75, "derived from the steps: one done + half of the running one");
    assert.equal(mid.steps[0]?.detail, "ok");
    assert.ok(mid.steps[0]?.startedAt && mid.steps[0]?.finishedAt);
    assert.equal(mid.steps[1]?.progress, 0.5);
    assert.equal(mid.finishedAt, null);

    g.release();
    const done = await final(jobs, created);
    assert.equal(done.state, "succeeded");
    assert.equal(done.progress, 1);
    assert.deepEqual(done.result, { version: "1.2.3" });
    assert.equal(done.error, null);
    assert.deepEqual(done.actions, []);
    assert.deepEqual(done.steps.map((s) => s.status), ["done", "done"]);
    assert.ok(done.finishedAt);
    assert.deepEqual(done.deviceIds, ["aaaaaaaaaaaa"]);
  });

  test("manual progress wins over the derived one; null is indeterminate", async () => {
    const { jobs } = newService();
    const g = gate();
    const j = jobs.create(spec({ steps: [{ id: "a", label: "A" }] }), async (ctl) => {
      ctl.progress(0.3, "Working");
      ctl.step("a", "done");
      await g.open;
      ctl.progress(null);
    });
    await waitUntil(() => jobs.get(j.id)?.steps[0]?.status === "done");
    assert.equal(jobs.get(j.id)?.progress, 0.3);
    assert.equal(jobs.get(j.id)?.message, "Working");
    g.release();
    await waitUntil(() => jobs.get(j.id)?.state === "succeeded");
    assert.equal(jobs.get(j.id)?.progress, 1, "success is always 1");
    const ind = jobs.create(spec(), () => {});
    assert.equal(ind.progress, null, "no steps and no devices: indeterminate");
  });

  test("a step the body introduces is appended; leftovers are settled on finish", async () => {
    const { jobs } = newService();
    const j = jobs.create(spec({ steps: [{ id: "later", label: "Later" }] }), (ctl) => {
      ctl.step("extra", { status: "running", label: "Extra step" });
    });
    const done = await final(jobs, j);
    assert.equal(done.state, "succeeded");
    assert.deepEqual(done.steps.map((s) => [s.id, s.label, s.status]), [
      ["later", "Later", "skipped"],
      ["extra", "Extra step", "done"],
    ]);
  });

  test("JobFailure ends failed with its code, message and step; the running step becomes failed", async () => {
    const { jobs } = newService();
    const j = jobs.create(spec({ steps: [{ id: "up", label: "Upload" }, { id: "verify", label: "Verify" }] }), (ctl) => {
      ctl.step("up", "running");
      throw new JobFailure("device_unreachable", "The device stopped answering.", "up", { host: "10.0.0.5" });
    });
    const done = await final(jobs, j);
    assert.equal(done.state, "failed");
    assert.deepEqual(done.error, { code: "device_unreachable", message: "The device stopped answering.", step: "up", details: { host: "10.0.0.5" } });
    assert.deepEqual(done.steps.map((s) => s.status), ["failed", "skipped"]);
    assert.notEqual(done.progress, 1);
  });

  test("any other throw ends failed with internal_error and a plain message (no stack in the job)", async () => {
    const { jobs, logs } = newService();
    const j = jobs.create(spec(), async () => {
      await sleep(1);
      throw new TypeError("secret internals: x is undefined");
    });
    const done = await final(jobs, j);
    assert.equal(done.state, "failed");
    assert.equal(done.error?.code, "internal_error");
    assert.ok(!done.error?.message.includes("secret internals"));
    assert.match(done.error?.message ?? "", /Something went wrong/);
    assert.ok(logs.some((l) => l.includes("secret internals")), "the details go to the log");
  });

  test("ctl.fail records the error without stopping; the job ends failed when the body returns", async () => {
    const { jobs } = newService();
    let afterFail = false;
    const j = jobs.create(spec(), (ctl) => {
      ctl.fail({ code: "not_confirmed", message: "The board never confirmed the change." });
      afterFail = true;
    });
    const done = await final(jobs, j);
    assert.equal(afterFail, true);
    assert.equal(done.state, "failed");
    assert.equal(done.error?.code, "not_confirmed");
  });

  test("device rows: all ok = succeeded, mixed = partial, none ok = failed (first device error), leftovers settled", async () => {
    const { jobs } = newService();
    const run = (states: Record<string, "done" | "failed" | "skipped" | "rolled_back" | "reverted">) => async (ctl: JobControl) => {
      for (const [id, state] of Object.entries(states)) {
        ctl.device(id, { state: "running", progress: 0.2 });
        ctl.device(id, { state, ...(state === "failed" ? { error: { code: "ota_failed", message: `${id} failed` } } : {}) });
      }
    };
    const devices = (...ids: string[]) => ids.map((deviceId) => ({ deviceId }));
    const ok = await final(jobs, jobs.create(spec({ devices: devices("a", "b") }), run({ a: "done", b: "skipped" })));
    assert.equal(ok.state, "succeeded");
    assert.equal(ok.progress, 1);

    const mixed = await final(jobs, jobs.create(spec({ devices: devices("a", "b", "c") }), run({ a: "done", b: "failed", c: "done" })));
    assert.equal(mixed.state, "partial");
    assert.equal(mixed.error, null);
    assert.equal(mixed.devices.find((d) => d.deviceId === "b")?.error?.code, "ota_failed");
    assert.deepEqual(mixed.deviceIds, ["a", "b", "c"]);

    const none = await final(jobs, jobs.create(spec({ devices: devices("a", "b") }), run({ a: "rolled_back", b: "failed" })));
    assert.equal(none.state, "failed");
    assert.equal(none.error?.code, "ota_failed", "the first device error is promoted");

    const left = await final(jobs, jobs.create(spec({ devices: devices("x", "y", "z") }), (ctl) => {
      ctl.device("x", { state: "done" });
      ctl.device("y", { state: "running" }); // never finished
    }));
    assert.deepEqual(left.devices.map((d) => d.state), ["done", "failed", "skipped"]);
    assert.equal(left.devices[1]?.error?.code, "interrupted");
    assert.equal(left.state, "partial");

    const added = await final(jobs, jobs.create(spec(), (ctl) => ctl.device("newone", { name: "Late", state: "done" })));
    assert.deepEqual(added.deviceIds, ["newone"]);
    assert.equal(added.devices[0]?.name, "Late");
  });

  test("exactly-once finish: updates after the end are ignored, listeners see one final state", async () => {
    const { jobs, sent } = newService();
    const finals: string[] = [];
    jobs.onChange((j) => {
      if (["succeeded", "failed", "partial", "cancelled"].includes(j.state)) finals.push(j.state);
    });
    let late: JobControl | null = null;
    const j = jobs.create(spec(), (ctl) => {
      late = ctl;
    });
    await final(jobs, j);
    (late as unknown as JobControl).message("too late");
    (late as unknown as JobControl).fail({ code: "x", message: "y" });
    assert.equal(jobs.get(j.id)?.message, undefined);
    assert.equal(jobs.get(j.id)?.state, "succeeded");
    assert.deepEqual(finals, ["succeeded"]);
    assert.equal(sent.filter((m) => m.t === "job" && m.job.id === j.id && m.job.state === "succeeded").length, 1);
  });

  test("snapshots are copies: mutating one does not change the job", async () => {
    const { jobs } = newService();
    const g = gate();
    const j = jobs.create(spec({ steps: [{ id: "a", label: "A" }], params: { x: { y: 1 } } }), () => g.open);
    const snap = jobs.get(j.id) as Job;
    snap.steps[0]!.label = "changed";
    (snap.params.x as { y: number }).y = 2;
    assert.equal(jobs.get(j.id)?.steps[0]?.label, "A");
    assert.deepEqual(jobs.get(j.id)?.params, { x: { y: 1 } });
    g.release();
    await final(jobs, j);
  });
});

describe("cancel", () => {
  test("running job: state cancelling, signal aborted, then cancelled when the body settles; idempotent", async () => {
    const { jobs } = newService();
    const winding = gate();
    let aborted = false;
    const j = jobs.create(spec({ steps: [{ id: "a", label: "A" }, { id: "b", label: "B" }], devices: [{ deviceId: "d1" }, { deviceId: "d2" }] }), async (ctl) => {
      ctl.step("a", "running");
      ctl.device("d1", { state: "running" });
      await new Promise<void>((r) => ctl.signal.addEventListener("abort", () => r(), { once: true }));
      aborted = ctl.signal.aborted && ctl.isCancelled();
      await winding.open; // e.g. restoring the network
    });
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    const first = jobs.cancel(j.id);
    assert.equal(first.state, "cancelling");
    assert.deepEqual(first.actions, []);
    assert.equal(jobs.cancel(j.id).state, "cancelling", "second cancel is a no-op");
    await waitUntil(() => aborted);
    assert.equal(jobs.get(j.id)?.state, "cancelling", "still cancelling while the body winds down");
    winding.release();
    const done = await final(jobs, j);
    assert.equal(done.state, "cancelled");
    assert.deepEqual(done.steps.map((s) => s.status), ["cancelled", "cancelled"]);
    assert.deepEqual(done.devices.map((d) => d.state), ["cancelled", "cancelled"]);
    assert.equal(done.error, null);
    assert.equal(jobs.cancel(j.id).state, "cancelled", "cancel of a finished job returns it unchanged");
  });

  test("cancelled before the body started: the body never runs", async () => {
    const { jobs } = newService();
    let ran = false;
    const j = jobs.create(spec(), () => {
      ran = true;
    });
    assert.equal(jobs.cancel(j.id).state, "cancelling");
    const done = await final(jobs, j);
    assert.equal(done.state, "cancelled");
    assert.equal(ran, false);
  });

  test("a throw caused by the abort is cancelled, not a failure; a JobFailure while cancelling keeps its error", async () => {
    const { jobs } = newService();
    const j = jobs.create(spec(), (ctl) => new Promise<void>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("AbortError")))));
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    jobs.cancel(j.id);
    const done = await final(jobs, j);
    assert.equal(done.state, "cancelled");
    assert.equal(done.error, null);

    const k = jobs.create(spec(), (ctl) => new Promise<void>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new JobFailure("network_not_restored", "Your Wi-Fi could not be put back.")))));
    await waitUntil(() => jobs.get(k.id)?.state === "running");
    jobs.cancel(k.id);
    const kd = await final(jobs, k);
    assert.equal(kd.state, "cancelled");
    assert.equal(kd.error?.code, "network_not_restored");
  });

  test("unknown ids are 404 not_found", async () => {
    const { jobs } = newService();
    assert.throws(() => jobs.cancel("nope"), (e: Error & { status?: number; code?: string }) => e.status === 404 && e.code === "not_found");
    await assert.rejects(jobs.pause("nope"), /no job/);
    assert.equal(jobs.get("nope"), undefined);
  });
});

describe("pause, resume, retry", () => {
  test("pause/resume: actions follow the state, the body waits in waitWhilePaused, hooks are called", async () => {
    const { jobs } = newService();
    const calls: string[] = [];
    let resumedAt = 0;
    const g = gate();
    const j = jobs.create(
      spec({ supports: { pause: true }, onPause: () => void calls.push("pause"), onResume: () => void calls.push("resume") }),
      async (ctl) => {
        await g.open;
        await ctl.waitWhilePaused();
        resumedAt = Date.now();
        ctl.message("after pause");
      },
    );
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    assert.deepEqual(jobs.get(j.id)?.actions, ["cancel", "pause"]);
    const paused = await jobs.pause(j.id);
    assert.equal(paused.state, "paused");
    assert.deepEqual(paused.actions, ["cancel", "resume"]);
    g.release();
    await sleep(60);
    assert.equal(jobs.get(j.id)?.message, undefined, "the body is held while paused");
    const pausedAt = Date.now();
    const resumed = await jobs.resume(j.id);
    assert.equal(resumed.state, "running");
    const done = await final(jobs, j);
    assert.equal(done.state, "succeeded");
    assert.equal(done.message, "after pause");
    assert.ok(resumedAt >= pausedAt);
    assert.deepEqual(calls, ["pause", "resume"]);
  });

  test("cancel releases a paused job", async () => {
    const { jobs } = newService();
    const g = gate();
    const j = jobs.create(spec({ supports: { pause: true } }), async (ctl) => {
      await g.open;
      await ctl.waitWhilePaused();
      if (ctl.isCancelled()) return;
      throw new Error("should have been cancelled");
    });
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    await jobs.pause(j.id);
    g.release();
    jobs.cancel(j.id);
    assert.equal((await final(jobs, j)).state, "cancelled");
  });

  test("actions that are not offered are 409 job_action_unavailable", async () => {
    const { jobs } = newService();
    const g = gate();
    const j = jobs.create(spec(), () => g.open);
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    for (const act of [jobs.pause, jobs.resume, jobs.retry]) {
      await assert.rejects(act(j.id), (e: Error & { status?: number; code?: string }) => e.status === 409 && e.code === "job_action_unavailable");
    }
    g.release();
    const done = await final(jobs, j);
    await assert.rejects(jobs.retry(done.id), (e: Error & { code?: string }) => e.code === "job_action_unavailable");
  });

  test("retry: offered after a failure when supported, runs onRetry, returns its job, only once", async () => {
    const { jobs } = newService();
    let attempts = 0;
    const make = (): Job =>
      jobs.create(
        spec({
          supports: { retry: true },
          onRetry: () => {
            attempts++;
            return make();
          },
        }),
        () => {
          if (attempts === 0) throw new JobFailure("flaky", "It broke once.");
        },
      );
    const first = make();
    const failed = await final(jobs, first);
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.actions, ["retry"]);
    const second = await jobs.retry(first.id);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(jobs.get(first.id)?.actions, [], "retry is used up");
    assert.equal((await final(jobs, second)).state, "succeeded");
    await assert.rejects(jobs.retry(first.id), /cannot be retried/);
    assert.equal(attempts, 1);
  });
});

describe("retention", () => {
  test("keeps the active jobs and only the last N finished ones; list filters and orders newest first", async () => {
    const { jobs } = newService({ keepFinished: 3 });
    const g = gate();
    const running = jobs.create(spec({ kind: "setup", title: "long" }), () => g.open);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const j = jobs.create(spec({ kind: i % 2 ? "ip-change" : "ota", title: `job ${i}` }), () => {});
      await final(jobs, j);
      ids.push(j.id);
    }
    assert.equal(jobs.get(ids[0]!), undefined, "oldest finished jobs were dropped");
    assert.equal(jobs.get(ids[1]!), undefined);
    assert.ok(jobs.get(ids[2]!) && jobs.get(ids[4]!));
    assert.equal(jobs.list().length, 4);
    assert.deepEqual(jobs.list().map((j) => j.title), ["job 4", "job 3", "job 2", "long"]);
    assert.deepEqual(jobs.list({ active: true }).map((j) => j.id), [running.id]);
    assert.equal(jobs.list({ active: false }).length, 3);
    assert.deepEqual(jobs.list({ kind: "ip-change" }).map((j) => j.title), ["job 3"]);
    assert.ok(jobs.get(running.id), "an active job is never dropped");
    g.release();
    await final(jobs, running);
    assert.equal(jobs.list().length, 3, "finishing the active one pushes out the oldest finished one");
  });
});

describe("params are sanitised", () => {
  test("secret-looking keys are removed at any depth", () => {
    const clean = sanitizeParams({
      ssid: "Home",
      password: "hunter2",
      wifiPsk: "abcdefgh",
      apiSecret: "s",
      authToken: "t",
      apiKey: "k",
      list: [{ passphrase: "p", ok: 1 }, "x"],
      nested: { deeper: { Password: "p", keep: true } },
      when: new Date("2026-01-01T00:00:00Z"),
      skipped: undefined,
    });
    assert.deepEqual(clean, { ssid: "Home", list: [{ ok: 1 }, "x"], nested: { deeper: { keep: true } }, when: "2026-01-01T00:00:00.000Z" });
  });

  test("a password in params never reaches the stored job, a listener or a broadcast", async () => {
    const { jobs, sent } = newService();
    const seen: string[] = [];
    jobs.onChange((j) => seen.push(JSON.stringify(j)));
    const j = jobs.create(spec({ kind: "setup", params: { ssid: "Home", password: "hunter2-SECRET", options: { wifi_psk: "hunter2-SECRET" } } }), (ctl) => ctl.message("joining"));
    await final(jobs, j);
    const everything = JSON.stringify([jobs.get(j.id), jobs.list(), sent, seen]);
    assert.ok(everything.includes("Home"));
    assert.ok(!everything.includes("hunter2-SECRET"));
  });
});

describe("WebSocket broadcast", () => {
  test("every change is pushed, throttled per job; the final state is sent at once", async () => {
    const { jobs, sent } = newService({ wsThrottleMs: 80 });
    const g = gate();
    const j = jobs.create(spec({ steps: [{ id: "a", label: "A" }] }), async (ctl) => {
      for (let i = 1; i <= 20; i++) ctl.progress(i / 20, `tick ${i}`);
      await g.open;
    });
    await waitUntil(() => jobs.get(j.id)?.message === "tick 20");
    const burst = sent.filter((m) => m.t === "job" && m.job.id === j.id);
    assert.ok(burst.length >= 1 && burst.length <= 3, `a burst of 22 changes is coalesced, got ${burst.length}`);
    assert.equal(burst[0]?.t === "job" && burst[0].job.state, "queued", "the first change goes out immediately");
    await sleep(120);
    const last = sent.filter((m) => m.t === "job" && m.job.id === j.id).at(-1);
    assert.equal(last?.t === "job" && last.job.message, "tick 20", "a trailing message carries the newest state");

    const before = sent.length;
    g.release();
    await final(jobs, j);
    const after = sent.slice(before).filter((m) => m.t === "job" && m.job.id === j.id);
    assert.equal(after.at(-1)?.t === "job" && after.at(-1)?.t === "job" && (after.at(-1) as { job: Job }).job.state, "succeeded");
    assert.equal(after.length, 1, "the final state is sent right away, once");
    const count = sent.length;
    await sleep(150);
    assert.equal(sent.length, count, "no stray trailing message after the final one");
  });

  test("two jobs are throttled independently", async () => {
    const { jobs, sent } = newService({ wsThrottleMs: 200 });
    const a = jobs.create(spec({ title: "a" }), () => sleep(30));
    const b = jobs.create(spec({ title: "b" }), () => sleep(30));
    assert.ok(sent.some((m) => m.t === "job" && m.job.id === a.id));
    assert.ok(sent.some((m) => m.t === "job" && m.job.id === b.id));
    await Promise.all([final(jobs, a), final(jobs, b)]);
  });
});

describe("close()", () => {
  test("cancels running jobs and waits for them to wind down", async () => {
    const { jobs } = newService();
    const order: string[] = [];
    const j = jobs.create(spec({ kind: "setup" }), async (ctl) => {
      await new Promise<void>((r) => ctl.signal.addEventListener("abort", () => r(), { once: true }));
      await sleep(40);
      order.push("restored");
    });
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    await jobs.close();
    order.push("closed");
    assert.deepEqual(order, ["restored", "closed"]);
    assert.equal(jobs.get(j.id)?.state, "cancelled");
    assert.throws(() => jobs.create(spec(), () => {}), /closed/);
    await jobs.close(); // idempotent
  });

  test("gives up on a job that never stops after timeoutMs and marks it cancelled", async () => {
    const { jobs, logs } = newService();
    const j = jobs.create(spec(), () => new Promise<void>(() => {}));
    await waitUntil(() => jobs.get(j.id)?.state === "running");
    const t0 = Date.now();
    await jobs.close({ timeoutMs: 60 });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(jobs.get(j.id)?.state, "cancelled");
    assert.ok(logs.some((l) => l.includes("did not stop")));
  });
});

const releases = new Map<string, () => void>();
const testRoutes = [
  // What a feature track does: create a job from a route handler.
  defineRoute({
    method: "POST",
    path: "/api/test/jobs",
    summary: "create a test job",
    tags: ["test"],
    body: Type.Object({ title: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())), pausable: Type.Optional(Type.Boolean()) }),
    response: Type.Unknown(),
    handler: ({ app, body }) => {
      const g = gate();
      const job = app.jobs.create(
        { kind: "backup-apply", title: body.title, ...(body.params ? { params: body.params } : {}), supports: { pause: body.pausable === true }, steps: [{ id: "one", label: "One" }] },
        async (ctl) => {
          ctl.step("one", "running");
          ctl.message("started");
          await Promise.race([g.open, new Promise<void>((r) => ctl.signal.addEventListener("abort", () => r(), { once: true }))]);
          await ctl.waitWhilePaused();
          ctl.step("one", "done");
        },
      );
      releases.set(job.id, g.release);
      return { status: 201, body: job };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/test/jobs/:id/release",
    summary: "let a test job finish",
    tags: ["test"],
    params: Type.Object({ id: Type.String() }),
    response: Type.Unknown(),
    handler: ({ params }) => {
      releases.get(params.id)?.();
      return { body: { ok: true } };
    },
  }),
];

describe("HTTP routes and the browser WebSocket", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ jobs: { wsThrottleMs: 0 }, discovery: { mdns: false, interfaces: () => [] }, extraRoutes: testRoutes });
  });
  after(() => srv.close());
  const api = (p: string): string => `${srv.base}${p}`;
  const post = <T = unknown>(p: string, body?: unknown) =>
    fetchJson<T>(api(p), { method: "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const state = async (id: string): Promise<Job["state"]> => (await fetchJson<Job>(api(`/api/jobs/${id}`))).body.state;

  test("a fresh server has no jobs; unknown ids are 404 not_found; a bad filter is invalid_query", async () => {
    const list = await fetchJson<Job[]>(api("/api/jobs"));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, []);
    for (const [method, path] of [
      ["GET", "/api/jobs/nope"],
      ["POST", "/api/jobs/nope/cancel"],
      ["POST", "/api/jobs/nope/pause"],
      ["POST", "/api/jobs/nope/resume"],
      ["POST", "/api/jobs/nope/retry"],
    ] as const) {
      const r = await fetchJson<ErrorResponse>(api(path), { method });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.body.code, "not_found");
    }
    assert.equal((await fetchJson<ErrorResponse>(api("/api/jobs?kind=bogus"))).body.code, "invalid_query");
  });

  test("create, list with filters, get, cancel (cancelling then cancelled), 409 for unavailable actions", async () => {
    const made = await post<Job>("/api/test/jobs", { title: "First" });
    assert.equal(made.status, 201);
    const id = made.body.id;
    await waitUntil(async () => (await state(id)) === "running");

    const list = await fetchJson<Job[]>(api("/api/jobs?active=true&kind=backup-apply"));
    assert.deepEqual(list.body.map((j) => j.id), [id]);
    assert.deepEqual((await fetchJson<Job[]>(api("/api/jobs?kind=ota"))).body, []);
    assert.deepEqual((await fetchJson<Job[]>(api("/api/jobs?active=false"))).body, []);
    assert.deepEqual((await fetchJson<Job>(api(`/api/jobs/${id}`))).body.actions, ["cancel"]);

    const pause = await post<ErrorResponse>(`/api/jobs/${id}/pause`);
    assert.equal(pause.status, 409);
    assert.equal(pause.body.code, "job_action_unavailable");
    assert.equal((await post<ErrorResponse>(`/api/jobs/${id}/resume`)).status, 409);
    assert.equal((await post<ErrorResponse>(`/api/jobs/${id}/retry`)).status, 409);

    const cancel = await post<Job>(`/api/jobs/${id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state, "cancelling");
    await waitUntil(async () => (await state(id)) === "cancelled");
    assert.equal((await post<Job>(`/api/jobs/${id}/cancel`)).body.state, "cancelled");
    assert.deepEqual((await fetchJson<Job[]>(api("/api/jobs?active=false"))).body.map((j) => j.id), [id]);
  });

  test("pause and resume over HTTP", async () => {
    const id = (await post<Job>("/api/test/jobs", { title: "Pausable", pausable: true })).body.id;
    await waitUntil(async () => (await state(id)) === "running");
    const paused = await post<Job>(`/api/jobs/${id}/pause`);
    assert.equal(paused.body.state, "paused");
    assert.deepEqual(paused.body.actions, ["cancel", "resume"]);
    await post(`/api/test/jobs/${id}/release`);
    await sleep(40);
    assert.equal(await state(id), "paused", "the body is held at waitWhilePaused");
    assert.equal((await post<Job>(`/api/jobs/${id}/resume`)).body.state, "running");
    await waitUntil(async () => (await state(id)) === "succeeded");
  });

  test('WebSocket clients get { t: "job", job } for every state and never see the password in params', async () => {
    const frames: Job[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/ws`);
    const raw: string[] = [];
    ws.on("message", (d) => {
      const text = d.toString();
      raw.push(text);
      const msg = JSON.parse(text) as BrowserWsMessage;
      if (msg.t === "job") frames.push(msg.job);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const made = await post<Job>("/api/test/jobs", { title: "Secret holder", params: { ssid: "Home", password: "hunter2-SECRET", nested: { wifiPsk: "hunter2-SECRET" } } });
    const id = made.body.id;
    await waitUntil(() => frames.some((f) => f.id === id && f.state === "running"));
    await post(`/api/test/jobs/${id}/release`);
    await waitUntil(() => frames.some((f) => f.id === id && f.state === "succeeded"));
    ws.close();

    const mine = frames.filter((f) => f.id === id);
    assert.equal(mine[0]?.state, "queued");
    assert.equal(mine.at(-1)?.state, "succeeded");
    assert.equal(mine.at(-1)?.progress, 1);
    assert.deepEqual(mine.at(-1)?.params, { ssid: "Home", nested: {} });
    const responses = JSON.stringify([made.body, (await fetchJson(api(`/api/jobs/${id}`))).body, (await fetchJson(api("/api/jobs"))).body]);
    assert.ok(!responses.includes("hunter2-SECRET"));
    assert.ok(!raw.join("").includes("hunter2-SECRET"));
  });

  test("server close cancels running jobs", async () => {
    const own = await startTestServer({ discovery: { mdns: false, interfaces: () => [] }, extraRoutes: testRoutes });
    const made = await fetchJson<Job>(`${own.base}/api/test/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Dies with the server" }) });
    assert.equal(made.status, 201);
    await waitUntil(async () => (await fetchJson<Job>(`${own.base}/api/jobs/${made.body.id}`)).body.state === "running");
    await own.close(); // would hang if close() did not cancel and await the job
  });
});
