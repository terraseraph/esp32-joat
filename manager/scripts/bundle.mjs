// Bundles the server into dist/: server.cjs (all deps inlined), public/ (the built SPA), package.json.
// Run after `vite build` (npm run build does both).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const webDist = path.join(root, "web", "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

if (!existsSync(path.join(webDist, "index.html"))) {
  console.error("web/dist/index.html is missing: run `vite build` first (npm run build does).");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "src", "main.ts")],
  outfile: path.join(dist, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  // Optional, never used by the Manager: `ws` native accelerators and the shared lib's lazy MQTT
  // discovery (mqtt is a large dependency; its require() sits in a try/catch and returns []).
  external: ["bufferutil", "utf-8-validate", "mqtt"],
  logLevel: "info",
});

cpSync(webDist, path.join(dist, "public"), { recursive: true });
writeFileSync(
  path.join(dist, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, bin: { "de-esp32-manager": "server.cjs" }, engines: pkg.engines }, null, 2) + "\n",
);
console.log(`dist/ ready: server.cjs, public/, package.json (v${pkg.version})`);
