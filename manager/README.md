# de-esp32 Manager

A local web app plus server to manage a fleet of de-esp32 boards on your LAN. It shows fleet health, discovers boards
(mDNS and subnet sweep), and has per-device screens for live values, pins, network and system. It also sets up new boards over
their SoftAP, switches a board to a static IP, moves it to another Wi-Fi network (needs newer firmware), updates firmware
(single and bulk), backs up, restores and clones configuration, and keeps its own settings. The Manager is the only path to the
devices: the web app never talks to a board directly. Everything it does is available as a REST API ([API.md](API.md),
machine-readable at `/api/openapi.json`) plus a browser WebSocket.

Node server (`node:http` + `ws`, no framework) serving a React single-page app. Per-feature docs: [docs/](docs/) (see [../docs/FEATURES_README.md](../docs/FEATURES_README.md)).

## Install and run

### Node (20 or newer)

From a release zip (it contains the contents of `dist/`):

```bash
node server.cjs
```

From the repo:

```bash
cd manager
npm ci
npm run build
npm start        # opens http://localhost:5180/
```

`npm ci` needs the whole repo checkout, because `manager/package.json` depends on
`file:../nodered/node-red-contrib-de-esp32`.

### Windows portable exe

Download `de-esp32-manager-<version>-portable.exe` from the GitHub Release and double-click it. No install. The desktop app:

- keeps its data in the Electron user-data folder (not next to the exe);
- listens on localhost only. There is no LAN mode in the desktop app.

### Development

```bash
npm run dev            # API on :5180 (tsx watch) + web app on http://localhost:5173 (Vite, proxies /api)
npm run electron:dev   # build, then run the desktop app from a staging folder
npm run dist:win       # build the portable exe into manager/release/
npm run lint
npm run typecheck
```

`npm run dev` runs the real Manager from source: it scans your network (mDNS and the /24 sweep) and uses this PC's Wi-Fi
adapter for setup, exactly like the packaged app. Its data lives in `manager/.data/dev`. Extra arguments go to the server after `--`:

```bash
npm run dev -- --port 5290                    # another API port
npm run dev -- --wifi-adapter fake            # simulated Wi-Fi adapter (with npm run fake boards)
```

Edits to `../nodered/node-red-contrib-de-esp32/lib` need another `npm install` here (it is installed as a copy).

For the desktop app, these environment variables are for testing and development only:

| Variable | Effect |
|---|---|
| `DE_ESP32_MANAGER_DATA_DIR=<dir>` | data folder; also Electron's user-data folder |
| `DE_ESP32_MANAGER_WIFI_ADAPTER=fake\|system\|none` | default `system` |
| `DE_ESP32_MANAGER_READY_FILE=<path>` | once listening, write `{url, port, pid}` JSON there |

## Command-line flags

```bash
node dist/server.cjs [options]      # or: node server.cjs [options] from a release zip
```

| Flag | Meaning |
|---|---|
| `--port <n>` | Port to listen on. Default 5180; `0` = any free port. |
| `--host <addr>` | Address to bind. Default 127.0.0.1. A non-loopback address other than 0.0.0.0 implies `--lan` and fixes the bind, so LAN access cannot then be switched from Settings. |
| `--lan` | LAN mode: bind 0.0.0.0 (unless `--host` is given) and require an access token. Always on at start with this flag; without it, LAN access starts as last saved in Settings (default off). |
| `--data-dir <path>` | Where registry, settings, backups and firmware live. Default: per-OS app data dir (below). |
| `--no-open` | Do not open the browser. |
| `--allow-origin <url>` | Extra Origin accepted for POST/PUT/PATCH/DELETE and WebSocket. Repeatable. |
| `--wifi-adapter <kind>` | How SoftAP setup reaches a board's Wi-Fi: `system` (this PC's adapter, default), `fake` (simulated, for development) or `none` (setup disabled). |
| `--fake-ap <spec>` | Dev only. With `--wifi-adapter fake`, repeatable: a simulated device in setup mode, `<ssid>=<host:port>[,secured=<password>][,lan=<host:port>]`. `host:port` is where 192.168.4.1 really is; `lan=` is where the device shows up afterwards. |
| `--ip-change-map <ip>=<host:port>` | Dev only. Repeatable: where the IP change job looks for a device after it moved to `<ip>`. Fake devices cannot move; map to a closed port to see the revert path. |
| `--help` | Show the help. |

