import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import { toggleStatus } from "../src/http/access";
import type { AccessResponse, BrowserWsMessage, ErrorResponse, HealthResponse } from "../src/types/api";
import { fetchJson, rawRequest, startTestServer, type TestServer } from "./helpers";

/**
 * Runtime LAN switch. Everything stays on loopback: "LAN" binds 127.0.0.2 (StartOptions.lanBindHost) and a
 * non-loopback Host header makes a request count as remote.
 */
const NO_SCAN = { networkScan: false, discovery: { mdns: false as const, interfaces: () => [] } };
const LAN_OPTS = { lanBindHost: "127.0.0.2", lanAddresses: () => ["192.168.1.20"], ...NO_SCAN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: TestServer[] = [];
async function boot(opts: Parameters<typeof startTestServer>[0] = {}): Promise<{ srv: TestServer; logs: string[] }> {
  const logs: string[] = [];
  const srv = await startTestServer({ ...LAN_OPTS, ...opts, log: (m) => logs.push(m) });
  servers.push(srv);
  return { srv, logs };
}
after(async () => {
  for (const s of servers) await s.close().catch(() => undefined);
});

const at = (host: string, port: number) => `http://${host}:${port}`;
const remoteHeaders = (port: number, extra: Record<string, string> = {}) => ({ Host: `192.168.1.5:${port}`, ...extra });
const json = { "Content-Type": "application/json" };

function wsOpen(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; messages: BrowserWsMessage[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages: BrowserWsMessage[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString()) as BrowserWsMessage));
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    ws.once("open", () => resolve({ ws, messages, closed }));
    ws.once("error", reject);
  });
}

/** One keep-alive request through a shared agent; reports whether it reused the socket. */
function keepAliveGet(agent: http.Agent, host: string, port: number, headers: Record<string, string> = {}): Promise<{ status: number; reused: boolean; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: "/api/health", agent, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket, socket: req.socket as net.Socket }));
    });
    req.on("error", reject);
    req.end();
  });
}

const connectRefused = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });

async function put(srv: { port: number }, host: string, enabled: unknown, headers: Record<string, string> = {}) {
  return fetchJson<AccessResponse & ErrorResponse>(`${at(host, srv.port)}/api/access`, { method: "PUT", headers: { ...json, ...headers }, body: JSON.stringify({ enabled }) });
}

function savedSettings(dir: string): { lanEnabled?: boolean; lanToken?: string } | null {
  try {
    return JSON.parse(readFileSync(`${dir}/settings.json`, "utf8")) as { lanEnabled?: boolean; lanToken?: string };
  } catch {
    return null;
  }
}

