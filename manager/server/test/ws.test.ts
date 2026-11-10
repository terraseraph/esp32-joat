import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import WebSocket from "ws";
import { defineRoute } from "../src/http/router";
import type { BrowserWsMessage } from "../src/types/api";
import { VERSION } from "../src/version";
import { startTestServer, type TestServer } from "./helpers";

const broadcastRoute = defineRoute({
  method: "POST",
  path: "/api/test/broadcast",
  summary: "push a frame to every browser",
  tags: ["test"],
  response: Type.Object({ ok: Type.Boolean() }),
  handler: ({ app }) => {
    app.hub.broadcast({ t: "hello", server: { version: "broadcast", lan: false } });
    return { body: { ok: true } };
  },
});

function open(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; first: Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    // Attach before "open": the hello frame can arrive in the same tick as the upgrade.
    const first = new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
    ws.once("open", () => resolve({ ws, first }));
    ws.once("error", reject);
  });
}

describe("browser WebSocket /api/ws", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ allowOrigins: ["http://localhost:5173"], extraRoutes: [broadcastRoute] });
  });
  after(() => srv.close());
  const wsUrl = () => `ws://127.0.0.1:${srv.port}/api/ws`;

  test("sends hello on connect", async () => {
    const { ws, first } = await open(wsUrl());
    const msg = (await first) as BrowserWsMessage;
    assert.deepEqual(msg, { t: "hello", server: { version: VERSION, lan: false } });
    ws.close();
  });

  test("broadcast reaches every client; unknown and malformed messages are ignored", async () => {
    const a = await open(wsUrl());
    const b = await open(wsUrl());
    await Promise.all([a.first, b.first]);
    a.ws.send("not json");
    a.ws.send(JSON.stringify({ t: "who-knows" }));
    const next = (ws: WebSocket) => new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
    const gotA = next(a.ws);
    const gotB = next(b.ws);
    const r = await fetch(`${srv.base}/api/test/broadcast`, { method: "POST" });
    assert.equal(r.status, 200);
    const expected = { t: "hello", server: { version: "broadcast", lan: false } };
    assert.deepEqual(await gotA, expected);
    assert.deepEqual(await gotB, expected);
    a.ws.close();
    b.ws.close();
  });

  test("allow-listed Origin is accepted", async () => {
    const { ws, first } = await open(wsUrl(), { Origin: "http://localhost:5173" });
    assert.equal(((await first) as BrowserWsMessage).t, "hello");
    ws.close();
  });

  test("foreign Origin is rejected with 403", async () => {
    await assert.rejects(open(wsUrl(), { Origin: "http://evil.com" }), /403/);
  });

  test("foreign Host is rejected with 403", async () => {
    await assert.rejects(open(wsUrl(), { Host: "evil.com" }), /403/);
  });

  test("plain GET /api/ws is 426", async () => {
    const res = await fetch(`${srv.base}/api/ws`);
    assert.equal(res.status, 426);
  });
});

test("LAN mode: upgrade without a token is 401 (non-loopback Host), cookie token works", async () => {
  const srv = await startTestServer({ lan: true });
  try {
    const url = `ws://127.0.0.1:${srv.port}/api/ws`;
    const remote = { Host: "192.168.1.5:5180" };
    await assert.rejects(open(url, remote), /401/);
    const { ws, first } = await open(url, { ...remote, Cookie: `dem_token=${srv.token}` });
    assert.equal(((await first) as BrowserWsMessage).t, "hello");
    ws.close();
  } finally {
    await srv.close();
  }
});
