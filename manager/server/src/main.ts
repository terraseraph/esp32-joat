import { spawn } from "node:child_process";
import { start } from "./app";
import { HELP, parseCli } from "./cli";
import { lanUrlsFor } from "./net";
import { resolvePublicDir } from "./publicDir";
import { VERSION } from "./version";

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // no browser available: the URL is printed anyway
    child.unref();
  } catch {
    /* ignore */
  }
}

function banner(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = "=".repeat(width + 4);
  return [bar, ...lines.map((l) => `| ${l.padEnd(width)} |`), bar].join("\n");
}

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (cli.help) {
    console.log(HELP);
    return;
  }

  const running = await start({
    port: cli.port,
    host: cli.host,
    lan: cli.lan,
    dataDir: cli.dataDir,
    publicDir: resolvePublicDir(process.argv[1]),
    allowOrigins: cli.allowOrigins,
    wifiAdapter: cli.wifiAdapter,
    ...(cli.fakeAps.length > 0 ? { setup: { fakeAps: cli.fakeAps } } : {}),
    ...(Object.keys(cli.ipChangeMap).length > 0 ? { ipChange: { hostMap: cli.ipChangeMap } } : {}),
    log: (msg) => console.log(`[manager] ${msg}`),
  });

  console.log(`de-esp32 Manager ${VERSION}`);
  console.log(`  Local:    ${running.url}`);
  console.log(`  Data dir: ${cli.dataDir}`);
  if (cli.wifiAdapter !== "system") console.log(`  Wi-Fi adapter: ${cli.wifiAdapter}`);
  // The ONLY place the token is printed: plain stdout at start-up (spec 3.1), never through log() or any file.
  // LAN access switched on later from Settings is logged without the token (see http/access.ts).
  if (running.lan && running.token) {
    const urls = lanUrlsFor(running.host, running.port).map((u) => `${u}?token=${running.token}`);
    console.log(
      "\n" +
        banner([
          "LAN MODE - anyone with the token can control your devices",
          "",
          ...(urls.length ? ["Open from another device:", ...urls.map((u) => "  " + u)] : ["(no LAN address found for this bind)"]),
          "",
          `Access token: ${running.token}`,
        ]) +
        "\n",
    );
  }
  if (cli.open) openBrowser(running.url);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    console.log("\n[manager] shutting down");
    // A running setup job must put this PC's Wi-Fi back first (close() waits for it), so allow time when setup is on.
    const force = setTimeout(() => process.exit(0), cli.wifiAdapter === "none" ? 3000 : 25_000);
    force.unref();
    running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`Port already in use. Try another with --port <n>.`);
  else console.error(err.stack ?? String(err));
  process.exit(1);
});
