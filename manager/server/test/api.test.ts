import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import { routes } from "../src/api";
import { defineRoute } from "../src/http/router";
import type { AccessResponse, ErrorResponse, HealthResponse } from "../src/types/api";
import { VERSION } from "../src/version";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

// Throwaway routes that exercise the router (they are NOT part of the real table).
const testRoutes = [
  defineRoute({
    method: "POST",
    path: "/api/test/echo",
    summary: "echo",
    tags: ["test"],
    body: Type.Object({ name: Type.String(), n: Type.Optional(Type.Integer()) }),
    response: Type.Object({ name: Type.String() }),
    handler: ({ body }) => ({ status: 201, body: { name: body.name } }),
  }),
  defineRoute({
    method: "GET",
    path: "/api/test/items/:id",
    summary: "typed params and query",
    tags: ["test"],
    params: Type.Object({ id: Type.Integer() }),
    query: Type.Object({ limit: Type.Optional(Type.Number()), flag: Type.Optional(Type.Boolean()) }),
    response: Type.Unknown(),
    handler: ({ params, query }) => ({ body: { id: params.id, idType: typeof params.id, limit: query.limit, flag: query.flag } }),
  }),
  defineRoute({
    method: "GET",
    path: "/api/test/items/special",
    summary: "literal beats :id",
    tags: ["test"],
    response: Type.Unknown(),
    handler: () => ({ body: { special: true } }),
  }),
  defineRoute({
    method: "GET",
    path: "/api/test/files/*",
    summary: "wildcard",
    tags: ["test"],
    response: Type.Unknown(),
    handler: ({ params }) => ({ body: { rest: params.wildcard } }),
  }),
  defineRoute({
    method: "GET",
    path: "/api/test/boom",
    summary: "throws",
    tags: ["test"],
    response: Type.Unknown(),
    handler: () => {
      throw new Error("secret internal detail");
    },
  }),
];

describe("server routes", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ extraRoutes: testRoutes, maxBodyBytes: 200 });
  });
  after(() => srv.close());

  test("GET /api/health", async () => {
    const r = await fetchJson<HealthResponse>(`${srv.base}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(r.body.version, VERSION);
    assert.equal(r.body.lan, false);
    assert.equal(r.body.dataDir, srv.dataDir);
    assert.equal(typeof r.body.uptime, "number");
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  });

  test("GET /api/access in localhost mode has no token", async () => {
    const r = await fetchJson<AccessResponse>(`${srv.base}/api/access`);
    assert.equal(r.status, 200);
    assert.equal(r.body.lan, false);
    assert.equal(r.body.token, null);
    assert.deepEqual(r.body.lanUrls, []);
    assert.equal(r.body.port, srv.port);
    assert.equal(r.body.localUrl, `http://localhost:${srv.port}/`);
  });

  test("unknown /api route is 404 JSON not_found", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/nope`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not_found");
    assert.equal(typeof r.body.error, "string");
  });

  test("wrong method on a known path is 405 with Allow", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/health`, { method: "POST" });
    assert.equal(r.status, 405);
    assert.equal(r.body.code, "method_not_allowed");
    assert.equal(r.headers.get("allow"), "GET");
  });

  test("invalid body is 400 invalid_body with schema errors in details", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/test/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 5 }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "invalid_body");
    assert.ok(Array.isArray(r.body.details) && r.body.details.length > 0);
    assert.equal((r.body.details as { path: string }[])[0]?.path, "/name");
  });

  test("valid body returns the handler's status and body", async () => {
    const r = await fetchJson<{ name: string }>(`${srv.base}/api/test/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { name: "x" });
  });

  test("malformed JSON is 400 invalid_json; wrong content type is 415; too large is 413", async () => {
    const post = (body: string, type = "application/json") =>
      fetchJson<ErrorResponse>(`${srv.base}/api/test/echo`, { method: "POST", headers: { "content-type": type }, body });
    assert.equal((await post("{nope")).body.code, "invalid_json");
    const wrongType = await post("{}", "text/plain");
    assert.equal(wrongType.status, 415);
    assert.equal(wrongType.body.code, "unsupported_media_type");
    const big = await post(JSON.stringify({ name: "x".repeat(500) }));
    assert.equal(big.status, 413);
    assert.equal(big.body.code, "payload_too_large");
  });

  test("path params and query are coerced per schema", async () => {
    const r = await fetchJson<{ id: number; idType: string; limit: number; flag: boolean }>(`${srv.base}/api/test/items/42?limit=2.5&flag=true`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 42, idType: "number", limit: 2.5, flag: true });
    const bad = await fetchJson<ErrorResponse>(`${srv.base}/api/test/items/abc`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_params");
    const badQuery = await fetchJson<ErrorResponse>(`${srv.base}/api/test/items/1?limit=lots`);
    assert.equal(badQuery.body.code, "invalid_query");
  });

  test("literal segments beat :params; wildcard captures the rest", async () => {
    assert.deepEqual((await fetchJson(`${srv.base}/api/test/items/special`)).body, { special: true });
    assert.deepEqual((await fetchJson(`${srv.base}/api/test/files/a/b%20c/d.txt`)).body, { rest: "a/b%20c/d.txt" });
  });

  test("handler exceptions are 500 internal_error without leaking details", async () => {
    const r = await fetchJson<ErrorResponse>(`${srv.base}/api/test/boom`);
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "internal_error");
    assert.ok(!JSON.stringify(r.body).includes("secret"));
  });
});

describe("openapi", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ extraRoutes: testRoutes });
  });
  after(() => srv.close());

  test("GET /api/openapi.json lists every route with {param} paths", async () => {
    const r = await fetchJson<{ openapi: string; info: { description: string }; paths: Record<string, Record<string, { summary: string }>>; components: { securitySchemes: Record<string, unknown> } }>(
      `${srv.base}/api/openapi.json`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.openapi, "3.1.0");
    assert.match(r.body.info.description, /\/api\/ws/);
    assert.ok(r.body.components.securitySchemes.bearerAuth);
    assert.ok(r.body.components.securitySchemes.cookieAuth);
    for (const route of [...routes, ...testRoutes]) {
      const oaPath = route.path.replace(/:(\w+)/g, "{$1}").replace(/\*$/, "{wildcard}");
      const op = r.body.paths[oaPath]?.[route.method.toLowerCase()];
      assert.ok(op, `${route.method} ${route.path} missing from OpenAPI as ${oaPath}`);
      assert.equal(op.summary, route.summary);
    }
  });

  test("the real table is not empty and has unique method+path pairs", () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    assert.ok(keys.length >= 3);
    assert.equal(new Set(keys).size, keys.length);
  });
});
