import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ImageError, parseImage } from "../src/firmware/image";
import { createFirmwareStore } from "../src/firmware/store";
import type { ErrorResponse } from "../src/types/api";
import type { FirmwareImage, FirmwareListResponse } from "../src/types/api-firmware";
import { makeFakeImage } from "./fake/fakeDevice";
import { tmpDataDir } from "./helpers";
import { startOtaEnv, type OtaEnv } from "./otaKit";

const fixtures = path.join(import.meta.dirname, "fixtures", "firmware");
const realHeader = readFileSync(path.join(fixtures, "real-header-512.bin"));
const realFull = path.resolve(import.meta.dirname, "..", "..", "..", "install", "firmware", "de_esp32_runtime.bin");

const reason = (buf: Buffer): string => {
  try {
    parseImage(buf);
  } catch (err) {
    assert.ok(err instanceof ImageError, String(err));
    return err.message;
  }
  throw new Error("expected the image to be refused");
};

describe("image parser", () => {
  test("the real CI image header (first 512 bytes) parses", () => {
    const p = parseImage(realHeader);
    console.log(`real header: version=${p.version} project=${p.project} date=${p.date} time=${p.time} idf=${p.idfVer} chip=${p.chip}`);
    assert.equal(p.version, "1bf09cc");
    assert.equal(p.project, "de_esp32_runtime");
    assert.equal(p.date, "Sep 24 2026");
    assert.equal(p.time, "10:32:26");
    assert.equal(p.idfVer, "v5.4.2");
    assert.equal(p.chip, "esp32");
    assert.equal(p.size, 512);
  });

  test("the whole real image parses (skipped when install/firmware is not there)", { skip: !existsSync(realFull) }, () => {
    const p = parseImage(readFileSync(realFull));
    assert.equal(p.project, "de_esp32_runtime");
    assert.match(p.version, /^[0-9a-f]{7}$/);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
  });

  test("a fake image parses with the values it was built with", () => {
    const p = parseImage(makeFakeImage({ version: "v9.9.9", date: "Jan 02 2027", time: "01:02:03", idf: "v5.5", size: 1000 }));
    assert.deepEqual([p.version, p.date, p.time, p.idfVer, p.size], ["v9.9.9", "Jan 02 2027", "01:02:03", "v5.5", 1000]);
  });

  test("every rejection has a plain reason", () => {
    assert.match(reason(Buffer.alloc(10)), /too small/);
    assert.match(reason(makeFakeImage({ firstByte: 0x7f })), /0xE9/);
    const otherChip = makeFakeImage();
    otherChip.writeUInt16LE(5, 12);
    assert.match(reason(otherChip), /different chip/);
    assert.match(reason(makeFakeImage({ descMagic: 1 })), /application header/);
    assert.match(reason(makeFakeImage({ project: "other_project" })), /other_project/);
    assert.match(reason(makeFakeImage({ version: "" })), /no version/);
    assert.match(reason(Buffer.alloc(4 * 1024 * 1024 + 1, 0xe9)), /MB/);
    // truncated to inside the header
    assert.match(reason(makeFakeImage().subarray(0, 100)), /too small/);
  });
});

describe("firmware store", () => {
  test("dedupes by sha256, survives a restart, deletes the file", async () => {
    const dir = tmpDataDir();
    const store = await createFirmwareStore(dir);
    const buf = makeFakeImage({ version: "aaaaaaa" });
    const a = await store.add(buf, "..\\evil/name.bin", "upload");
    assert.equal(a.created, true);
    assert.equal(a.image.filename, "name.bin");
    const b = await store.add(Buffer.from(buf), "other.bin", "upload");
    assert.equal(b.created, false);
    assert.equal(b.image.id, a.image.id);
    await store.add(makeFakeImage({ version: "bbbbbbb" }), "b.bin", "latest");
    assert.equal(store.list().length, 2);

    const again = await createFirmwareStore(dir);
    assert.equal(again.list().length, 2);
    assert.equal(again.get(a.image.id)?.version, "aaaaaaa");
    assert.ok(existsSync(again.filePath(a.image.id)));
    assert.equal(await again.remove(a.image.id), true);
    assert.equal(await again.remove(a.image.id), false);
    assert.equal(existsSync(path.join(dir, "firmware", `${a.image.id}.bin`)), false);
    assert.equal((await createFirmwareStore(dir)).list().length, 1);
    assert.deepEqual(readdirSync(path.join(dir, "firmware")).filter((f) => f.endsWith(".tmp")), []);
  });

  test("a refused image is not stored", async () => {
    const store = await createFirmwareStore(tmpDataDir());
    await assert.rejects(store.add(Buffer.alloc(400), "x.bin", "upload"), ImageError);
    assert.equal(store.list().length, 0);
  });
});