Data directory defaults:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\de-esp32-manager` |
| macOS | `~/Library/Application Support/de-esp32-manager` |
| Linux and others | `$XDG_CONFIG_HOME/de-esp32-manager` (usually `~/.config/de-esp32-manager`) |

Pass `--data-dir` when experimenting, so you do not touch your real fleet.

## LAN mode and its security caveat

By default the Manager listens on 127.0.0.1 only. To reach it from a phone or another PC, turn on LAN mode with `--lan`
or with the switch in Settings. The Settings switch applies at runtime (the server re-binds the same port). It is not available
in the desktop app, nor when the server was started with a fixed `--host`.

- **Token.** The first time LAN mode is enabled, a token is generated. It is printed once, in the start-up banner on stdout,
  together with `http://<lan-ip>:5180/?token=...` links, and it is shown in Settings.
- **Browsers.** Open the `?token=` link once: the token is exchanged for an HttpOnly cookie (30 days) and the URL is cleaned.
- **Scripts.** Send `Authorization: Bearer <token>`.
- **Regenerate.** Settings (or `POST /api/access/token`) makes a new token; the old one and all cookies stop working.
- **Rate limit.** More than 10 wrong tokens in 60 s from one address get `429` until the window passes.
- **This PC** never needs the token, even in LAN mode.

> **Warning.** Anyone with the token controls every device behind this Manager: pins, Wi-Fi and MQTT settings, firmware.
> The devices themselves have **no authentication**, and anyone on the LAN can talk to them directly. The Manager speaks plain
> http, so anyone who can sniff the network can read the token. Only use LAN mode on a network you trust, never on the internet.

Details: "Security model" in [API.md](API.md).

## Fake devices

You can try the Manager without hardware. Start fake boards:

```bash
npm run fake -- --count 3 --base-port 8101
```

This starts three boards on 127.0.0.1:8101-8103 ("Fake bench 1" to "3"). Options:

| Option | Meaning |
|---|---|
| `--pending-firmware` | Emulate the unmerged firmware branch: `wifi_change`, static IP, extra network fields. |
| `--wifi-move <ssid>=<host:port>` | Repeatable, with `--pending-firmware`: a successful Wi-Fi change to that SSID moves the device to that address. |
| `--ap-mode` | Start as an unprovisioned board in SoftAP setup mode (use with the Manager's `--fake-ap`). |
| `--host`, `--seed demo\|empty`, `--telemetry-ms`, `--reboot-ms`, `--scan-delay-ms` | Listen address, seed data, timings. |

Run the Manager with a simulated Wi-Fi adapter and a scratch data dir:

```bash
node dist/server.cjs --wifi-adapter fake --data-dir %TEMP%\manager-try
```

Then open Discover, choose "Add by IP", and enter `127.0.0.1:8101`. Recipes for the Wi-Fi move and IP change flows are in
[API.md](API.md) ("Testing without a second network", "Testing without moving a device").
Fakes do not prove real mDNS, DHCP, subnet changes or `netsh` behaviour.

## Windows notes

- **SmartScreen.** The portable exe is not code-signed. Windows shows "Windows protected your PC": click "More info", then "Run anyway".
- **Firewall.** On the first scan Windows Defender Firewall may ask about the app, because mDNS uses UDP 5353. Allowing private
  networks is enough. If you deny it, scanning by subnet sweep still works.
- **SoftAP setup** uses `netsh wlan` and temporarily switches this PC's Wi-Fi to the board's own access point (the PC is off
  your LAN meanwhile). The Manager always puts it back, on success, failure, cancel and shutdown. If it crashed mid-setup, it
  offers to restore the network on the next start.

## Not yet verified on hardware

Everything below is covered by unit tests and fake devices only.

- [ ] Real board discovery by mDNS and by /24 sweep
- [ ] SoftAP setup through real `netsh` (never connected anything yet; needs an explicit go-ahead because it switches the PC's Wi-Fi)
- [ ] Non-ASCII SSIDs with real `netsh` output
- [ ] Static IP change and revert on real firmware (pending firmware branch `claude/wifi-change-fallback-ab5ac7`, unmerged)
- [ ] Wi-Fi move on real firmware (same branch), including a subnet change and the recovery AP
- [ ] OTA single, bulk and rollback on a real board
- [ ] Backup, restore and clone on real boards
- [ ] LAN mode from a phone on the real network (0.0.0.0 bind, firewall)
- [ ] Portable exe on a clean Windows machine
- [ ] The CI workflow on GitHub (never run yet) and a real release

## More

- [API.md](API.md): REST routes and the browser WebSocket.
- [CONTRIBUTING-AGENTS.md](CONTRIBUTING-AGENTS.md): conventions for working in `manager/`.
- [../docs/FEATURES_README.md](../docs/FEATURES_README.md): per-feature docs for firmware, Node-RED and Manager.
