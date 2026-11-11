// Electron shell: runs the Manager server in-process on 127.0.0.1 (random port) and shows the SPA in one window.
// Bundled by scripts/electron.mjs to CJS (no import.meta here). No preload, no IPC: the SPA is the browser build.
//
// Test/dev environment overrides (all optional):
//   DE_ESP32_MANAGER_DATA_DIR=<dir>        data dir; also becomes Electron's userData, so Chromium's own profile stays out of the real one
//   DE_ESP32_MANAGER_WIFI_ADAPTER=fake|system|none   default system
//   DE_ESP32_MANAGER_READY_FILE=<path>     once listening, write {url, port, pid} JSON there (scripts find the random port)
import { app, BrowserWindow, dialog, shell } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { start, type RunningServer, type StartOptions } from "../server/src/app";

const env = process.env;
const dataDirOverride = env.DE_ESP32_MANAGER_DATA_DIR?.trim() || undefined;
// Must happen before "ready": Chromium creates its profile files in userData.
if (dataDirOverride) app.setPath("userData", path.resolve(dataDirOverride));

const CLOSE_TIMEOUT_MS = 25_000; // a running setup job may need this long to restore the PC's Wi-Fi

let win: BrowserWindow | null = null;
let server: RunningServer | null = null;
let origin = "";
let quitting = false;

function parseAdapter(raw: string | undefined): "fake" | "system" | "none" {
  return raw === "fake" || raw === "none" || raw === "system" ? raw : "system";
}

function isHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function createWindow(url: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: "de-esp32 Manager",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  w.removeMenu();
  w.once("ready-to-show", () => w.show());
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isHttpUrl(target) && !sameOrigin(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (event, target) => {
    if (sameOrigin(target)) return;
    event.preventDefault();
    if (isHttpUrl(target)) void shell.openExternal(target);
  });
  w.on("closed", () => {
    win = null;
    app.quit();
  });
  void w.loadURL(url);
  return w;
}

async function boot(): Promise<void> {
  const dataDir = dataDirOverride ? path.resolve(dataDirOverride) : app.getPath("userData");
  // lanToggle: false = no LAN-mode switch in the desktop app (spec §8); a saved lanEnabled is ignored too.
  const options: StartOptions = {
    host: "127.0.0.1",
    port: 0,
    lan: false,
    lanToggle: false,
    dataDir,
    publicDir: path.join(__dirname, "public"),
    wifiAdapter: parseAdapter(env.DE_ESP32_MANAGER_WIFI_ADAPTER),
    log: (msg) => console.log(`[manager] ${msg}`),
  };
  server = await start(options);
  origin = new URL(server.url).origin;
  const readyFile = env.DE_ESP32_MANAGER_READY_FILE?.trim();
  if (readyFile) writeFileSync(readyFile, JSON.stringify({ url: server.url, port: server.port, pid: process.pid }));
  win = createWindow(server.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("before-quit", (event) => {
    if (quitting || !server) return;
    quitting = true;
    event.preventDefault();
    const closing = server.close().catch(() => {});
    const cap = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref());
    void Promise.race([closing, cap]).finally(() => app.exit(0));
  });

  app.on("window-all-closed", () => app.quit());

  app
    .whenReady()
    .then(boot)
    .catch((err: NodeJS.ErrnoException) => {
      const detail = err.code === "EADDRINUSE" ? "The port is already in use." : (err.stack ?? String(err));
      dialog.showErrorBox("de-esp32 Manager could not start", detail);
      app.exit(1);
    });
}