describe("firmware API: library, latest, target", () => {
  let env: OtaEnv;
  let fetchCalls: string[] = [];
  let fetchImpl: (url: string) => Promise<Response> = () => Promise.reject(new Error("no stub"));

  before(async () => {
    env = await startOtaEnv({
      firmware: {
        fetch: ((url: string | URL | Request) => {
          fetchCalls.push(String(url));
          return fetchImpl(String(url));
        }) as typeof fetch,
      },
    });
  });
  after(() => env.close());

  test("upload: 201, same file again 200, listed", async () => {
    const buf = makeFakeImage({ version: "1111111", size: 5000 });
    const r1 = await env.upload(buf, "one.bin");
    assert.equal(r1.status, 201);
    assert.equal(r1.body.version, "1111111");
    assert.equal(r1.body.source, "upload");
    assert.equal(r1.body.size, 5000);
    assert.equal(r1.body.chip, "esp32");
    const r2 = await env.upload(buf, "again.bin");
    assert.equal(r2.status, 200);
    assert.equal(r2.body.id, r1.body.id);
    const list = (await env.send<FirmwareListResponse>("GET", "/api/firmware")).body;
    assert.equal(list.images.length, 1);
    assert.equal(list.targetId, null);
    assert.equal(list.latest.baseUrl, "https://terraseraph.github.io/esp32-joat/");
    assert.equal(list.latest.checkedAt, null);
  });

  test("upload refusals are 422 invalid_image with a reason; the real header alone is too small to be accepted", async () => {
    for (const buf of [Buffer.alloc(100), makeFakeImage({ firstByte: 0 }), makeFakeImage({ project: "nope" })]) {
      const r = await env.upload(buf);
      assert.equal(r.status, 422);
      const body = r.body as unknown as ErrorResponse;
      assert.equal(body.code, "invalid_image");
      assert.ok(body.error.length > 10);
    }
    const big = await env.upload(Buffer.alloc(4 * 1024 * 1024 + 10));
    assert.equal(big.status, 422);
    assert.equal(((big.body as unknown as ErrorResponse).code), "invalid_image");
  });

  test("the real image is accepted when it exists", { skip: !existsSync(realFull) }, async () => {
    const r = await env.upload(readFileSync(realFull), "de_esp32_runtime.bin");
    assert.ok(r.status === 201 || r.status === 200);
    assert.equal(r.body.project, "de_esp32_runtime");
    await env.send("DELETE", `/api/firmware/${r.body.id}`);
  });

  test("get latest: fetches <baseUrl>/firmware/de_esp32_runtime.bin from the stub, records the outcome, dedupes", async () => {
    const put = await env.send<{ firmwareBaseUrl: string }>("PUT", "/api/settings", { firmwareBaseUrl: "http://pages.test/esp32-joat" });
    assert.equal(put.body.firmwareBaseUrl, "http://pages.test/esp32-joat/");
    const img = makeFakeImage({ version: "2222222", size: 4000 });
    fetchCalls = [];
    fetchImpl = async () => new Response(new Uint8Array(img), { status: 200 });
    const r1 = await env.send<FirmwareImage>("POST", "/api/firmware/latest");
    assert.equal(r1.status, 201);
    assert.equal(r1.body.source, "latest");
    assert.deepEqual(fetchCalls, ["http://pages.test/esp32-joat/firmware/de_esp32_runtime.bin"]);
    const r2 = await env.send<FirmwareImage>("POST", "/api/firmware/latest");
    assert.equal(r2.status, 200);
    const list = (await env.send<FirmwareListResponse>("GET", "/api/firmware")).body;
    assert.equal(list.latest.imageId, r1.body.id);
    assert.equal(list.latest.error, null);
    assert.ok(list.latest.checkedAt);
    assert.equal(list.latest.baseUrl, "http://pages.test/esp32-joat/");
  });

  test("get latest failures: HTTP 404, network error, not an image, too big", async () => {
    fetchImpl = async () => new Response("nope", { status: 404 });
    let r = await env.send<ErrorResponse>("POST", "/api/firmware/latest");
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "fetch_failed");
    assert.match(r.body.error, /404/);
    let list = (await env.send<FirmwareListResponse>("GET", "/api/firmware")).body;
    assert.match(list.latest.error ?? "", /404/);

    fetchImpl = () => Promise.reject(new TypeError("fetch failed"));
    r = await env.send<ErrorResponse>("POST", "/api/firmware/latest");
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Could not reach/);

    fetchImpl = async () => new Response("<html>not firmware</html>".repeat(40), { status: 200 });
    r = await env.send<ErrorResponse>("POST", "/api/firmware/latest");
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "invalid_image");
    list = (await env.send<FirmwareListResponse>("GET", "/api/firmware")).body;
    assert.match(list.latest.error ?? "", /not a usable firmware image/);

    fetchImpl = async () => new Response(new Uint8Array(5 * 1024 * 1024), { status: 200 });
    r = await env.send<ErrorResponse>("POST", "/api/firmware/latest");
    assert.equal(r.status, 502);
    assert.match(r.body.error, /larger than/);
  });

  test("the Pages URL setting is validated", async () => {
    const bad = await env.send<ErrorResponse>("PUT", "/api/settings", { firmwareBaseUrl: "not a url" });
    assert.equal(bad.status, 400);
    const ftp = await env.send<ErrorResponse>("PUT", "/api/settings", { firmwareBaseUrl: "ftp://x.test/" });
    assert.equal(ftp.status, 400);
  });

  test("target: drives fwMatchesTarget (true / false / null) and is cleared by delete", async () => {
    const dev = await env.fake({ appVersion: "3333333" });
    const added = await env.addDevice(dev);
    assert.equal(added.fwMatchesTarget, null, "no target yet");
    // the fake runs 3333333 built Nov 10 2026 09:12:44 (its defaults)
    const same = (await env.upload(makeFakeImage({ version: "3333333", size: 3000 }))).body;
    const other = (await env.upload(makeFakeImage({ version: "4444444", size: 3000 }))).body;
    const sameVersionOtherBuild = (await env.upload(makeFakeImage({ version: "3333333", time: "23:59:59", size: 3000 }))).body;

    let r = await env.send<FirmwareListResponse>("PUT", "/api/firmware/target", { firmwareId: same.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.targetId, same.id);
    assert.equal((await env.summary(dev.id)).fwMatchesTarget, true);

    await env.send("PUT", "/api/firmware/target", { firmwareId: other.id });
    assert.equal((await env.summary(dev.id)).fwMatchesTarget, false);
    await env.send("PUT", "/api/firmware/target", { firmwareId: sameVersionOtherBuild.id });
    assert.equal((await env.summary(dev.id)).fwMatchesTarget, false, "same version but another build time");

    r = await env.send<FirmwareListResponse>("PUT", "/api/firmware/target", { firmwareId: null });
    assert.equal(r.body.targetId, null);
    assert.equal((await env.summary(dev.id)).fwMatchesTarget, null);

    const missing = await env.send<ErrorResponse>("PUT", "/api/firmware/target", { firmwareId: "f".repeat(64) });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "unknown_image");

    await env.send("PUT", "/api/firmware/target", { firmwareId: other.id });
    assert.equal((await env.send("DELETE", `/api/firmware/${other.id}`)).status, 204);
    const list = (await env.send<FirmwareListResponse>("GET", "/api/firmware")).body;
    assert.equal(list.targetId, null);
    assert.equal(list.images.some((i) => i.id === other.id), false);
    assert.equal((await env.summary(dev.id)).fwMatchesTarget, null);
  });

  test("delete: 404 for an unknown image", async () => {
    const r = await env.send<ErrorResponse>("DELETE", `/api/firmware/${"a".repeat(64)}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "unknown_image");
  });
});
