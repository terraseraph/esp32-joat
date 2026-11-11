// Quick "will this build on GitHub Actions" check for Node-RED, the browser installer and the Manager.
// Run from anywhere: node tools/precheck.mjs   (firmware is not checked: it needs ESP-IDF, see build.yml)
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODERED = join(ROOT, "nodered", "node-red-contrib-de-esp32");
const INSTALL = join(ROOT, "install");
const MANAGER = join(ROOT, "manager");

let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => console.log(`  WARN  ${msg}`);
const fail = (msg) => { failed++; console.log(`  FAIL  ${msg}`); };
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const jsFiles = (dir) => readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => f.endsWith(".js") && !f.includes("node_modules")).map((f) => join(dir, f));

function step(name, fn) {
  try { fn(); } catch (e) { fail(`${name}: ${(e.stdout || "") + (e.stderr || "") || e.message}`.trim()); }
}

// npm ci (what CI runs) refuses when package.json and package-lock.json disagree.
function lockInSync(dir) {
  const pkg = readJson(join(dir, "package.json"));
  const root = readJson(join(dir, "package-lock.json")).packages?.[""] ?? {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const a = pkg[field] ?? {}, b = root[field] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] !== b[k]) return fail(`${relative(ROOT, dir)}: package-lock.json out of sync (${field}.${k}: ${a[k]} vs ${b[k]}); run npm install`);
    }
  }
  ok(`${relative(ROOT, dir)}: package-lock.json matches package.json`);
}

// CI builds what is committed: new files that are not tracked are missing there.
function untracked(dir) {
  const out = run(`git ls-files --others --exclude-standard -- "${relative(ROOT, dir)}"`, ROOT)
    .split("\n").filter((f) => f && !f.endsWith(".md")).join("\n");   // docs can't break CI
  if (out) warn(`untracked files (not on GitHub until added):\n          ${out.split("\n").join("\n          ")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Every feature has three docs with the same name: docs/features, nodered/.../docs, manager/docs.
console.log("\nFeature docs (lockstep)");
step("docs", () => {
  const dirs = { firmware: join(ROOT, "docs", "features"), "node-red": join(NODERED, "docs"), manager: join(MANAGER, "docs") };
  const names = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : []);
  const all = new Set(Object.values(dirs).flatMap(names));
  let missing = 0;
  for (const f of [...all].sort()) {
    const lacking = Object.entries(dirs).filter(([, d]) => !existsSync(join(d, f))).map(([k]) => k);
    if (lacking.length) { missing++; fail(`${f}: no ${lacking.join(" / ")} doc`); }
  }
  const index = readFileSync(join(ROOT, "docs", "FEATURES_README.md"), "utf8");
  for (const f of all) if (!index.includes(`features/${f}`)) fail(`${f}: no row in docs/FEATURES_README.md`);
  if (!missing) ok(`${all.size} features, each with firmware, Node-RED and Manager docs`);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("\nNode-RED palette");
step("node-red", () => {
  lockInSync(NODERED);
  const pkg = readJson(join(NODERED, "package.json"));
  for (const [name, file] of Object.entries(pkg["node-red"].nodes)) {
    if (!existsSync(join(NODERED, file))) fail(`node ${name}: ${file} missing`);
    const html = join(NODERED, file.replace(/\.js$/, ".html"));
    if (!existsSync(html)) fail(`node ${name}: ${relative(NODERED, html)} missing`);
  }
  const files = [...jsFiles(join(NODERED, "nodes")), ...jsFiles(join(NODERED, "lib"))];
  for (const f of files) run(`node --check "${f}"`);
  ok(`${files.length} files parse, ${Object.keys(pkg["node-red"].nodes).length} nodes registered`);
  untracked(NODERED);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("\nBrowser installer (install/)");
step("installer", () => {
  const manifest = readJson(join(INSTALL, "manifest.json"));
  const parts = readFileSync(join(ROOT, "partitions.csv"), "utf8").split("\n")
    .filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(",").map((s) => s.trim()));
  const ota0 = parts.find((p) => p[0] === "ota_0");
  for (const part of manifest.parts) {
    const p = join(INSTALL, part.path);
    if (!existsSync(p)) { fail(`${part.path} missing (run tools/stage_web_flash.ps1)`); continue; }
    if (part.path.endsWith("de_esp32_runtime.bin")) {
      if (Number(ota0[3]) !== part.offset) fail(`app offset ${part.offset} != ota_0 ${ota0[3]} in partitions.csv`);
      const size = statSync(p).size;
      if (size > Number(ota0[4])) fail(`app is ${size} bytes, ota_0 holds ${Number(ota0[4])}`);
      else ok(`app fits ota_0 (${Math.round((100 * size) / Number(ota0[4]))}%)`);
    }
  }
  run(`node --check "${join(INSTALL, "lib", "console.js")}"`);
  const html = readFileSync(join(INSTALL, "index.html"), "utf8");
  for (const [, src] of html.matchAll(/src="([^"?:]+)[^"]*"/g)) {
    if (!existsSync(join(INSTALL, src))) fail(`index.html loads ${src}, which is missing`);
  }
  ok("manifest, firmware images and page scripts present");
  untracked(INSTALL);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("\nManager (lint, typecheck, build, smoke start)");
step("manager", () => {
  lockInSync(MANAGER);
  for (const s of ["lint", "typecheck", "build"]) { run(`npm run ${s}`, MANAGER); ok(`npm run ${s}`); }
  untracked(MANAGER);
});
if (!failed) await smokeStart();

async function smokeStart() {
  const dataDir = mkdtempSync(join(tmpdir(), "precheck-"));
  const srv = spawn(process.execPath, ["dist/server.cjs", "--no-open", "--wifi-adapter", "none", "--port", "0", "--data-dir", dataDir],
    { cwd: MANAGER, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  try {
    let url;
    for (let i = 0; i < 50 && !url; i++) {
      await new Promise((r) => setTimeout(r, 200));
      url = log.match(/Local:\s*(http\S+)/)?.[1];
    }
    if (!url) return fail(`server did not start:\n${log}`);
    const health = await (await fetch(`${url}api/health`)).json();
    if (!health.version) return fail(`/api/health has no version: ${JSON.stringify(health)}`);
    if (!(await fetch(url)).ok) return fail("web app not served");
    ok(`dist/server.cjs starts, /api/health ok (v${health.version})`);
  } catch (e) {
    fail(`smoke start: ${e.message}\n${log}`);
  } finally {
    srv.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} problem(s). Fix before pushing.\n` : "\nAll good. Firmware is checked by CI (build.yml).\n");
process.exit(failed ? 1 : 0);
