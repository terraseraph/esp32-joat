// npm run dev: API server (tsx watch, :5180) + Vite (:5173) with prefixed output; Ctrl+C stops both.
// Extra arguments go to the server: `npm run dev -- --port 5290`. The dev server defaults to --no-network-scan and
// --wifi-adapter fake; opt out with `--network-scan` / `--wifi-adapter system` (see devArgs.mjs).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devServerArgs } from "./devArgs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

const procs = [
  {
    name: "server",
    args: [tsxCli, "watch", "server/src/main.ts", ...devServerArgs(process.argv.slice(2))],
  },
  { name: "web", args: [viteBin, "--config", "web/vite.config.ts"] },
];

function prefix(name, stream, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => buf && out.write(`[${name}] ${buf}\n`));
}

function kill(child) {
  if (child.exitCode !== null || !child.pid) return;
  // tsx watch runs the server as a grandchild: on Windows kill the whole tree.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

let stopping = false;
const children = procs.map(({ name, args }) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[${name}] exited (${code}); stopping the others`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) kill(c);
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
