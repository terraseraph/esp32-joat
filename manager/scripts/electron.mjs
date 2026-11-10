// Electron helper. `node scripts/electron.mjs <stage|dev|dist>`
//   stage  vite build + esbuild electron/main.ts (server inlined) -> <os tmpdir>/de-esp32-manager-electron-app/{main.cjs,public/,package.json}
//   dev    stage, then run Electron on that directory (honours the DE_ESP32_MANAGER_* env overrides, see electron/main.ts)
//   dist   stage, then electron-builder --win portable (config: electron/electron-builder.yml) -> release/
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// Staged OUTSIDE manager/: electron-builder walks up from the app dir and would otherwise pick up manager/node_modules (+60 MB).
const stageDir = path.join(os.tmpdir(), "de-esp32-manager-electron-app");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const mode = process.argv[2];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function stage() {
  run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "web/vite.config.ts"]);
  if (!existsSync(path.join(root, "web", "dist", "index.html"))) throw new Error("web/dist/index.html is missing after vite build");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "electron", "main.ts")],
    outfile: path.join(stageDir, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22", // Electron 45 ships a newer Node; keep syntax conservative
    sourcemap: false,
    external: ["electron", "bufferutil", "utf-8-validate", "mqtt"],
    logLevel: "info",
  });
  cpSync(path.join(root, "web", "dist"), path.join(stageDir, "public"), { recursive: true });
  // Deliberately no "dependencies": everything is bundled, so electron-builder ships no node_modules.
  writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify({ name: pkg.name, productName: "de-esp32 Manager", version: pkg.version, description: pkg.description, main: "main.cjs", author: "de-esp32" }, null, 2) + "\n",
  );
  console.log(`${stageDir} ready (v${pkg.version})`);
}

if (mode === "stage") await stage();
else if (mode === "dev") {
  await stage();
  const electronBin = require("electron"); // path to the electron executable
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  run(electronBin, [stageDir], { env });
} else if (mode === "dist") {
  await stage();
  const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
  // projectDir = the staging dir too, otherwise electron-builder falls back to manager/package.json and ships manager/node_modules.
  run(
    process.execPath,
    [
      cli, "--win", "portable", "--x64", "--publish", "never",
      "--projectDir", stageDir,
      "--config", path.join(root, "electron", "electron-builder.yml"),
      `--config.electronVersion=${JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version}`,
      `--config.directories.output=${path.join(root, "release")}`,
    ],
    { cwd: stageDir },
  );
} else {
  console.error("usage: node scripts/electron.mjs <stage|dev|dist>");
  process.exit(2);
}
