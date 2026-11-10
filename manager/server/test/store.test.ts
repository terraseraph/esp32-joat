import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseCli } from "../src/cli";
import { resolvePublicDir } from "../src/publicDir";
import { atomicWrite } from "../src/store/atomicWrite";
import { defaultDataDir } from "../src/store/dataDir";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPath } from "../src/store/settings";
import { tmpDataDir } from "./helpers";

test("atomicWrite creates and replaces a file and leaves no temp files", async () => {
  const dir = tmpDataDir();
  const file = path.join(dir, "a.json");
  await atomicWrite(file, "one");
  await atomicWrite(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("atomicWrite failure leaves the old file and no temp file", async () => {
  const dir = tmpDataDir();
  const file = path.join(dir, "keep");
  await atomicWrite(file, "old");
  const asDir = path.join(dir, "d");
  mkdirSync(asDir);
  await assert.rejects(atomicWrite(asDir, "x")); // cannot rename a file over a directory
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(dir).sort(), ["d", "keep"]);
});

test("settings: defaults when missing, round trip, unknown keys preserved", async () => {
  const dir = tmpDataDir();
  assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS);
  writeFileSync(settingsPath(dir), JSON.stringify({ lanToken: "t", future: { a: 1 } }));
  const s = await loadSettings(dir);
  assert.equal(s.lanToken, "t");
  await saveSettings(dir, s);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(dir), "utf8")), { ...DEFAULT_SETTINGS, lanToken: "t", future: { a: 1 } });
});

test("settings: corrupt or wrongly typed files are reported, not overwritten", async () => {
  const dir = tmpDataDir();
  writeFileSync(settingsPath(dir), "{nope");
  await assert.rejects(loadSettings(dir), /not valid JSON/);
  writeFileSync(settingsPath(dir), JSON.stringify({ lanToken: 5 }));
  await assert.rejects(loadSettings(dir), /invalid value at \/lanToken/);
  assert.equal(readFileSync(settingsPath(dir), "utf8"), JSON.stringify({ lanToken: 5 }));
});

test("defaultDataDir per OS", () => {
  assert.equal(defaultDataDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"), path.join("C:\\Users\\u\\AppData\\Roaming", "de-esp32-manager"));
  assert.equal(defaultDataDir("darwin", {}, "/Users/u"), path.join("/Users/u", "Library", "Application Support", "de-esp32-manager"));
  assert.equal(defaultDataDir("linux", { XDG_CONFIG_HOME: "/x" }, "/home/u"), path.join("/x", "de-esp32-manager"));
  assert.equal(defaultDataDir("linux", {}, "/home/u"), path.join("/home/u", ".config", "de-esp32-manager"));
});

test("parseCli defaults, LAN and errors", () => {
  const d = parseCli(["--data-dir", "x"]);
  assert.deepEqual([d.port, d.host, d.lan, d.open, d.allowOrigins], [5180, "127.0.0.1", false, true, []]);
  const lan = parseCli(["--lan", "--port", "0", "--no-open", "--allow-origin", "http://a", "--allow-origin", "http://b"]);
  assert.deepEqual([lan.port, lan.host, lan.lan, lan.open, lan.allowOrigins], [0, "0.0.0.0", true, false, ["http://a", "http://b"]]);
  assert.equal(parseCli(["--lan", "--host", "127.0.0.1"]).host, "127.0.0.1");
  assert.equal(parseCli(["--host", "192.168.1.5"]).lan, true, "non-loopback host implies LAN mode");
  assert.throws(() => parseCli(["--port", "abc"]), /Invalid --port/);
  assert.throws(() => parseCli(["--bogus"]));
  assert.equal(parseCli(["--help"]).help, true);
});

test("resolvePublicDir prefers bundled public/, then web/dist, then the cwd fallback", () => {
  const has = (...dirs: string[]) => (f: string) => dirs.some((d) => f === path.join(d, "index.html"));
  const script = path.resolve("/app/dist/server.cjs");
  assert.equal(resolvePublicDir(script, "/cwd", has(path.resolve("/app/dist/public"))), path.resolve("/app/dist/public"));
  const dev = path.resolve("/m/server/src/main.ts");
  assert.equal(resolvePublicDir(dev, "/cwd", has(path.resolve("/m/web/dist"))), path.resolve("/m/web/dist"));
  assert.equal(resolvePublicDir(dev, "/cwd", has(path.join("/cwd", "web", "dist"))), path.join("/cwd", "web", "dist"));
  assert.equal(resolvePublicDir(dev, "/cwd", () => false), path.join("/cwd", "web", "dist"));
});
