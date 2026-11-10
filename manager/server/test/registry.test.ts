import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRegistry, registryPath, type RegistryChange } from "../src/store/registry";
import { sleep, waitUntil } from "./fake/testkit";
import { tmpDataDir } from "./helpers";

const ADD = { id: "a4cf12b3c4d5", host: "192.168.1.42", hostname: "esp32-b3c4d5", name: "Workshop node", addedVia: "mdns" } as const;

test("registry: upsert/update/remove persist across a restart (flush on close)", async () => {
  const dir = tmpDataDir();
  const a = await createRegistry({ dataDir: dir, debounceMs: 5000 });
  const { created } = a.upsert(ADD);
  assert.equal(created, true);
  a.update(ADD.id, { label: "Bench", notes: "n", lastSeen: "2026-11-10T10:00:00.000Z", last: { fw: "0.1.0", attention: ["safe_mode"] } });
  a.setPinShadow(ADD.id, 4, { gpio: 4, mode: "out", invert: true });
  a.ignore("c8f09e112233");
  assert.equal(existsSync(registryPath(dir)), false, "debounce window has not elapsed");
  await a.flush();

  const raw = JSON.parse(readFileSync(registryPath(dir), "utf8"));
  assert.equal(raw.v, 1);
  assert.deepEqual(raw.ignored, ["c8f09e112233"]);

  const b = await createRegistry({ dataDir: dir });
  assert.equal(b.list().length, 1);
  assert.deepEqual(b.get(ADD.id), a.get(ADD.id));
  assert.equal(b.get(ADD.id)?.label, "Bench");
  assert.deepEqual(b.get(ADD.id)?.pinShadow, { "4": { gpio: 4, mode: "out", invert: true } });
  assert.equal(b.isIgnored("c8f09e112233"), true);
  assert.equal(b.remove(ADD.id), true);
  assert.equal(b.remove(ADD.id), false);
  await b.flush();
  assert.equal((await createRegistry({ dataDir: dir })).list().length, 0);
});

test("registry: saves are debounced to one write per window", async () => {
  const dir = tmpDataDir();
  const r = await createRegistry({ dataDir: dir, debounceMs: 150 });
  r.upsert(ADD);
  for (let i = 0; i < 10; i++) r.update(ADD.id, { notes: `n${i}` });
  await sleep(50);
  assert.equal(existsSync(registryPath(dir)), false, "nothing written inside the window");
  await waitUntil(() => existsSync(registryPath(dir)), 1500, "debounced save");
  assert.equal(JSON.parse(readFileSync(registryPath(dir), "utf8")).devices[0].notes, "n9", "later changes ride along in the same write");
  // a change after the write starts a new window
  r.update(ADD.id, { notes: "later" });
  assert.equal(JSON.parse(readFileSync(registryPath(dir), "utf8")).devices[0].notes, "n9");
  await waitUntil(() => JSON.parse(readFileSync(registryPath(dir), "utf8")).devices[0].notes === "later", 1500, "second window");
  await r.flush();
});

test("registry: writes are atomic (no temp files left) and no-op updates do not write or emit", async () => {
  const dir = tmpDataDir();
  const r = await createRegistry({ dataDir: dir, debounceMs: 10 });
  const changes: RegistryChange[] = [];
  r.onChange((c) => changes.push(c));
  r.upsert(ADD);
  r.upsert(ADD); // same values
  r.update(ADD.id, { label: "" }); // already ""
  await r.flush();
  assert.deepEqual(readdirSync(dir), ["registry.json"]);
  assert.deepEqual(
    changes.map((c) => c.kind),
    ["added"],
  );
  r.update(ADD.id, { label: "x" });
  r.remove(ADD.id);
  r.ignore("zz");
  assert.deepEqual(
    changes.map((c) => c.kind),
    ["added", "updated", "removed", "ignored"],
  );
});

test("registry: upsert of a known id updates host/hostname/name only", async () => {
  const dir = tmpDataDir();
  const r = await createRegistry({ dataDir: dir });
  r.upsert(ADD);
  r.update(ADD.id, { label: "Mine", notes: "keep" });
  const { device, created } = r.upsert({ id: ADD.id, host: "192.168.1.99", name: "Renamed", addedVia: "sweep" });
  assert.equal(created, false);
  assert.equal(device.host, "192.168.1.99");
  assert.equal(device.name, "Renamed");
  assert.equal(device.hostname, "esp32-b3c4d5");
  assert.equal(device.addedVia, "mdns");
  assert.equal(device.label, "Mine");
  assert.equal(device.notes, "keep");
});

test("registry: pin shadow set / replace / remove (disabled removes)", async () => {
  const r = await createRegistry({ dataDir: tmpDataDir() });
  r.upsert(ADD);
  r.setPinShadow(ADD.id, 4, { gpio: 4, mode: "out" });
  r.setPinShadow(ADD.id, "5", { gpio: 5, mode: "in" });
  r.setPinShadow(ADD.id, 4, { gpio: 4, mode: "pwm", hz: 1000 });
  assert.deepEqual(Object.keys(r.get(ADD.id)?.pinShadow ?? {}).sort(), ["4", "5"]);
  assert.equal(r.get(ADD.id)?.pinShadow["4"]?.mode, "pwm");
  r.setPinShadow(ADD.id, 4, { gpio: 4, mode: "disabled" });
  assert.deepEqual(Object.keys(r.get(ADD.id)?.pinShadow ?? {}), ["5"]);
  r.setPinShadow("nope", 1, { gpio: 1, mode: "out" }); // unknown device: ignored
});

test("registry: a corrupt file is set aside, never silently lost", async () => {
  const contents = ["{not json", JSON.stringify({ v: 2, devices: [], ignored: [] }), JSON.stringify({ v: 1, devices: [{ id: 5 }], ignored: [] })];
  for (const content of contents) {
    const dir = tmpDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(registryPath(dir), content);
    const logs: string[] = [];
    const r = await createRegistry({ dataDir: dir, log: (m) => logs.push(m) });
    assert.equal(r.list().length, 0);
    assert.ok(r.recoveredFrom?.includes("registry.json.corrupt-"), "reports the new name");
    assert.equal(readFileSync(r.recoveredFrom as string, "utf8"), content, "original bytes preserved");
    assert.equal(existsSync(registryPath(dir)), false);
    assert.match(logs.join("\n"), /registry\.json.*corrupt-/);
    // and it keeps working
    r.upsert(ADD);
    await r.flush();
    assert.equal(JSON.parse(readFileSync(registryPath(dir), "utf8")).devices.length, 1);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith("registry.json.corrupt-")).length, 1);
    assert.equal(path.basename(r.recoveredFrom as string).startsWith("registry.json.corrupt-"), true);
  }
});
