import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import WebSocket from "ws";
import { defineRoute } from "../src/http/router";
import { createSecurity, TOKEN_COOKIE_MAX_AGE_S } from "../src/http/security";
import type { ErrorResponse } from "../src/types/api";
import { fetchJson, rawRequest, startTestServer, type TestServer } from "./helpers";

const NO_SCAN = { networkScan: false, discovery: { mdns: false as const, interfaces: () => [] } };
const remoteHost = (port: number, extra: Record<string, string> = {}) => ({ Host: `192.168.1.5:${port}`, ...extra });

const boomRoute = defineRoute({
  method: "GET",
  path: "/api/test/boom",
  summary: "always fails",
  tags: ["test"],
  response: Type.Object({ ok: Type.Boolean() }),
  handler: () => {
    throw new Error("boom");
  },
});

function wsOpen(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rate limit on wrong tokens (LAN mode)", () => {
  let srv: TestServer;
  let token: string;
  before(async () => {
    srv = await startTestServer({ lan: true, ...NO_SCAN, rateLimit: { maxAttempts: 3, windowMs: 500 } });
    assert.ok(srv.token);
    token = srv.token;
  });
  after(() => srv.close());
  const get = (headers: Record<string, string>, path = "/api/health") => rawRequest(srv.base, { path, headers: remoteHost(srv.port, headers) });

  test("more than 3 wrong tokens in the window is 429 too_many_attempts with Retry-After, for HTTP and WebSocket; a missing token is not counted", async () => {
    // No token at all: always the ordinary 401, however often (not counted).
    for (let i = 0; i < 6; i++) assert.equal((await get({})).status, 401);
    // Wrong tokens (Bearer, cookie, query) are counted.
    assert.equal((await get({ Authorization: "Bearer nope" })).status, 401);
    assert.equal((await get({ Cookie: "dem_token=nope" })).status, 401);
    assert.equal((await get({}, "/?token=nope")).status, 401);
    const blocked = await get({ Authorization: "Bearer nope" });
    assert.equal(blocked.status, 429);
    assert.equal((JSON.parse(blocked.text) as ErrorResponse).code, "too_many_attempts");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    // Even the right token waits while the address is blocked: otherwise guessing would never slow down.
    assert.equal((await get({ Authorization: `Bearer ${token}` })).status, 429);
    // No token still gets the normal 401 page.
    assert.equal((await get({})).status, 401);
    // WebSocket upgrade is limited too.
    await assert.rejects(wsOpen(`ws://127.0.0.1:${srv.port}/api/ws`, remoteHost(srv.port, { Authorization: `Bearer ${token}` })), /429/);
    // The local user is never limited.
    assert.equal((await fetchJson(`${srv.base}/api/health`)).status, 200);
    // After the window the right token works again.
    await sleep(600);
    assert.equal((await get({ Authorization: `Bearer ${token}` })).status, 200);
  });
});

describe("limiter unit (fake clock, bounded table)", () => {
  function fakeReq(addr: string, headers: Record<string, string>, url = "/api/health", method = "GET"): IncomingMessage {
    return { headers: { host: "192.168.1.5:5180", ...headers }, socket: { remoteAddress: addr }, url, method } as unknown as IncomingMessage;
  }

  test("window expiry and the cap on remembered addresses", () => {
    let t = 1000;
    const sec = createSecurity({ lan: true, token: "right", allowOrigins: [], getPort: () => 5180, rateLimit: { maxAttempts: 2, windowMs: 1000, maxTracked: 3 }, now: () => t });
    const bad = (addr: string) => sec.check(fakeReq(addr, { authorization: "Bearer wrong" }), "http");
    assert.equal(bad("10.0.0.1").kind, "deny");
    assert.equal(bad("10.0.0.1").kind, "deny");
    const third = bad("10.0.0.1");
    assert.equal(third.kind === "deny" && third.status, 429);
    t += 1001;
    const after = bad("10.0.0.1");
    assert.equal(after.kind === "deny" && after.status, 401, "window passed");
    // Fill the table with other addresses: the oldest entry is dropped, so memory stays bounded.
    bad("10.0.0.1");
    for (const a of ["10.0.0.2", "10.0.0.3", "10.0.0.4"]) {
      bad(a);
      bad(a);
    }
    const evicted = bad("10.0.0.1");
    assert.equal(evicted.kind === "deny" && evicted.status, 401, "oldest address was forgotten (cap 3)");
    const kept = bad("10.0.0.4");
    assert.equal(kept.kind === "deny" && kept.status, 429);
  });

  test("a loopback socket with a loopback Host is never limited or asked for a token", () => {
    const sec = createSecurity({ lan: true, token: "right", allowOrigins: [], getPort: () => 5180, rateLimit: { maxAttempts: 1, windowMs: 1000 } });
    for (let i = 0; i < 5; i++) {
      const r = { headers: { host: "localhost:5180", authorization: "Bearer wrong" }, socket: { remoteAddress: "::1" }, url: "/api/health", method: "GET" } as unknown as IncomingMessage;
      assert.equal(sec.check(r, "http").kind, "allow");
    }
  });

  test("LAN mode without a token refuses every non-local request (fails closed) and isTrusted reflects the live token", () => {
    const sec = createSecurity({ lan: true, token: null, allowOrigins: [], getPort: () => 5180 });
    const remote = fakeReq("192.168.1.9", { authorization: "Bearer anything" });
    const d = sec.check(remote, "http");
    assert.equal(d.kind === "deny" && d.status, 401);
    assert.equal(sec.isTrusted(remote), false);
    sec.setToken("t1");
    assert.equal(sec.isTrusted(fakeReq("192.168.1.9", { authorization: "Bearer t1" })), true);
    assert.equal(sec.isTrusted(fakeReq("192.168.1.9", { cookie: "dem_token=t1" })), true);
    sec.setToken("t2");
    assert.equal(sec.isTrusted(fakeReq("192.168.1.9", { cookie: "dem_token=t1" })), false, "an old cookie stops working at once");
    // Header-only tokens of any length are compared without throwing.
    assert.equal(sec.isTrusted(fakeReq("192.168.1.9", { authorization: `Bearer ${"x".repeat(5000)}` })), false);
  });
});