describe("switching LAN access at runtime", () => {
  test("off to on to off: re-binds the same port, token created on first enable, keep-alive and local sockets survive, remote ones are cut", async () => {
    const { srv, logs } = await boot();
    const port = srv.port;
    assert.equal(srv.token, null);
    const before = await fetchJson<AccessResponse>(`${srv.base}/api/access`);
    assert.equal(before.body.lan, false);
    assert.equal(before.body.token, null);
    assert.equal(before.body.tokenMasked, null);
    assert.equal(before.body.openUrl, null);
    assert.equal(before.body.toggleAvailable, true);
    assert.equal(before.body.toggleUnavailableReason, null);
    assert.equal(before.body.remote, false);
    assert.equal(savedSettings(srv.dataDir), null, "no token or settings file in localhost mode");

    // A keep-alive loopback connection and a loopback browser socket, both opened while LAN access is off.
    const agent = new http.Agent({ keepAlive: true });
    assert.equal((await keepAliveGet(agent, "127.0.0.1", port)).status, 200);
    const local = await wsOpen(`ws://127.0.0.1:${port}/api/ws`);

    // ---- on -------------------------------------------------------------------------------------------------------
    const on = await put(srv, "127.0.0.1", true);
    assert.equal(on.status, 200);
    assert.equal(on.body.lan, true);
    assert.equal(on.body.host, "127.0.0.2");
    assert.equal(on.body.port, port);
    const token = on.body.token as string;
    assert.ok(token && token.length >= 43);
    assert.ok(on.body.tokenMasked?.endsWith(token.slice(-4)) && !on.body.tokenMasked.includes(token.slice(0, -4)));
    assert.deepEqual(on.body.lanUrls, [`http://192.168.1.20:${port}/`]);
    assert.equal(on.body.openUrl, `http://192.168.1.20:${port}/?token=${token}`);
    assert.equal(await connectRefused("127.0.0.1", port), true, "the listener moved to the LAN address");
    // The idle keep-alive connection from before the switch is still usable.
    const again = await keepAliveGet(agent, "127.0.0.1", port);
    assert.equal(again.status, 200);
    assert.equal(again.reused, true, "same socket across the switch");
    // Live state is reflected everywhere.
    const health = await fetchJson<HealthResponse>(`${at("127.0.0.2", port)}/api/health`);
    assert.equal(health.body.lan, true);
    // Local user keeps working without a token; a remote one needs it.
    assert.equal((await rawRequest(at("127.0.0.2", port), { path: "/api/health" })).status, 200);
    assert.equal((await rawRequest(at("127.0.0.2", port), { path: "/api/health", headers: remoteHeaders(port) })).status, 401);
    assert.equal((await rawRequest(at("127.0.0.2", port), { path: "/api/health", headers: remoteHeaders(port, { Authorization: `Bearer ${token}` }) })).status, 200);
    // Persisted.
    const saved = savedSettings(srv.dataDir);
    assert.equal(saved?.lanEnabled, true);
    assert.equal(saved?.lanToken, token);
    // On again is a no-op.
    assert.equal((await put(srv, "127.0.0.2", true)).body.token, token);

    // A remote browser (token in a cookie), a remote keep-alive client, and a local WebSocket on the new address.
    const remoteWs = await wsOpen(`ws://127.0.0.2:${port}/api/ws`, remoteHeaders(port, { Cookie: `dem_token=${token}` }));
    const remoteAgent = new http.Agent({ keepAlive: true });
    const remoteConn = await keepAliveGet(remoteAgent, "127.0.0.2", port, remoteHeaders(port, { Authorization: `Bearer ${token}` }));
    const remoteSocketClosed = new Promise<void>((res) => remoteConn.socket.once("close", () => res()));
    const local2 = await wsOpen(`ws://127.0.0.2:${port}/api/ws`);
    await sleep(50);
    const hello = local2.messages.find((m) => m.t === "hello") as { server: { lan: boolean } } | undefined;
    assert.equal(hello?.server.lan, true, "hub hello follows the live state");

    // ---- off ------------------------------------------------------------------------------------------------------
    const off = await put(srv, "127.0.0.2", false);
    assert.equal(off.status, 200);
    assert.equal(off.body.lan, false);
    assert.equal(off.body.host, "127.0.0.1");
    assert.equal(off.body.token, null);
    assert.equal(await remoteWs.closed, 4001, "remote browser socket closed");
    await remoteSocketClosed; // remote HTTP socket destroyed
    assert.equal(await connectRefused("127.0.0.2", port), true);
    assert.equal(await connectRefused("127.0.0.1", port), false);
    // Local sockets stay: the keep-alive one and both browser sockets.
    assert.equal(local.ws.readyState, WebSocket.OPEN);
    assert.equal(local2.ws.readyState, WebSocket.OPEN);
    assert.equal((await keepAliveGet(agent, "127.0.0.1", port)).status, 200);
    // Local WS clients are told, and never see a token.
    await sleep(50);
    assert.ok(local.messages.some((m) => m.t === "access" && m.lan === false));
    assert.ok(!JSON.stringify(local.messages).includes(token));
    // Remote requests are refused by Host now.
    const refused = await rawRequest(srv.base, { path: "/api/health", headers: remoteHeaders(port, { Authorization: `Bearer ${token}` }) });
    assert.equal(refused.status, 403);
    const saved2 = savedSettings(srv.dataDir);
    assert.equal(saved2?.lanEnabled, false);
    assert.equal(saved2?.lanToken, token, "the token is kept so the old links work again when LAN access is switched back on");

    // ---- on again keeps the same token ------------------------------------------------------------------------------
    const on2 = await put(srv, "127.0.0.1", true);
    assert.equal(on2.body.token, token);

    local.ws.close();
    local2.ws.close();
    agent.destroy();
    remoteAgent.destroy();
    // The token never appears in a log line; enabling and disabling are logged.
    const joined = logs.join("\n");
    assert.ok(!joined.includes(token));
    assert.match(joined, /LAN access switched on/);
    assert.match(joined, /LAN access switched off/);
  });

  test("a remote caller can switch LAN off: it gets the answer, then loses its connection", async () => {
    const { srv } = await boot({ lan: true });
    assert.ok(srv.token);
    const agent = new http.Agent({ keepAlive: true });
    const first = await keepAliveGet(agent, "127.0.0.1", srv.port, remoteHeaders(srv.port, { Authorization: `Bearer ${srv.token}` }));
    const closed = new Promise<void>((res) => first.socket.once("close", () => res()));
    // (fetch cannot set Host, so the remote caller is a raw request)
    const r = await rawRequest(srv.base, {
      method: "PUT",
      path: "/api/access",
      headers: { ...json, ...remoteHeaders(srv.port, { Authorization: `Bearer ${srv.token}` }) },
      body: JSON.stringify({ enabled: false }),
    });
    const body = JSON.parse(r.text) as AccessResponse;
    assert.equal(r.status, 200);
    assert.equal(body.lan, false);
    assert.equal(body.remote, true);
    await closed;
    agent.destroy();
  });

  test("when the new address cannot be bound the old one keeps serving and the error is 409 rebind_failed", async () => {
    const { srv } = await boot();
    const blocker = net.createServer();
    await new Promise<void>((res) => blocker.listen(srv.port, "127.0.0.2", res));
    try {
      const r = await put(srv, "127.0.0.1", true);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "rebind_failed");
      assert.match(r.body.error, /127\.0\.0\.2/);
      const access = await fetchJson<AccessResponse>(`${srv.base}/api/access`);
      assert.equal(access.body.lan, false, "still off");
      assert.equal(access.body.host, "127.0.0.1");
      assert.equal(access.body.token, null);
      // Still not open to the network.
      assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remoteHeaders(srv.port) })).status, 403);
      assert.notEqual(savedSettings(srv.dataDir)?.lanEnabled, true);
    } finally {
      await new Promise((res) => blocker.close(res));
    }
    // After the blocker is gone the switch works.
    assert.equal((await put(srv, "127.0.0.1", true)).status, 200);
  });

  test("the choice is saved: the next start comes up in LAN mode (and CLI --lan still wins when the setting is off)", async () => {
    const { srv } = await boot();
    assert.equal((await put(srv, "127.0.0.1", true)).status, 200);
    const token = (await fetchJson<AccessResponse>(`${at("127.0.0.2", srv.port)}/api/access`)).body.token;
    await srv.close();
    const next = await startTestServer({ ...LAN_OPTS, dataDir: srv.dataDir });
    servers.push(next);
    assert.equal(next.host, "127.0.0.2");
    assert.equal(next.lan, true);
    assert.equal(next.token, token);
    await put(next, "127.0.0.2", false);
    await next.close();
    const third = await startTestServer({ ...LAN_OPTS, dataDir: srv.dataDir });
    servers.push(third);
    assert.equal(third.lan, false);
    assert.equal(third.token, null);
    await third.close();
    const forced = await startTestServer({ ...LAN_OPTS, lan: true, dataDir: srv.dataDir });
    servers.push(forced);
    assert.equal(forced.lan, true);
    assert.equal(forced.token, token);
  });

  test("not available: the desktop app (lanToggle false) ignores a saved switch and answers 409 lan_unavailable", async () => {
    const first = await boot();
    const dir = first.srv.dataDir;
    await first.srv.close();
    writeFileSync(`${dir}/settings.json`, JSON.stringify({ lanEnabled: true, lanToken: "x".repeat(43) }));
    const { srv } = await boot({ lanToggle: false, dataDir: dir });
    assert.equal(srv.lan, false, "a copied settings file must not open the desktop app to the network");
    const a = await fetchJson<AccessResponse>(`${srv.base}/api/access`);
    assert.equal(a.body.toggleAvailable, false);
    assert.match(a.body.toggleUnavailableReason ?? "", /desktop app/);
    const r = await put(srv, "127.0.0.1", true);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "lan_unavailable");
    assert.match(r.body.error, /desktop app/);
    assert.equal((await fetchJson(`${srv.base}/api/access/token`, { method: "POST" })).status, 409);
  });

  test("toggleStatus: loopback and wildcard hosts can switch, a fixed address cannot", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]) assert.equal(toggleStatus({ host }).available, true, host);
    const fixed = toggleStatus({ host: "192.168.1.20" });
    assert.equal(fixed.available, false);
    assert.match(fixed.reason ?? "", /--host 192\.168\.1\.20/);
    assert.equal(toggleStatus({ host: "127.0.0.1", lanToggle: false }).available, false);
  });

  test("PUT /api/access validates its body", async () => {
    const { srv } = await boot();
    const r = await put(srv, "127.0.0.1", "yes");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "invalid_body");
  });

  test("remote callers are refused before the handler runs: no token, no access info", async () => {
    const { srv } = await boot({ lan: true });
    for (const [method, path] of [
      ["GET", "/api/access"],
      ["PUT", "/api/access"],
      ["POST", "/api/access/token"],
    ] as const) {
      const r = await rawRequest(srv.base, { method, path, headers: { ...remoteHeaders(srv.port), ...json }, body: method === "PUT" ? '{"enabled":false}' : undefined });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.ok(!r.text.includes(srv.token as string));
    }
  });
});

