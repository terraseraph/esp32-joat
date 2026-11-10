import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import { defineRoute } from "../src/http/router";
import { safeEqual } from "../src/http/security";
import type { AccessResponse, ErrorResponse } from "../src/types/api";
import { fetchJson, rawRequest, startTestServer, type TestServer } from "./helpers";

const postRoute = defineRoute({
  method: "POST",
  path: "/api/test/ping",
  summary: "mutating test route",
  tags: ["test"],
  response: Type.Object({ ok: Type.Boolean() }),
  handler: () => ({ body: { ok: true } }),
});

describe("localhost mode", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ extraRoutes: [postRoute], allowOrigins: ["http://localhost:5173"] });
  });
  after(() => srv.close());

  test("same loopback Host is accepted (localhost, 127.0.0.1)", async () => {
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: { Host: `localhost:${srv.port}` } })).status, 200);
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: { Host: `127.0.0.1:${srv.port}` } })).status, 200);
  });

  test("foreign Host is 403 forbidden_host (DNS rebinding)", async () => {
    const r = await rawRequest(srv.base, { path: "/api/health", headers: { Host: "evil.com" } });
    assert.equal(r.status, 403);
    assert.equal((JSON.parse(r.text) as ErrorResponse).code, "forbidden_host");
    const wrongPort = await rawRequest(srv.base, { path: "/api/health", headers: { Host: "localhost:1" } });
    assert.equal(wrongPort.status, 403);
  });

  test("foreign Origin on POST is 403 forbidden_origin", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/test/ping`, { method: "POST", headers: { origin: "http://evil.com" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "forbidden_origin");
    const nullOrigin = await fetchJson<ErrorResponse>(`${srv.base}/api/test/ping`, { method: "POST", headers: { origin: "null" } });
    assert.equal(nullOrigin.status, 403);
  });

  test("same-origin, allow-listed and absent Origin pass; foreign Origin on GET is fine", async () => {
    for (const origin of [srv.base, "http://localhost:5173", undefined]) {
      const r = await fetchJson(`${srv.base}/api/test/ping`, { method: "POST", headers: origin ? { origin } : {} });
      assert.equal(r.status, 200, `origin ${origin}`);
    }
    assert.equal((await fetchJson(`${srv.base}/api/health`, { headers: { origin: "http://evil.com" } })).status, 200);
  });
});

describe("LAN mode (bound to loopback so tests stay off the network)", () => {
  let srv: TestServer;
  let token: string;
  // A Host that is not loopback makes the request count as a remote one even from 127.0.0.1.
  const remoteHost = (extra: Record<string, string> = {}) => ({ Host: "192.168.1.5:5180", ...extra });
  before(async () => {
    srv = await startTestServer({ lan: true, extraRoutes: [postRoute] });
    assert.ok(srv.token);
    token = srv.token;
  });
  after(() => srv.close());

  test("no token is 401 JSON for the API and 401 HTML for pages", async () => {
    const api = await rawRequest(srv.base, { path: "/api/health", headers: remoteHost() });
    assert.equal(api.status, 401);
    assert.equal((JSON.parse(api.text) as ErrorResponse).code, "unauthorized");
    const page = await rawRequest(srv.base, { path: "/", headers: remoteHost() });
    assert.equal(page.status, 401);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.text, /\?token=/);
  });

  test("wrong token is 401", async () => {
    const r = await rawRequest(srv.base, { path: "/api/health", headers: remoteHost({ Authorization: "Bearer nope" }) });
    assert.equal(r.status, 401);
  });

  test("Bearer token is accepted", async () => {
    const r = await rawRequest(srv.base, { path: "/api/health", headers: remoteHost({ Authorization: `Bearer ${token}` }) });
    assert.equal(r.status, 200);
  });

  test("?token= on a page sets the cookie and redirects without the token; the cookie then works", async () => {
    const r = await rawRequest(srv.base, { path: `/some/page?token=${token}&x=1`, headers: remoteHost() });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/some/page?x=1");
    const cookie = String(r.headers["set-cookie"]);
    assert.match(cookie, new RegExp(`^dem_token=${token}; HttpOnly; SameSite=Strict; Path=/`));
    const ok = await rawRequest(srv.base, { path: "/api/health", headers: remoteHost({ Cookie: `dem_token=${token}` }) });
    assert.equal(ok.status, 200);
  });

  test("?token= does not authenticate API calls", async () => {
    const r = await rawRequest(srv.base, { path: `/api/health?token=${token}`, headers: remoteHost() });
    assert.equal(r.status, 401);
  });

  test("local user (loopback socket and loopback Host) needs no token", async () => {
    assert.equal((await fetchJson(`${srv.base}/api/health`)).status, 200);
  });

  test("GET /api/access returns the token and token URLs", async () => {
    const r = await fetchJson<AccessResponse>(`${srv.base}/api/access`);
    assert.equal(r.body.lan, true);
    assert.equal(r.body.token, token);
    assert.deepEqual(r.body.tokenUrls, r.body.lanUrls.map((u) => `${u}?token=${token}`));
  });

  test("Origin rule still applies with a valid token", async () => {
    const bad = await rawRequest(srv.base, {
      method: "POST",
      path: "/api/test/ping",
      headers: remoteHost({ Authorization: `Bearer ${token}`, Origin: "http://evil.com" }),
    });
    assert.equal(bad.status, 403);
    const good = await rawRequest(srv.base, {
      method: "POST",
      path: "/api/test/ping",
      headers: remoteHost({ Authorization: `Bearer ${token}`, Origin: "http://192.168.1.5:5180" }),
    });
    assert.equal(good.status, 200);
  });
});

test("the LAN token is generated once and reused on later starts", async () => {
  const first = await startTestServer({ lan: true });
  await first.close();
  const second = await startTestServer({ lan: true, dataDir: first.dataDir });
  try {
    assert.ok(first.token && first.token.length >= 43);
    assert.equal(second.token, first.token);
    const saved = JSON.parse(readFileSync(`${first.dataDir}/settings.json`, "utf8")) as { lanToken: string };
    assert.equal(saved.lanToken, first.token);
  } finally {
    await second.close();
  }
});

test("localhost mode never creates a token", async () => {
  const srv = await startTestServer();
  try {
    assert.equal(srv.token, null);
    assert.equal(existsSync(`${srv.dataDir}/settings.json`), false);
  } finally {
    await srv.close();
  }
});

test("safeEqual compares strings of any length", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
