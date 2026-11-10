import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { rawRequest, startTestServer, tmpDataDir, type TestServer } from "./helpers";

describe("static serving", () => {
  let srv: TestServer;
  before(async () => {
    const pub = tmpDataDir();
    mkdirSync(path.join(pub, "assets"));
    writeFileSync(path.join(pub, "index.html"), "<!doctype html><title>spa</title>");
    writeFileSync(path.join(pub, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(path.join(pub, "favicon.svg"), "<svg/>");
    writeFileSync(path.join(path.dirname(pub), "outside.txt"), "secret");
    srv = await startTestServer({ publicDir: pub });
  });
  after(() => srv.close());

  test("/ serves index.html with no-cache", async () => {
    const r = await rawRequest(srv.base, { path: "/" });
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>spa<\/title>/);
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.match(String(r.headers["content-type"]), /text\/html/);
  });

  test("hashed assets get long immutable caching and the right type", async () => {
    const r = await rawRequest(srv.base, { path: "/assets/app-abc123.js" });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /javascript/);
    assert.match(String(r.headers["cache-control"]), /immutable/);
  });

  test("other files are served with their type", async () => {
    const r = await rawRequest(srv.base, { path: "/favicon.svg" });
    assert.equal(r.headers["content-type"], "image/svg+xml");
  });

  test("extension-less non-API paths fall back to index.html (SPA routes)", async () => {
    const r = await rawRequest(srv.base, { path: "/devices/a4cf12b3c4d5/live" });
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>spa<\/title>/);
  });

  test("missing files with an extension are 404; /api never falls back", async () => {
    assert.equal((await rawRequest(srv.base, { path: "/assets/missing.js" })).status, 404);
    const api = await rawRequest(srv.base, { path: "/api/missing" });
    assert.equal(api.status, 404);
    assert.match(String(api.headers["content-type"]), /json/);
  });

  test("path traversal cannot escape the public dir", async () => {
    for (const p of ["/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt"]) {
      const r = await rawRequest(srv.base, { path: p });
      assert.notEqual(r.text, "secret", p);
    }
  });
});

test("without a built web app a helpful page is served", async () => {
  const srv = await startTestServer({ publicDir: path.join(tmpDataDir(), "missing") });
  try {
    const r = await rawRequest(srv.base, { path: "/" });
    assert.equal(r.status, 503);
    assert.match(r.text, /npm run build/);
  } finally {
    await srv.close();
  }
});
