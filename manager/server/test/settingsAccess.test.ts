import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ErrorResponse, HealthResponse } from "../src/types/api";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  srv = await startTestServer({ networkScan: false, discovery: { mdns: false, interfaces: () => [] } });
});
after(() => srv.close());

test("the LAN switch and token are not part of the settings API (they live under /api/access)", async () => {
  const got = await fetchJson<Record<string, unknown>>(`${srv.base}/api/settings`);
  assert.equal(got.status, 200);
  assert.ok(!("lanEnabled" in got.body) && !("lanToken" in got.body));
  for (const key of ["lanEnabled", "lanToken"]) {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: true }) });
    assert.equal(r.status, 400, key);
    assert.equal(r.body.code, "invalid_body");
  }
});

test("GET /api/health reports when the server started (the About card shows it)", async () => {
  const before = Date.now();
  const h = await fetchJson<HealthResponse>(`${srv.base}/api/health`);
  const started = h.body.startedAt ?? 0;
  assert.ok(started <= before && started > before - 60_000);
  assert.equal(h.body.lan, false);
});
