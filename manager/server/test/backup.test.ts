import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { BackupFile, BackupMeta, BackupPlan, ErrorResponse, Job } from "../src/types/api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, cmd, fetchPins, result, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const send = <T = unknown>(method: string, url: string, body?: unknown) =>
  fetchJson<T>(url, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

let counter = 0;
const nextId = (): string => (0xb4c0de000000 + ++counter).toString(16);

describe("backups", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const api = (p: string): string => `${srv.base}${p}`;
  const fake = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => {
    const d = await startFakeDevice({ ...FAST, id: nextId(), ...extra });
    fakes.push(d);
    const r = await send(`POST`, api("/api/devices"), { host: `127.0.0.1:${d.port}` });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    return d;
  };
  const planOf = async (bid: string, targetIds: string[], include?: unknown): Promise<BackupPlan[]> => {
    const r = await send<{ plans: BackupPlan[] }>("POST", api(`/api/backups/${bid}/plan`), { targetIds, ...(include ? { include } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.plans;
  };
  const done = async (job: Job): Promise<Job> => {
    const terminal = ["succeeded", "failed", "partial", "cancelled"];
    let last = job;
    await waitUntil(async () => {
      last = (await send<Job>("GET", api(`/api/jobs/${job.id}`))).body;
      return terminal.includes(last.state);
    }, 8000, "job to finish");
    return last;
  };
  const backupNow = async (d: FakeDevice, note?: string): Promise<BackupMeta> => {
    const r = await send<BackupMeta>("POST", api(`/api/devices/${d.id}/backup`), note ? { note } : undefined);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  before(async () => {
    srv = await startTestServer({
      pollIntervalMs: 60_000,
      pollTimeoutMs: 400,
      registrySaveDebounceMs: 40,
      discovery: { mdns: false, interfaces: () => [] },
      jobs: { wsThrottleMs: 0 },
    });
  });
  after(async () => {
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  describe("snapshot and store", () => {
    test("a demo device snapshot has pins, add-ons, rules, MQTT without credentials, and honest gaps", async () => {
      const src = await fake({ seed: "demo", name: "Workshop node" });
      // One pin goes through the Manager so it has a shadow; the rest are live-derived.
      const sent = await send<{ ok: boolean }>("POST", api(`/api/devices/${src.id}/command`), { cmd: "pin.configure", gpio: 4, mode: "out", invert: true, boot: 1 });
      assert.equal(sent.body.ok, true);

      const meta = await backupNow(src, "before rewiring");
      assert.match(meta.id, /^bk_\d{8}T\d{6}_[0-9a-f]{6}$/);
      assert.deepEqual(meta.counts, { pins: 5, modules: 1, rules: 1 });
      assert.equal(meta.note, "before rewiring");
      assert.equal(meta.source.id, src.id);
      assert.equal(meta.source.name, "Workshop node");
      assert.ok(meta.size > 200);
      for (const g of ["wifi", "ap_password", "mqtt_credentials", "pin:27:invert/pull/irq"]) assert.ok(meta.gaps.includes(g), `gap ${g}: ${meta.gaps.join(",")}`);
      assert.ok(!meta.gaps.includes("pin:4:invert/pull/boot"), "pin 4 comes from the shadow");

      const file = (await send<BackupFile>("GET", api(`/api/backups/${meta.id}`))).body;
      assert.equal(file.kind, "de-esp32-backup");
      assert.equal(file.v, 1);
      assert.equal(file.name, "Workshop node");
      assert.equal(file.source.board_id, "esp32-devkitc");
      assert.deepEqual(file.pins.find((p) => p.gpio === 4), { gpio: 4, mode: "out", invert: true, boot: 1, _from: "shadow" });
      assert.deepEqual(file.pins.find((p) => p.gpio === 27), { gpio: 27, mode: "in", _from: "live" }, "live-derived: pull_up is unreadable");
      assert.equal(file.pins.find((p) => p.gpio === 18)?._from, "live");
      assert.equal(file.modules[0]?.id, "env0");
      assert.equal(file.modules[0]?.type, "bme280");
      assert.ok(!("state" in (file.modules[0] ?? {})), "live state is not part of the backup");
      assert.equal(file.rules[0]?.id, "r32");
      assert.deepEqual(file.mqtt, { uri: "mqtt://192.168.1.10:1883", root: "devices" });
      assert.ok(!JSON.stringify(file).includes("secret"), "no MQTT password anywhere");
      assert.ok(existsSync(path.join(srv.dataDir, "backups", `${meta.id}.json`)));
    });

    test("an empty device has no MQTT and no credentials gap", async () => {
      const d = await fake({ seed: "empty" });
      const meta = await backupNow(d);
      assert.deepEqual(meta.counts, { pins: 0, modules: 0, rules: 0 });
      assert.ok(!meta.gaps.includes("mqtt_credentials"));
      const file = (await send<BackupFile>("GET", api(`/api/backups/${meta.id}`))).body;
      assert.equal(file.mqtt, null);
    });

    test("list is newest first and filterable by device; note edit, download header, delete", async () => {
      const a = await fake({ seed: "empty", name: "Alpha node" });
      const b = await fake({ seed: "empty", name: "Beta node" });
      const m1 = await backupNow(a);
      await new Promise((r) => setTimeout(r, 15));
      const m2 = await backupNow(b);
      const all = (await send<BackupMeta[]>("GET", api("/api/backups"))).body;
      assert.ok(all.findIndex((m) => m.id === m2.id) < all.findIndex((m) => m.id === m1.id), "newest first");
      assert.deepEqual((await send<BackupMeta[]>("GET", api(`/api/backups?deviceId=${a.id}`))).body.map((m) => m.id), [m1.id]);

      const patched = await send<BackupMeta>("PATCH", api(`/api/backups/${m1.id}`), { note: "known good" });
      assert.equal(patched.body.note, "known good");
      assert.equal((await send<BackupFile>("GET", api(`/api/backups/${m1.id}`))).body.note, "known good");

      const dl = await fetch(api(`/api/backups/${m1.id}?download=1`));
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="Alpha_node-\d{4}-\d{2}-\d{2}\.json"$/);
      assert.equal(((await dl.json()) as BackupFile).kind, "de-esp32-backup");
      assert.equal((await fetch(api(`/api/backups/${m1.id}`))).headers.get("content-disposition"), null);

      assert.equal((await send("DELETE", api(`/api/backups/${m1.id}`))).status, 204);
      assert.equal((await send<ErrorResponse>("GET", api(`/api/backups/${m1.id}`))).body.code, "unknown_backup");
      assert.equal((await send("DELETE", api(`/api/backups/${m1.id}`))).status, 404);
      assert.ok(!existsSync(path.join(srv.dataDir, "backups", `${m1.id}.json`)));
    });

    test("import: accepts a downloaded file under a new id, rejects bad files with a plain reason", async () => {
      const d = await fake({ seed: "demo" });
      const meta = await backupNow(d);
      const file = (await send<BackupFile>("GET", api(`/api/backups/${meta.id}`))).body;
      const imp = await send<BackupMeta>("POST", api("/api/backups/import"), file);
      assert.equal(imp.status, 201, JSON.stringify(imp.body));
      assert.notEqual(imp.body.id, meta.id);
      assert.equal(imp.body.createdAt, file.createdAt);
      assert.deepEqual(imp.body.counts, meta.counts);

      const bad = async (body: unknown, re: RegExp): Promise<void> => {
        const r = await send<ErrorResponse>("POST", api("/api/backups/import"), body);
        assert.equal(r.status, 422, JSON.stringify(r.body));
        assert.equal(r.body.code, "invalid_backup");
        assert.match(r.body.error, re);
      };
      await bad({ hello: "world" }, /not a de-esp32 backup/);
      await bad({ ...file, v: 2 }, /version 2/);
      await bad({ ...file, pins: [{ gpio: 4, mode: "banana", _from: "live" }] }, /pins\.0\.mode/);
      await bad({ ...file, pins: [file.pins[0], file.pins[0]] }, /GPIO \d+ appears twice/);
      await bad({ ...file, createdAt: "not a date at all" }, /not a valid date/);
      await bad({ ...file, extra: 1 }, /damaged or incomplete/);
      const arr = await send<ErrorResponse>("POST", api("/api/backups/import"), []);
      assert.equal(arr.status, 400);
    });

    test("offline device: 409 device_offline; unknown device 404; unreachable but not yet marked offline: 502", async () => {
      const d = await fake({ seed: "empty" });
      assert.equal((await send<ErrorResponse>("POST", api("/api/devices/ffffffffffff/backup"))).status, 404);
      d.goOffline("refuse");
      const r1 = await send<{ transport?: boolean; code?: string }>("POST", api(`/api/devices/${d.id}/backup`));
      assert.equal(r1.status, 502);
      assert.equal(r1.body.transport, true);
      await send("POST", api(`/api/devices/${d.id}/refresh`));
      await send("POST", api(`/api/devices/${d.id}/refresh`));
      const r2 = await send<ErrorResponse>("POST", api(`/api/devices/${d.id}/backup`));
      assert.equal(r2.status, 409);
      assert.equal(r2.body.code, "device_offline");
      d.goOnline();
    });

    test("files survive a restart of the store (index is rebuilt; a damaged file is skipped)", async () => {
      const dir = path.join(srv.dataDir, "backups");
      const before = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      assert.ok(before > 3);
      const { createBackupStore } = await import("../src/backups/store");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(dir, "bk_broken.json"), "{ nope");
      const logs: string[] = [];
      const again = await createBackupStore(dir, (m) => logs.push(m));
      assert.equal(again.list().length, (await send<BackupMeta[]>("GET", api("/api/backups"))).body.length);
      assert.ok(logs.some((l) => l.includes("bk_broken.json")));
      const { rmSync } = await import("node:fs");
      rmSync(path.join(dir, "bk_broken.json"));
    });
  });

  describe("plan and apply", () => {
    test("restore demo onto an empty target: plan has the spec order, apply makes the target equal, the next plan is empty", async () => {
      const src = await fake({ seed: "demo", name: "Source node" });
      const dst = await fake({ seed: "empty", name: "Target node" });
      const meta = await backupNow(src);

      // The device name is opt-in for a restore: the default plan never renames.
      const [noName] = await planOf(meta.id, [dst.id]);
      assert.ok(noName && !noName.steps.some((s) => s.op === "identity.set_name"), "name is off by default");
      const NAME = { name: true };
      const [plan] = await planOf(meta.id, [dst.id], NAME);
      assert.ok(plan);
      assert.equal(plan.reachable, true);
      assert.equal(plan.error, null);
      assert.equal(plan.targetName, "Target node");
      assert.deepEqual(plan.steps.map((s) => s.id), [
        "pin.configure:4",
        "pin.configure:18",
        "pin.configure:19",
        "pin.configure:27",
        "pin.configure:32",
        "module.add:env0",
        "rule.set:r32",
        "mqtt.configure",
        "identity.set_name",
      ]);
      assert.deepEqual(plan.conflicts, []);
      assert.ok(plan.steps.every((s) => s.summary.length > 5 && typeof s.cmd.cmd === "string"));
      assert.ok(plan.warnings.some((w) => /not stored in backups/.test(w)));
      assert.ok(plan.warnings.some((w) => /GPIO 4, 27|GPIO 27, 4|GPIO 4/.test(w)), "live-derived pins are flagged");
      // Planning only reads.
      assert.equal(dst.state.pins.length, 0);
      assert.equal(dst.state.modules.length, 0);

      const started = await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [dst.id], include: NAME });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.equal(started.body.kind, "backup-apply");
      assert.deepEqual(started.body.devices.map((d) => d.deviceId), [dst.id]);
      const job = await done(started.body);
      assert.equal(job.state, "succeeded", JSON.stringify(job));
      assert.deepEqual(job.devices[0]?.result, { applied: 9, total: 9 });
      assert.equal(job.devices[0]?.state, "done");
      assert.deepEqual(job.result, { backupId: meta.id, devices: 1, ok: 1, failed: 0 });

      // The target now equals the source.
      const mods = (r: { modules: Array<Record<string, unknown>> }) => r.modules.map((m) => ({ id: m.id, type: m.type, bus: m.bus, enabled: m.enabled, pins: m.pins, settings: m.settings }));
      assert.deepEqual(mods(result(await cmd(dst, { cmd: "module.list" })) as never), mods(result(await cmd(src, { cmd: "module.list" })) as never));
      assert.deepEqual(result(await cmd(dst, { cmd: "rule.list" })), result(await cmd(src, { cmd: "rule.list" })));
      const strip = (m: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("mod_")).map(([k, v]) => [k, { mode: v.mode, gpio: v.gpio }]));
      assert.deepEqual(strip(await fetchPins(dst)), strip(await fetchPins(src)));
      assert.equal(dst.state.mqtt.uri, "mqtt://192.168.1.10:1883");
      assert.equal(dst.state.mqtt.password, "", "credentials were never carried over");
      assert.equal(dst.state.name, "Source node");

      const [after] = await planOf(meta.id, [dst.id]);
      assert.deepEqual(after?.steps, [], "post-apply plan is empty");
      assert.deepEqual(after?.unchanged, { pins: 5, modules: 1, rules: 1 });
      // The Manager's registry follows the rename.
      assert.equal((await send<{ name: string }>("GET", api(`/api/devices/${dst.id}`))).body.name, "Source node");
    });

    test("MQTT: the target's existing credentials are kept", async () => {
      const src = await fake({ seed: "demo" });
      const dst = await fake({ seed: "empty", mqtt: { uri: "mqtt://old:1883", user: "keepme", password: "pw" } });
      const meta = await backupNow(src);
      const job = await done((await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [dst.id], include: { pins: false, modules: false, rules: false, name: false } })).body);
      assert.equal(job.state, "succeeded");
      assert.equal(dst.state.mqtt.uri, "mqtt://192.168.1.10:1883");
      assert.equal(dst.state.mqtt.user, "keepme");
      assert.equal(dst.state.mqtt.password, "pw");
    });

    test("include narrows the plan; unknown targets and backups are 404; empty target list is 400", async () => {
      const src = await fake({ seed: "demo" });
      const dst = await fake({ seed: "empty" });
      const meta = await backupNow(src);
      const [rulesOnly] = await planOf(meta.id, [dst.id], { pins: false, modules: false, mqtt: false, name: false });
      assert.deepEqual(rulesOnly?.steps.map((s) => s.id), ["rule.set:r32"]);
      assert.ok(rulesOnly?.warnings.some((w) => /Rule r32 uses GPIO/.test(w)));
      assert.equal((await send("POST", api(`/api/backups/${meta.id}/plan`), { targetIds: ["ffffffffffff"] })).status, 404);
      assert.equal((await send("POST", api("/api/backups/nope/plan"), { targetIds: [dst.id] })).status, 404);
      assert.equal((await send("POST", api(`/api/backups/${meta.id}/plan`), { targetIds: [] })).status, 400);
      assert.equal((await send("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: ["ffffffffffff"] })).status, 404);
    });

    test("a target with different stuff: extras are removed, pins reconfigured, nothing equal is touched", async () => {
      const src = await fake({ seed: "demo" });
      const dst = await fake({
        seed: "empty",
        pins: [{ gpio: 4, mode: "out" }, { gpio: 23, mode: "out" }],
        rules: [{ id: "x1", on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 23, value: 1 } }],
      });
      const meta = await backupNow(src);
      const [plan] = await planOf(meta.id, [dst.id], { name: false });
      const ids = plan?.steps.map((s) => s.id) ?? [];
      assert.equal(ids[0], "rule.remove:x1", "rules first");
      assert.ok(ids.indexOf("pin.disable:23") < ids.indexOf("pin.configure:18"));
      assert.ok(!ids.includes("pin.configure:4"), "pin 4 already equal");
      assert.equal(plan?.unchanged.pins, 1);
      const job = await done((await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [dst.id], include: { name: false } })).body);
      assert.equal(job.state, "succeeded", JSON.stringify(job));
      assert.ok(!dst.state.pins.some((p) => p.gpio === 23));
      assert.ok(!dst.state.rules.some((r) => r.id === "x1"));
      assert.equal((await planOf(meta.id, [dst.id], { name: false }))[0]?.steps.length, 0);
    });

    test("an add-on on the target that owns a backup pin: reported as a conflict, the rest still applies", async () => {
      const src = await fake({ seed: "empty", pins: [{ gpio: 21, mode: "out" }, { gpio: 4, mode: "out" }] });
      const dst = await fake({ seed: "empty", modules: [{ type: "bme280", id: "env0", bus: "i2c0", pins: { sda: 21, scl: 22 }, settings: { addr: 118 } }] });
      const meta = await backupNow(src);
      const [plan] = await planOf(meta.id, [dst.id], { modules: false, name: false, mqtt: false });
      assert.deepEqual(plan?.steps.map((s) => s.id), ["pin.configure:4"]);
      assert.equal(plan?.conflicts.length, 1);
      assert.match(plan?.conflicts[0]?.message ?? "", /GPIO 21 is used by the add-on "env0"/);
      const job = await done((await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [dst.id], include: { modules: false, name: false, mqtt: false } })).body);
      assert.equal(job.state, "succeeded");
      assert.match(job.devices[0]?.message ?? "", /1 conflict was left/);
      assert.ok(dst.state.pins.some((p) => p.gpio === 4));
    });

    test("a failing step stops that target and says which step and why; the job reports it as failed", async () => {
      const src = await fake({ seed: "empty" });
      const dst = await fake({ seed: "empty" });
      const base = (await send<BackupFile>("GET", api(`/api/backups/${(await backupNow(src)).id}`))).body;
      const bad: BackupFile = {
        ...base,
        pins: [
          { gpio: 4, mode: "out", _from: "shadow" },
          { gpio: 34, mode: "out", _from: "shadow" }, // GPIO 34 is input-only
          { gpio: 5, mode: "out", _from: "shadow" },
        ],
        rules: [{ id: "r1", enabled: true, on: { gpio: 27, op: "gt", value: 1 }, then: { gpio: 4, value: 1 } }],
      };
      const meta = (await send<BackupMeta>("POST", api("/api/backups/import"), bad)).body;
      const job = await done((await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [dst.id] })).body);
      assert.equal(job.state, "failed");
      const row = job.devices[0];
      assert.equal(row?.state, "failed");
      assert.deepEqual(row?.result, { applied: 1, total: 4, failedStep: "pin.configure:34" });
      assert.equal(row?.error?.step, "pin.configure:34");
      assert.match(row?.error?.message ?? "", /Could not set GPIO 34 to output: GPIO 34 cannot be used as output/);
      assert.match(row?.message ?? "", /Stopped after 1 of 4 changes/);
      assert.ok(dst.state.pins.some((p) => p.gpio === 4), "the first step went through (partial apply)");
      assert.ok(!dst.state.pins.some((p) => p.gpio === 5), "nothing after the failure ran");
      assert.equal(dst.state.rules.length, 0);
    });

    test("offline target: plan says unreachable, apply fails that row while the other target is done (partial)", async () => {
      const src = await fake({ seed: "demo" });
      const ok = await fake({ seed: "empty", name: "Reachable" });
      const gone = await fake({ seed: "empty", name: "Gone" });
      const meta = await backupNow(src);
      gone.goOffline("refuse");

      const plans = await planOf(meta.id, [ok.id, gone.id]);
      assert.equal(plans[0]?.reachable, true);
      assert.equal(plans[1]?.reachable, false);
      assert.match(plans[1]?.error ?? "", /Could not reach Gone/);
      assert.deepEqual(plans[1]?.steps, []);

      const job = await done((await send<Job>("POST", api(`/api/backups/${meta.id}/apply`), { targetIds: [ok.id, gone.id] })).body);
      assert.equal(job.state, "partial", JSON.stringify(job));
      assert.equal(job.devices.find((d) => d.deviceId === ok.id)?.state, "done");
      const bad = job.devices.find((d) => d.deviceId === gone.id);
      assert.equal(bad?.state, "failed");
      assert.equal(bad?.error?.code, "device_unreachable");

      // After two failed polls the Manager knows it is offline and does not even try.
      await send("POST", api(`/api/devices/${gone.id}/refresh`));
      await send("POST", api(`/api/devices/${gone.id}/refresh`));
      const [again] = await planOf(meta.id, [gone.id]);
      assert.match(again?.error ?? "", /is offline right now/);

      // Retry re-runs only the target that did not finish.
      gone.goOnline();
      await send("POST", api(`/api/devices/${gone.id}/refresh`));
      const retried = await send<Job>("POST", api(`/api/jobs/${job.id}/retry`));
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.deepEqual(retried.body.deviceIds, [gone.id]);
      const second = await done(retried.body);
      assert.equal(second.state, "succeeded", JSON.stringify(second));
      assert.equal(gone.state.modules.length, 1);
    });
  });

  describe("clone", () => {
    test("clone excludes the name by default, takes a fresh snapshot, saves nothing unless asked", async () => {
      const src = await fake({ seed: "demo", name: "Clone source" });
      const dst1 = await fake({ seed: "empty", name: "Clone target 1" });
      const dst2 = await fake({ seed: "empty", name: "Clone target 2" });
      const countBefore = (await send<BackupMeta[]>("GET", api("/api/backups"))).body.length;

      const plans = (await send<{ plans: BackupPlan[] }>("POST", api("/api/clone/plan"), { sourceId: src.id, targetIds: [dst1.id, dst2.id] })).body.plans;
      assert.equal(plans.length, 2);
      assert.ok(plans.every((p) => !p.steps.some((s) => s.op === "identity.set_name")), "name is off by default");
      const withName = (await send<{ plans: BackupPlan[] }>("POST", api("/api/clone/plan"), { sourceId: src.id, targetIds: [dst1.id], include: { name: true } })).body.plans;
      assert.ok(withName[0]?.steps.some((s) => s.op === "identity.set_name"));

      const started = await send<Job>("POST", api("/api/clone"), { sourceId: src.id, targetIds: [dst1.id, dst2.id] });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.match(started.body.title, /^Clone Clone source to 2 devices$/);
      const job = await done(started.body);
      assert.equal(job.state, "succeeded", JSON.stringify(job));
      assert.deepEqual(job.result, { backupId: null, devices: 2, ok: 2, failed: 0 });
      for (const d of [dst1, dst2]) {
        assert.equal(d.state.modules.length, 1);
        assert.equal(d.state.rules.length, 1);
        assert.equal(d.state.pins.length, 5);
        assert.ok(d.state.name !== "Clone source", "name was not copied");
      }
      assert.equal((await send<BackupMeta[]>("GET", api("/api/backups"))).body.length, countBefore, "snapshot was not saved");

      const saved = await send<Job>("POST", api("/api/clone"), { sourceId: src.id, targetIds: [dst1.id], saveSnapshot: true });
      const savedJob = await done(saved.body);
      const bid = (savedJob.result as { backupId: string }).backupId;
      assert.match(bid, /^bk_/);
      assert.equal((await send<BackupMeta[]>("GET", api("/api/backups"))).body.length, countBefore + 1);
    });

    test("a clone onto its own source is 400; unknown ids 404; an offline source is 409 / 502", async () => {
      const src = await fake({ seed: "demo" });
      const dst = await fake({ seed: "empty" });
      const same = await send<ErrorResponse>("POST", api("/api/clone"), { sourceId: src.id, targetIds: [dst.id, src.id] });
      assert.equal(same.status, 400);
      assert.equal(same.body.code, "invalid_targets");
      assert.equal((await send("POST", api("/api/clone/plan"), { sourceId: src.id, targetIds: [src.id] })).status, 400);
      assert.equal((await send("POST", api("/api/clone"), { sourceId: "ffffffffffff", targetIds: [dst.id] })).status, 404);
      src.goOffline("refuse");
      assert.equal((await send("POST", api("/api/clone"), { sourceId: src.id, targetIds: [dst.id] })).status, 502);
      await send("POST", api(`/api/devices/${src.id}/refresh`));
      await send("POST", api(`/api/devices/${src.id}/refresh`));
      const off = await send<ErrorResponse>("POST", api("/api/clone"), { sourceId: src.id, targetIds: [dst.id] });
      assert.equal(off.status, 409);
      assert.equal(off.body.code, "device_offline");
      src.goOnline();
    });
  });
});
