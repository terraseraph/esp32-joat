import type { Job } from "@shared/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakes";
import { makeJob } from "../test/jobs";
import { jobsStore, useJob, useJobs } from "./jobs";
import { resetApiForTests } from "./testing";
import { getBrowserWs } from "./ws";

interface Call {
  method: string;
  path: string;
}

/** Stub fetch: `jobs` is what GET /api/jobs answers; POST actions answer through `post`. */
function stubServer(opts: { jobs?: Job[]; post?: (path: string) => { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0] ?? "";
    calls.push({ method, path });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/api/jobs") return json(opts.jobs ?? []);
    const one = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const hit = (opts.jobs ?? []).find((j) => j.id === one[1]);
      return hit ? json(hit) : json({ error: "There is no job with that id.", code: "not_found" }, 404);
    }
    if (method === "POST" && opts.post) {
      const r = opts.post(path);
      return json(r.body, r.status);
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

function openSocket() {
  getBrowserWs().connect();
  act(() => FakeWebSocket.last().open());
}

describe("jobs store", () => {
  it("seeds from GET /api/jobs, then follows WebSocket job messages (newest wins, finished stays finished)", async () => {
    stubServer({ jobs: [makeJob({ id: "a", title: "First" })] });
    openSocket();
    const { result } = renderHook(() => useJob("a"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.job?.title).toBe("First"));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    act(() => FakeWebSocket.last().emit({ t: "job", job: makeJob({ id: "a", progress: 0.6, updatedAt: "2026-11-10T09:00:05.000Z", message: "Sending" }) }));
    expect(result.current.job?.progress).toBe(0.6);
    expect(result.current.job?.message).toBe("Sending");

    // an older message that arrives late is ignored
    act(() => FakeWebSocket.last().emit({ t: "job", job: makeJob({ id: "a", progress: 0.1, updatedAt: "2026-11-10T09:00:02.000Z" }) }));
    expect(result.current.job?.progress).toBe(0.6);

    act(() =>
      FakeWebSocket.last().emit({
        t: "job",
        job: makeJob({ id: "a", state: "succeeded", progress: 1, actions: [], updatedAt: "2026-11-10T09:00:09.000Z", finishedAt: "2026-11-10T09:00:09.000Z" }),
      }),
    );
    expect(result.current.job?.state).toBe("succeeded");
    // even a non-final copy with a newer clock cannot bring a finished job back
    act(() => FakeWebSocket.last().emit({ t: "job", job: makeJob({ id: "a", state: "running", updatedAt: "2026-11-10T09:00:10.000Z" }) }));
    expect(result.current.job?.state).toBe("succeeded");
  });

  it("a job that only arrives over the WebSocket is shown at once, without waiting for the list", async () => {
    stubServer({ jobs: [] });
    openSocket();
    const { result } = renderHook(() => useJob("new"));
    act(() => FakeWebSocket.last().emit({ t: "job", job: makeJob({ id: "new", title: "Brand new" }) }));
    expect(result.current.job?.title).toBe("Brand new");
    expect(result.current.loading).toBe(false);
  });

  it("asks the server for a job the list did not contain, and reports not_found plainly", async () => {
    const { calls } = stubServer({ jobs: [] });
    openSocket();
    const { result } = renderHook(() => useJob("gone"));
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
    expect(result.current.job).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(calls.filter((c) => c.path === "/api/jobs/gone")).toHaveLength(1);
  });

  it("useJobs lists newest first and filters by kind and active", async () => {
    stubServer({
      jobs: [
        makeJob({ id: "old", kind: "ota", state: "succeeded", createdAt: "2026-11-10T08:00:00.000Z", updatedAt: "2026-11-10T08:05:00.000Z" }),
        makeJob({ id: "mid", kind: "ip-change", createdAt: "2026-11-10T08:30:00.000Z" }),
      ],
    });
    openSocket();
    const all = renderHook(() => useJobs());
    const active = renderHook(() => useJobs({ active: true }));
    const ota = renderHook(() => useJobs({ kind: "ota" }));
    await waitFor(() => expect(all.result.current.loaded).toBe(true));
    expect(all.result.current.jobs.map((j) => j.id)).toEqual(["mid", "old"]);
    expect(active.result.current.jobs.map((j) => j.id)).toEqual(["mid"]);
    expect(ota.result.current.jobs.map((j) => j.id)).toEqual(["old"]);

    act(() => FakeWebSocket.last().emit({ t: "job", job: makeJob({ id: "top", kind: "ota", createdAt: "2026-11-10T09:00:00.000Z" }) }));
    expect(all.result.current.jobs.map((j) => j.id)).toEqual(["top", "mid", "old"]);
    expect(ota.result.current.jobs.map((j) => j.id)).toEqual(["top", "old"]);
  });

  it("reloads the list when the socket reopens, to catch what was missed", async () => {
    const server = { jobs: [makeJob({ id: "a" })] };
    const { calls } = stubServer(server);
    openSocket();
    const { result } = renderHook(() => useJobs());
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    const before = calls.filter((c) => c.path === "/api/jobs").length;

    act(() => FakeWebSocket.last().serverClose());
    server.jobs = [makeJob({ id: "a", state: "succeeded", actions: [], updatedAt: "2026-11-10T09:05:00.000Z" }), makeJob({ id: "b", createdAt: "2026-11-10T09:01:00.000Z" })];
    getBrowserWs().connect();
    act(() => FakeWebSocket.last().open());
    await waitFor(() => expect(result.current.jobs).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/api/jobs").length).toBeGreaterThan(before);
    expect(jobsStore.get().byId["a"]?.state).toBe("succeeded");
  });

  it("actions post to the server and put the answer in the store; a failed action is reported as error", async () => {
    const { calls } = stubServer({
      jobs: [makeJob({ id: "a", actions: ["cancel", "pause"] })],
      post: (path) =>
        path.endsWith("/cancel")
          ? { status: 200, body: makeJob({ id: "a", state: "cancelling", actions: [], updatedAt: "2026-11-10T09:00:09.000Z" }) }
          : { status: 409, body: { error: "This job cannot be paused right now (it is cancelling).", code: "job_action_unavailable" } },
    });
    openSocket();
    const { result } = renderHook(() => useJob("a"));
    await waitFor(() => expect(result.current.job).not.toBeNull());

    let returned: Job | null = null;
    await act(async () => {
      returned = await result.current.cancel();
    });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/jobs/a/cancel")).toBe(true);
    expect((returned as Job | null)?.state).toBe("cancelling");
    expect(result.current.job?.state).toBe("cancelling");
    expect(result.current.error).toBeNull();

    await act(async () => {
      returned = await result.current.pause();
    });
    expect(returned).toBeNull();
    expect(result.current.error?.code).toBe("job_action_unavailable");
    expect(result.current.error?.message).toMatch(/cannot be paused/);
  });

  it("retry returns the new job the server started", async () => {
    stubServer({
      jobs: [makeJob({ id: "a", state: "failed", actions: ["retry"], updatedAt: "2026-11-10T09:00:09.000Z" })],
      post: () => ({ status: 200, body: makeJob({ id: "b", title: "Retry of a", createdAt: "2026-11-10T09:10:00.000Z" }) }),
    });
    openSocket();
    const { result } = renderHook(() => useJob("a"));
    await waitFor(() => expect(result.current.job).not.toBeNull());
    let next: Job | null = null;
    await act(async () => {
      next = await result.current.retry();
    });
    expect((next as Job | null)?.id).toBe("b");
    expect(jobsStore.get().byId["b"]?.title).toBe("Retry of a");
  });
});