describe("token handling in LAN mode", () => {
  let srv: TestServer;
  let token: string;
  const logs: string[] = [];
  before(async () => {
    srv = await startTestServer({ lan: true, ...NO_SCAN, extraRoutes: [boomRoute], log: (m) => logs.push(m) });
    assert.ok(srv.token);
    token = srv.token;
  });
  after(() => srv.close());
  const remote = (headers: Record<string, string> = {}) => remoteHost(srv.port, headers);

  test("?token= on a page is exchanged for a cookie (HttpOnly, SameSite=Strict, Path=/, Max-Age, no Secure) and stripped; other query params stay", async () => {
    const r = await rawRequest(srv.base, { path: `/devices?a=1&token=${token}&b=two`, headers: remote() });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/devices?a=1&b=two");
    const cookie = String(r.headers["set-cookie"]);
    assert.ok(cookie.includes(`dem_token=${token}`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.ok(cookie.includes(`Max-Age=${TOKEN_COOKIE_MAX_AGE_S}`));
    assert.doesNotMatch(cookie, /Secure/i);
    assert.doesNotMatch(String(r.headers.location), /token/);
  });

  test("a valid ?token= is not auth on /api (GET or POST) nor on the WebSocket path", async () => {
    assert.equal((await rawRequest(srv.base, { path: `/api/health?token=${token}`, headers: remote() })).status, 401);
    assert.equal((await rawRequest(srv.base, { method: "POST", path: `/api/discovery/cancel?token=${token}`, headers: remote() })).status, 401);
    await assert.rejects(wsOpen(`ws://127.0.0.1:${srv.port}/api/ws?token=${token}`, remote()), /401/);
  });

  test("a ?token= on a non-GET page request is not exchanged", async () => {
    const r = await rawRequest(srv.base, { method: "POST", path: `/x?token=${token}`, headers: remote() });
    assert.equal(r.status, 401);
  });

  test("WebSocket upgrade: no or bad token 401, cookie and Bearer work, Origin rule still applies", async () => {
    const url = `ws://127.0.0.1:${srv.port}/api/ws`;
    await assert.rejects(wsOpen(url, remote()), /401/);
    await assert.rejects(wsOpen(url, remote({ Authorization: "Bearer wrong" })), /401/);
    await assert.rejects(wsOpen(url, remote({ Cookie: "dem_token=wrong" })), /401/);
    (await wsOpen(url, remote({ Cookie: `dem_token=${token}` }))).close();
    (await wsOpen(url, remote({ Authorization: `Bearer ${token}` }))).close();
    await assert.rejects(wsOpen(url, remote({ Authorization: `Bearer ${token}`, Origin: "http://evil.example" })), /403/);
    await assert.rejects(wsOpen(url, remote({ Authorization: `Bearer ${token}`, Origin: "null" })), /403/);
    (await wsOpen(url, remote({ Authorization: `Bearer ${token}`, Origin: `http://192.168.1.5:${srv.port}` }))).close();
  });

  test("a foreign Host on a loopback socket is not the local user (the exemption needs loopback socket AND loopback Host)", async () => {
    // Loopback socket but a foreign Host: needs the token.
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remote() })).status, 401);
    // DNS rebinding shape: evil name, with a victim cookie it still cannot be the local user, and without it is refused.
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: { Host: `evil.example:${srv.port}` } })).status, 401);
  });

  test("a failing handler is logged with its path only: the token never reaches the log", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/test/boom?token=${token}&x=1`);
    assert.equal(r.status, 500);
    const joined = logs.join("\n");
    assert.match(joined, /internal error on GET \/api\/test\/boom:/);
    assert.ok(!joined.includes(token), "token leaked into the log");
    assert.ok(!joined.includes("token="), "query string leaked into the log");
  });
});

describe("Host and Origin rules", () => {
  test("localhost mode: Origin null and foreign origins on mutating requests and upgrades are 403; GET is not Origin-checked", async () => {
    const srv = await startTestServer({ ...NO_SCAN });
    try {
      const post = (origin: string) => rawRequest(srv.base, { method: "POST", path: "/api/discovery/cancel", headers: { Origin: origin, Host: `127.0.0.1:${srv.port}` } });
      assert.equal((await post("null")).status, 403);
      assert.equal((await post("http://evil.example")).status, 403);
      assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: { Origin: "null" } })).status, 200);
      await assert.rejects(wsOpen(`ws://127.0.0.1:${srv.port}/api/ws`, { Origin: "null" }), /403/);
    } finally {
      await srv.close();
    }
  });
});