describe("regenerating the token", () => {
  test("old Bearer and cookie stop working, remote sockets are closed, a remote caller gets the new cookie, a local caller none", async () => {
    const { srv, logs } = await boot({ lan: true });
    const old = srv.token as string;
    const remote = (t: string, extra: Record<string, string> = {}) => remoteHeaders(srv.port, { Authorization: `Bearer ${t}`, ...extra });
    const ws1 = await wsOpen(`ws://127.0.0.1:${srv.port}/api/ws`, remoteHeaders(srv.port, { Cookie: `dem_token=${old}` }));
    const localWs = await wsOpen(`ws://127.0.0.1:${srv.port}/api/ws`);

    // Remote caller.
    const r = await rawRequest(srv.base, { method: "POST", path: "/api/access/token", headers: remote(old) });
    assert.equal(r.status, 200);
    const rb = JSON.parse(r.text) as AccessResponse;
    const fresh = rb.token as string;
    assert.notEqual(fresh, old);
    assert.equal(rb.remote, true);
    const cookie = String(r.headers["set-cookie"] ?? "");
    assert.ok(cookie.includes(`dem_token=${fresh}`));
    assert.match(cookie, /HttpOnly/);
    assert.equal(await ws1.closed, 4001);
    assert.equal(localWs.ws.readyState, WebSocket.OPEN, "local sockets are not touched");
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remote(old) })).status, 401);
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remoteHeaders(srv.port, { Cookie: `dem_token=${old}` }) })).status, 401);
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remote(fresh) })).status, 200);
    assert.equal((await rawRequest(srv.base, { path: "/api/health", headers: remoteHeaders(srv.port, { Cookie: `dem_token=${fresh}` }) })).status, 200);
    // Persisted.
    assert.equal(savedSettings(srv.dataDir)?.lanToken, fresh);

    // Local caller: new token, no cookie.
    const l = await fetchJson<AccessResponse>(`${srv.base}/api/access/token`, { method: "POST" });
    assert.equal(l.status, 200);
    assert.equal(l.body.remote, false);
    assert.equal(l.headers.get("set-cookie"), null);
    assert.notEqual(l.body.token, fresh);
    localWs.ws.close();
    const joined = logs.join("\n");
    assert.match(joined, /token regenerated/);
    for (const t of [old, fresh, l.body.token as string]) assert.ok(!joined.includes(t));
  });

  test("409 lan_disabled while LAN access is off", async () => {
    const { srv } = await boot();
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/access/token`, { method: "POST" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "lan_disabled");
  });
});
