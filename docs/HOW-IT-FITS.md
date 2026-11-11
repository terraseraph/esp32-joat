# How the four parts fit

```
            USB (Web Serial / esptool)                 HTTP /api/v1 + WS /api/v1/ws, mDNS
 Flasher ──────────────────────────────►  ESP32  ◄──────────────────────────────────── Manager (PC)
 install/   writes images, then UART       firmware                                     manager/
            JSON: name + Wi-Fi             (repo root) ◄─── REST + WS, or MQTT ──── Node-RED palette
                                                                                    nodered/...
```

The firmware is the centre. Everything else talks to it with the **same JSON commands**
(`{"cmd":"pin.set","gpio":4,"value":1}`), over whichever pipe it has: UART, HTTP or WebSocket.

## 1. Firmware (repo root: `main/`, `components/`, `web/`)

- ESP-IDF 5.4.2, classic ESP32 DevKitC, 4 MB. Build: `. .\tools\env.ps1; idf.py build` (output `build/`).
- On the board:
  - `GET/POST /api/v1/...`: REST, commands go through `command_router`.
  - `/api/v1/ws`: live events.
  - MQTT `{prefix}/io` when a broker is set.
  - mDNS `_http._tcp` and `_de-esp32._tcp`.
  - The same JSON commands over the UART console.
- First boot with no Wi-Fi: open SoftAP `esp32-<last6>`, portal at `http://192.168.4.1`.
- OTA: `POST /api/v1/ota` writes the inactive A/B slot (`partitions.csv`: `ota_0` at `0x20000`).
- Embedded UI: `web/dist/index.html` (built by `tools/build_web.js`).

## 2. Flasher (`install/`, plus `tools/flash.ps1` and `tools/ota_push`)

- `install/index.html` is a static page (Chrome or Edge, Web Serial, esptool-js from a CDN). It writes three images:
  - `bootloader.bin` at `0x1000`
  - `partition-table.bin` at `0x8000`
  - `de_esp32_runtime.bin` at `0x20000`
- It then sends `identity.set_name` and `network.wifi.set` over UART.
- The images live in `install/firmware/`. Refresh them locally with `tools/stage_web_flash.ps1`. On a push to `main` that touches firmware sources, `install.yml` rebuilds them, commits them, and publishes `install/` to GitHub Pages.
- Command-line tools: `tools/flash.ps1` flashes over USB, `tools/ota_push.cmd` flashes over Wi-Fi, `tools/discover.cmd` finds boards.

## 3. Node-RED palette (`nodered/node-red-contrib-de-esp32/`)

- A separate npm package, not part of the firmware image. Nodes: device (config), gpio in, gpio out, module.
- Talks to boards over REST `/api/v1` and WebSocket, or MQTT when a broker is attached. Finds boards with mDNS plus a `/24` probe of `GET /api/v1/status`.
- `lib/` is also used by the Manager: `fingerprint`, `discover`, `pins`, `devkitc-hardware`.
- Push to a Node-RED host: `tools/nodered_push.cmd`.

## 4. Manager (`manager/`)

- A Node server (`:5180`) plus a React web app. The browser talks only to the Manager, and the Manager talks to the boards.
- Covers discovery, fleet health, per-device screens, SoftAP setup, IP and Wi-Fi changes, firmware updates, and backups.
- `package.json` depends on `file:../nodered/node-red-contrib-de-esp32`, so it needs the whole repo checked out.
- Device payload types: `manager/server/src/types/device-api.ts`. Run it without a board: `npm run fake`, plus `npm run dev -- --wifi-adapter fake`.
- Releases: a `manager-v<version>` tag builds a Node zip and a Windows portable exe.

## When something changes

Each feature has a firmware doc plus a Node-RED and a Manager sister doc with the same name ([FEATURES_README.md](FEATURES_README.md)). Change the firmware, then walk its two sister docs: they list the exact fields each part uses.

| You change | Also check |
|---|---|
| A firmware command or `/api/v1` payload | The feature's three docs, `device-api.ts` and the fake (`manager/server/fake/`), the Node-RED nodes |
| `nodered/.../lib/` | The Manager (CI rebuilds it) |
| Partition offsets | `install/manifest.json` |
| A firmware build | Restage `install/firmware/` (CI does this on `main`) |

## CI and the pre-push check

| Workflow | Runs on | Does |
|---|---|---|
| `build.yml` | PRs, non-main pushes | Firmware build in the ESP-IDF image, Python spec tests |
| `install.yml` | Push to `main` | Rebuilds the installer images, deploys Pages |
| `manager.yml` | `manager/` or `nodered/lib` changes | `npm ci`, lint, typecheck, build, smoke start; release on a tag |

Before pushing:

```
node tools/precheck.mjs
```

It checks the Node-RED, installer and Manager parts in about a minute. Specifically:
- lockfiles match `package.json` (otherwise `npm ci` fails)
- the Node-RED files parse
- the installer images exist and fit `ota_0`
- the Manager passes lint, typecheck and build, and starts
- it warns about untracked files that CI won't see
- every feature has its firmware, Node-RED and Manager docs

It does not build the firmware; CI does that.
