# de-esp32 Manager — specification (phase 1: spec + screen design)

Status: **approved; implementation has started (batch 1 = M0–M3 done; batch 2 = M4–M8, the first usable version; batch 3 = M4b, M8b, M9–M11 done against fake devices; batch 4 = L1, M12, M13, M14 plus loose ends, also only against fake devices, see the batch 4 notes).** Static prototypes live in `manager/proto/`; the server and web app are being built under `manager/`. The user's amendments below override the body of this document.
Scope of this document: what the Manager is, the exact device API it builds on (verified against the C++ source on `main` @ `9dcba89`), the server and frontend design, folder layout, CI outline, packaging, a phased build plan, and open questions.

Source references are written as `file:line` (paths relative to the repo root). "Verified" means read in the source; "unverified" means inferred or documented elsewhere but not traced in code.

> **Moving target.** While this was being written, uncommitted firmware work appeared in the working tree (on-device UI gzip/ETag serving, `io_delivery`, shared event-bus frames). Line numbers below are for committed `9dcba89` and may have shifted. Those changes are additive for the Manager: `GET /status` gains `sinks: {ws, mqtt, serial, rules}`; MQTT status gains `backlog`, `backlogs`, `io_dropped`, `outbox`; `pin.configure` and `module.add` accept an optional `delivery: "reliable" | "latest"` (MQTT backpressure; error "delivery must be reliable or latest"). The `mqtt/reconfigure` WS leak (§12 #1) is still present there. Re-verify §2 against `main` before M1.

> **Second moving target.** Firmware branch `claude/wifi-change-fallback-ab5ac7` (unmerged, uncompiled, untested on hardware) adds `wifi_change`, static IP commands, extra network status fields and a lost-network recovery SoftAP. Its shapes are transcribed in §2.9 and are **feature-detected**: current firmware has none of them.

---

## Amendments (approved by the user)

These override the body of the document; the sections they touch have been edited to agree (superseded text is struck through with a pointer).

1. **API-first backend.** The Manager server exposes one simple, documented REST API plus the browser WebSocket, and it is the **only** path to a device: the SPA, Electron, scripts and `curl` all use the same endpoints, and no frontend code talks to a device directly. Every device function gets a backend endpoint as its milestone arrives. `GET /api/openapi.json` is an OpenAPI document generated from the same route table the router registers (so it cannot drift), and `manager/API.md` carries working `curl` examples for every endpoint. Explicit, readable endpoints are preferred where they help (e.g. `POST /api/devices/:id/command` `{cmd, ...}`); the generic `/api/devices/:id/v1/*` passthrough stays. → §3 intro, §3.9.
2. **Network accessible.** The Manager is reachable from other machines on the LAN. Localhost stays the default bind, with the Host/Origin checks of §3.1. LAN mode is first-class: one `--lan` flag (later a Settings toggle); the LAN URL and token are printed clearly at start-up and returned by `GET /api/access` for the Settings screen; the token is accepted as `Authorization: Bearer <token>`, as `?token=` on the first page load (exchanged for an HttpOnly cookie), and as that cookie. A loopback request that passes the localhost checks needs no token even in LAN mode. → §1 goal 4, §3.1, §4.4 Settings, §9 M12 (shrinks to the Settings toggle and token rotate, because LAN mode ships in M0), §11 Q6 (answered).
3. **UI stack and polish.** The UI runs on a PC: no size frugality. Vite + React + TypeScript, plain CSS tokens from `manager/proto/tokens.css`, `motion` (imported from `motion/react`) for transitions, `lucide-react` icons, Radix UI primitives (dialog, dropdown-menu, tabs, tooltip, switch, slider), React Router. Respect `prefers-reduced-motion`. The device header must not wrap badly at narrow widths. → §4 intro, §4.1 (the old "inline SVG, no icon fonts" line becomes lucide-react; "no web fonts" stays).
4. **"Move device to another network" is out of v1.** It returns later as milestone L1, gated on firmware `wifi_change` (§2.9, §9). → §1 Later, §2.7 item 1, §4.4 Network screen, §11 Q4 (answered).

Also approved by the user, recorded as milestones rather than amendments: SoftAP setup and recovery (§3.11, **M4b**), per-device IP settings with DHCP default and optional static IP (§3.12, **M8b**), and the pending-firmware shapes they rely on (§2.9).

## Implementation notes (batch 1)

Deviations made while building M0–M3:

- **React 19** (not 18) and **react-router v8** (declarative API), as installed.
- The Manager's own OpenAPI document is **3.1.0**, because TypeBox emits JSON Schema 2020-12. (The device's `/openapi.json` stays 3.0.3, §2.2.)
- **TypeBox** defines the route schemas and does request/response validation.
- Server tests run TypeScript through **tsx** with **node:test**; web tests use **vitest**.
- `--allow-origin <origin>` CLI flag (repeatable) admits the Vite dev origin to the Origin check.
- Error envelope for every Manager error: `{error, code, details?}`.
- Plain `GET /api/ws` (no Upgrade) answers **426**; a missing built SPA answers a **503** help page.
- esbuild keeps `mqtt` **external** (a dependency of the shared Node-RED lib that the Manager never uses).
- **M2.** Health state `unknown` added ("not polled since server start"). Attention flag `host_mismatch` added (a different id answers at the stored host). Browser WS message `{t:"deviceRemoved", id}` added; browser `cmd` messages get a failed `cmdResult` until M5. The registry `last` cache holds every field the summary needs, so the summary rebuilds from the registry while offline; the summary also carries `notes`, `addedVia`, `addedAt` and `queue` (pending device requests = "device busy"). `fwMatchesTarget` is `null` until M9. Transport failures on `/command` and `/v1/*` are HTTP 502 `{ok:false, error, code, transport:true}`; bodies over 1536 B are refused locally (413). Idempotent GETs are retried once after a stale keep-alive reset. The REST proxy, per-device queue and `POST /api/devices/:id/command` shipped here rather than in M5. Settings: `pollIntervalS` via `GET/PUT /api/settings` (the LAN token is never exposed there; it is in `GET /api/access`).
- **M3.** Results require an HTTP `/status` answer that passes `isOurs`; mDNS TXT-only entries are not listed (TXT is kept on the result). Every scan also probes registry hosts and `discoveryTargets` (settings) / `targets` (request), so fake devices on loopback ports and moved devices are found without mDNS. Subnets wider than /24 are clamped to the /24 of the given address. Discovery probes bypass the per-device queue. Added `POST /api/discovery/adopt {ids}` (`addedVia` = `mdns`, `sweep`, or `manual` for typed targets). Background scan exists but is **off by default** (§11 Q7 open). `waitForDevice(id, {timeoutMs, ...})` is the library call M4b needs. Real mDNS and a real /24 sweep have not been run (no board available; tests inject interfaces and an mDNS fake).

## Implementation notes (batch 2: M4–M8, first usable version)

- **M5 device link** (`server/src/device/link.ts`, `app.links`): one device socket per watched device, `io.hydrate` on open, `live` snapshot after the burst, backoff 1 s → 30 s (immediate reconnect when the poller sees the device again), closed 10 s after the last watcher, "full" after 20 s without an event frame. Browser WS gained `link`, `live`, `io`, `event` (to watchers only) and working `cmd` (contract in `manager/API.md`). Deviations: the **health poller keeps running while a device is watched** (spec 3.4 says skip); while the link is `full` or `connecting` the server polls `GET /pins` every **5 s** (spec said 30 s) and synthesises `io` messages, so the UI has one path; `mqtt/reconfigure` is dropped and never logged. Add-on `io` frames carry the bare instance id (`env0`) while the state key is `mod_env0`; both server and web map it. `network.wifi.set`/`scan` and the restart commands always use HTTP even when the link is open. After any successful `pin.configure` / `module.*` change the server pushes a fresh `live` snapshot (keys can disappear).
- **New endpoint** `GET /api/devices/:id/pin-config`: per configured GPIO the minimal `pin.configure` object, from the pin shadow when its mode matches the live mode, else derived from live state (`source: shadow|live`). The pin shadow is updated on every command path (REST, passthrough, WS).
- **Web**: shared UI kit in `web/src/components/ui` (Sheet, Dialog/ConfirmDialog with type-to-confirm, Toast, Tabs, form fields, Segmented, Slider, Skeleton, Banner, AnimatedNumber, Pulse, ...); data layer in `web/src/api` (devices store, ref-counted watch, live store, commands, a per-device "config version" so every section re-reads hardware / pin-config / add-ons / rules after a config change made anywhere).
- Scope decisions for this batch: Network tab is read-only for Wi-Fi (no move, scan or "Forget Wi-Fi"); firmware update, backup and "Update"/"Back up" actions are present but disabled ("Coming next"); the "Firmware differs" stat and filter are inert until M9.

## Implementation notes (batch 3: M4b, M8b, M9, M10, M11)

- **Safety flags.** `--no-network-scan` hard-disables mDNS and subnet sweeps everywhere (UI scans, background scan, `waitForDevice`); typed targets, settings targets and registry hosts are still probed; `GET /api/health` and the discovery state report `networkScan`, Discover shows a banner and the scan button becomes "Check addresses". `--wifi-adapter fake|system|none` (default `system`: `netsh` on Windows, otherwise none). `npm run dev` defaults to `--no-network-scan --wifi-adapter fake` (opt out with `--network-scan` / `--wifi-adapter system`). Dev-only flags: `--fake-ap <ssid>=<host:port>[,secured=<pw>][,lan=<host:port>]` (with the fake adapter) and `--ip-change-map <ip>=<host:port>`; the fake device gained `--ap-mode`.
- **One job contract** for every long operation (`server/src/types/api-jobs.ts`, `server/src/jobs/`, `manager/API.md` "Jobs"): `Job {id, kind: setup|ip-change|ota|backup-apply, title, state: queued|running|paused|cancelling|succeeded|failed|partial|cancelled, steps[], progress, message, deviceIds, devices[], params, result, error {code, message, step}, actions, timestamps}`; `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/{cancel,pause,resume,retry}`; WS `{t:"job", job}` (throttled 150 ms, final state immediate). In memory only, last 50 finished kept (the `jobs.json` history of §3.7 is not written; a restart forgets job history). `params` is sanitised of secret-looking keys. Web: `useJob`/`useJobs` and one `JobProgress` component for all kinds.
- **M4b SoftAP setup** (§3.11). Routes: `GET /api/setup/adapter`, `GET /api/setup/aps`, `POST /api/setup/jobs`, `POST /api/setup/jobs/:id/wifi` (the job waits in a `choose` step with the device's own scan when no network was given; 180 s), `GET /api/setup/recovery`, `POST /api/setup/recovery/{restore,dismiss}`. Crash marker `setup-recovery.json` (no password) is reported at start-up; nothing is switched automatically. Temporary profiles are named `de-esp32-setup-*` and the adapter refuses to add/delete any other name. Passwords live only in the job closure (test asserts they reach no API output, WS message, data file or log). Shutdown waits up to 25 s so a running job can put the PC's Wi-Fi back. Verified with the fake adapter and fake devices only; **the `netsh` path has only been tested against captured output and has never connected anything**.
- **M8b static IP** (§3.12). `GET /api/devices/:id/ip`, `POST /api/devices/:id/ip/check` (rules + warnings: outside this PC's subnets, address used by another registry device), `POST /api/devices/:id/ip` (job; `network.ip.set` is sent synchronously so device refusals are a 409). Loopback fakes cannot move: when the stored host is loopback the device is reached at the same host:port and the registry host is kept; `--ip-change-map` maps an address to a reachable or closed port to exercise confirm and revert. A failed reach ends the job `failed` / `not_reachable_new_address` immediately (the device reverts on its own after 90 s; the job does not wait for that). `ip_mode` added to the summary; Fleet table shows a DHCP/Static chip.
- **M9/M10 firmware.** Store `firmware/<sha256>.bin` + index; parser verified against the CI image (`install/firmware/de_esp32_runtime.bin`: `1bf09cc`, `de_esp32_runtime`, IDF v5.4.2); image checksum/SHA footer not checked. Routes: `GET/POST /api/firmware`, `POST /api/firmware/latest` (base URL setting `firmwareBaseUrl`), `DELETE /api/firmware/:fid`, `PUT /api/firmware/target` (drives `fwMatchesTarget`: same `app_version` + compile date/time), `POST /api/devices/:id/ota`, `POST /api/devices/:id/rollback`, `POST /api/firmware/update` (bulk; concurrency 1-4, pause after N failures, cancel aborts the upload, retry = new job with the failed devices). Push only; the device-pull mode of §3.7 is not implemented. `health` reads `updating` during a job.
- **M11 backups.** As §3.8, with a separate dry run: `POST /api/backups/:bid/plan` and `POST /api/clone/plan`, then `.../apply` / `POST /api/clone` (jobs). Steps that would collide are listed as conflicts and skipped; a backup without add-on/rule lists never wipes the target's; MQTT restore sends only `uri`/`root`, so the target keeps its login; a backup cannot switch MQTT off. Restore includes the name by default, clone does not.

## Implementation notes (batch 4: L1, M12, M13, M14, loose ends)

- **M12 Settings + LAN.** Settings screen (`/settings`): poll interval, background scan on/off + period, extra discovery targets and subnets, `firmwareBaseUrl`, `defaultParallelUpdates` (new setting, 1-4, default 2; the Firmware screen starts from it), theme (browser-local, same state as the nav toggle), LAN access, data folder (read-only), about. Not built: "keep fleet live" and "default OTA mode" (no such settings exist; push is the only OTA mode).
  - **LAN access switches at runtime.** `PUT /api/access {enabled}` closes the listening socket and listens again on the same port (`0.0.0.0` or `127.0.0.1`); if the new listen fails the old one is restored and the call answers 409 `rebind_failed`. Open loopback connections survive; switching off destroys every non-local HTTP socket and closes non-local browser WebSockets (close code 4001). Persisted as `lanEnabled`; effective LAN at start = `--lan` OR `lanEnabled`. Unavailable (409 `lan_unavailable`) with `StartOptions.lanToggle: false` (Electron; a saved `lanEnabled` is then ignored) or an explicit `--host` that is neither loopback nor a wildcard.
  - `POST /api/access/token` regenerates the token: the old token and every cookie carrying it are rejected, non-local WebSockets are closed, a remote caller gets the new cookie. `GET /api/access` gained `tokenMasked`, `openUrl`, `remote`, `toggleAvailable`, `toggleUnavailableReason`; the token is only returned to the local user or a caller holding it. `GET /api/health` gained `startedAt`. Browser WS message `{t:"access", lan}` added.
  - Hardening: constant-time compare on every path; LAN mode without a token refuses every non-local request; `?token=` is accepted only on page GETs and stripped by the 302; cookie `HttpOnly; SameSite=Strict; Path=/; Max-Age` 30 days, no `Secure` (plain http); the WS upgrade uses the same check; more than 10 wrong tokens per address in 60 s give 429 `too_many_attempts` with `Retry-After` (missing tokens are not counted, the local user is exempt, at most 1000 addresses tracked; a browser holding a stale cookie after a rotation can trip it for up to 60 s). The router no longer logs query strings; the token is printed only in the start-up banner on stdout.
- **L1 Wi-Fi move** (`server/src/wifimove/`, job kind `wifi-move`): `GET /api/devices/:id/wifi`, `POST /api/devices/:id/wifi/check`, `POST /api/devices/:id/wifi` (202 job, optional `timeoutS`). Feature-detected on `wifi_change`. Outcomes: failed and restored at the old address (job error code = the firmware reason: `auth`, `no_ap`, `no_ip`, `timeout`, `connect_failed`, `save_failed`, else `wifi_failed`; `device_refused` for an immediate refusal), found again by id via `waitForDevice` (registry host updated; `staticIpReset` reported), or `not_found` with recovery advice. No retry: the password lives only in the job closure (a test searches API output, WS frames, data files and logs for it). The warning "this PC is on another network" uses the PC's Wi-Fi adapter. Fake: `--wifi-move <ssid>=<host:port>`, password `wrong-password` gives `auth`, special SSIDs give the other reasons.
- **Jobs** are persisted to `<dataDir>/jobs.json` (bounded by the keep limit, secrets stripped again on write; a corrupt file is moved aside). A job unfinished at load gets the new terminal state **`interrupted`**; restored jobs have no actions and retry answers 409 `job_action_unavailable`. This replaces the "in memory only" note of batch 3.
- **Health polling** pauses while a device is watched, its link is `open` and frames keep arriving (§3.4); live frames keep `lastSeen` and the cached summary fresh; polling resumes at once when the link stops being live. This removes the batch 2 deviation.
- **netsh**: commands run as `cmd /d /s /c "chcp 65001>nul & netsh ..."` when every argument is free of cmd syntax; output is decoded as UTF-8 when valid, else with the OEM code page (from `reg query`, then `chcp`; built-in tables for 437, 850 and other DOS code pages, latin1 fallback). Parsing tries English labels first, then label-independent structure (signal percentages, line order). Tested with captured byte samples only; never run against real `netsh`.
- **Restore/clone**: neither includes the device name by default any more; `include.name: true` opts in ("Also copy the device name"; the plan shows the name line).
- **Change IP failure**: when the device is not reached at the new address the job waits in a visible `revert` step with a countdown and polls the old address, then ends `failed` with `reverted` (device back, nothing changed) or `not_reachable`; `not_reachable_new_address` is gone.
- **Device page** no longer remounts its tab (closing dialogs) when a device returns from a restart; `revalidateDevice(id)` re-reads data in place. **Fleet table** fits 1280 px with the nav expanded (fixed layout; columns hide by container width: Uptime < 1240 px, RSSI < 1050, Memory < 910, MQTT < 780).
- **M13 CI** `.github/workflows/manager.yml`: `check` (Node 22 and 24: `npm ci` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, lint, typecheck incl. electron, test, build, smoke start + `GET /api/health`, dist artifact) and on `manager-v*` tags: tag = version check, Node zip, Windows portable exe, `gh release create` with SHA256SUMS. Parsed and structure-checked only; never run on GitHub.
- **M14 Electron** (`manager/electron/`, `scripts/electron.mjs`, `electron/electron-builder.yml`): server in-process on 127.0.0.1:0 with `lanToggle: false`, sandboxed window, single-instance lock, only the Manager origin stays in-app (http(s) links open in the browser), graceful quit awaits `close()` up to 25 s. Test overrides: `DE_ESP32_MANAGER_DATA_DIR` (also moves Electron's userData), `DE_ESP32_MANAGER_WIFI_ADAPTER`, `DE_ESP32_MANAGER_NO_NETWORK_SCAN=1`, `DE_ESP32_MANAGER_READY_FILE`. The app is staged outside `manager/` with a dependency-free package.json, so no node_modules is shipped. Portable exe 102.7 MB (over the 90 MB target), unsigned, default icon, no exe metadata (`signAndEditExecutable: false`).

---

## 1. Goals and non-goals

### Goals

1. **Find every board on the LAN** (mDNS + `/24` HTTP sweep + manual IP), remember them, and show fleet health at a glance: online/offline, firmware, uptime, memory pressure, Wi-Fi RSSI, MQTT, safe mode, pending OTA.
2. **Do everything the device API allows, per device**: live I/O with manual control, pin configuration on a DevKitC pinout, add-ons (MFRC522, BME280), on-device rules, Wi-Fi / SoftAP password / MQTT, rename, logs, telemetry and memory, OTA (upload, pull-by-URL, rollback), reboot, factory reset.
3. **Fleet operations a single-device UI cannot do**: bulk firmware update with per-device progress, one-click "update to latest CI build" (GitHub Pages), configuration backup / restore / clone between devices.
4. **Local and private by default, reachable on the LAN on purpose** (Amendment 2): a Node server bound to `127.0.0.1` by default; one `--lan` flag makes it reachable from other LAN machines behind an access token; no cloud, no account.
5. **Runs anywhere Node 22+ runs**: `npx`/`node` opens the browser; Electron is an optional thin shell around the same server.

### Non-goals (v1)

- Replacing the on-device UI (`web/`) or the Node-RED palette (`nodered/`). Both stay as they are.
- Flashing over USB / first install (the browser installer in `install/` does that). The Manager links to it.
- ~~Provisioning boards that are only reachable on their own SoftAP (`192.168.4.1`) — v1 *detects and explains* them, but does not hop Wi-Fi networks.~~ Superseded: **M4b** (§3.11, batch 2) joins the device's SoftAP to set up or recover it and then restores the PC's network. Until M4b, boards in setup mode are only detected and explained.
- MQTT as a transport for control. The Manager talks HTTP/WS to devices. (MQTT-based discovery is a "later" item.)
- Authentication on the devices (firmware has none; see `components/security/security_README.md`).
- Dashboards/history storage (time-series), alerting, scheduling, multi-user.
- Non-DevKitC boards. The API is board-profile driven (`/hardware.header`), so the pinout renders whatever the device reports, but only `esp32-devkitc` is tested.

### Later (named so we don't pretend they exist)

**"Move device to another network" (L1, §9)**: out of v1 (Amendment 4), gated on firmware `wifi_change` (§2.9). Telemetry history sparklines persisted on disk; MQTT discovery (`{root}/+/api`, already in `nodered/.../lib/discover.js` `mqttDiscover`); staged rollouts ("canary 1 device, then the rest"); scheduled updates; device groups/tags as bulk-action targets; config templates ("profiles"); diff between two devices; macOS/Linux packaged builds; auto-update of the Manager itself; upstreaming the `/24` sweep into the Node-RED lib.

---

## 2. Device API inventory (verified)

Base: `http://<ip>/api/v1`, port 80, **no authentication, no TLS**. All JSON responses set `Cache-Control: no-store` (`components/web_server/src/web_server.cpp:43`). **Only `/openapi.json` sends `Access-Control-Allow-Origin: *`** (`web_server.cpp:510`); every other route is same-origin only — this is why the Manager needs a server.

### 2.1 Transport facts that shape the Manager

| Fact | Source | Consequence for the Manager |
|---|---|---|
| ESP-IDF httpd is a **single task**; long handlers block every other request to that device. `network.wifi.set` blocks up to 20 s, `network/scan` up to 8 s, `POST /ota` for the whole upload. | `command_router.cpp:377`, `network_manager.cpp:327`, `web_server.cpp:212` | Per-device request queue, concurrency 1, per-call timeouts. UI shows "device busy" instead of piling up requests. |
| JSON request bodies **> 1536 bytes are rejected** with 400 `json` (also empty bodies). | `web_server.cpp:83` | Keep bodies small; for anything near the limit send the command over the device WebSocket (no size cap there). |
| `max_open_sockets = 13`, LRU purge on. | `web_server.cpp:519-521` | Use HTTP keep-alive with at most 1–2 sockets per device. |
| **WebSocket: max 4 clients.** A 5th connection is accepted at the HTTP level but silently **not registered** — it gets no events and no error. | `web_server.cpp:277-297` | Server holds **at most one** WS per device and multiplexes. Detect "WS full" as: open socket + no frame (not even 15 s telemetry) within 20 s → mark `ws: "full"`, fall back to polling. |
| WS events are only produced while `live_viewers() > 0`, and **every** event-bus topic is forwarded (prefix `""`). | `web_server.cpp:391-406, 543` | One WS gives io, net, ota progress, rename and the 15 s telemetry snapshot. |
| WS frames in are JSON commands (same as `/command`); the reply is sent back on the same socket, `corr` echoed. | `web_server.cpp:350-389`, `command_router.cpp:31-55` | Optional command path with no body-size cap. |
| `system.reboot` / `system.factory_reset` call `esp_restart()` **before** the HTTP response is written. | `command_router.cpp:480-490` | Treat a reset/timeout on these calls as "accepted", then poll `/status` until back. |
| `POST /ota` replies, then reboots 800 ms later. | `web_server.cpp:245-251`, `ota_manager.cpp:384-387` | Same "expect a restart" handling. |
| Unknown GETs return **302 to `http://192.168.4.1/`** (captive portal), not 404. | `web_server.cpp:71-79` | Fingerprinting must not treat a redirect as success. |
| **The `mqtt/reconfigure` event, forwarded to all WS clients, contains the full `mqtt.configure` request — including `password`.** | `command_router.cpp:456-457`, `web_server.cpp:391` | Server must drop/redact `mqtt/reconfigure` frames before fan-out and never log them. (Firmware bug; see §12.) |

Response envelope for every command (`command_router.cpp:31-55`):

```json
{ "v": 1, "ok": true,  "corr": "<echoed if sent>", "result": { } }
{ "v": 1, "ok": false, "corr": "<echoed if sent>", "error": "message" }
```

`result` is omitted when a command has nothing to return (`system.*`, `ota.rollback`). Errors are short strings (≤ 95 chars); there are no error codes.

### 2.2 HTTP routes (`kRoutes`, `web_server.cpp:417-438`)

| Method + path | Body | Response (verified shape) |
|---|---|---|
| `GET /status` | — | **Telemetry snapshot** (below) **plus** `name`, `topic_id`, `hostname`, `mac`, `chip`, `chip_info`, `ap_ssid`, `schema`, `generation`, `safe_reason` (`web_server.cpp:105-118`) |
| `GET /telemetry` | — | Telemetry snapshot only (`telemetry.cpp:21-41`) |
| `GET /hardware` | — | Board profile + `chip`, `chip_info`, `pins[]` (capabilities + live `owner`) (`web_server.cpp:126-139`) |
| `GET /pins` | — | Live I/O state map (`state_snapshot()`, `state_registry.cpp:109`) — same as `status.io` |
| `POST /pins` | pin object, or any command | If no `cmd` key, `cmd: "pin.configure"` is added and **the whole body is the pin** (`web_server.cpp:141-155`) |
| `POST /command` | `{cmd, ...}` | Command envelope |
| `GET /network` | — | Network status (below) |
| `GET /network/scan` | — | **Bare array** (not an envelope) of up to 24 APs `{ssid, rssi, channel, auth}`; blocks ≤ 8 s (`network_manager.cpp:317-346`). `auth` is the numeric `wifi_auth_mode_t` (0 = open). |
| `POST /network/wifi` | `{ssid, password}` | `network.wifi.set` envelope |
| `GET /mqtt` | — | MQTT status (below) |
| `POST /mqtt` | `{uri?, user?, password?, root?}` | `mqtt.configure` envelope |
| `GET /logs` | — | `{lines: string[]}` — RAM ring, **80 lines × 159 chars**, oldest first, raw ESP-IDF log text incl. ANSI colour codes if enabled (`logging_service.cpp:16-78`) |
| `GET /ota` | — | OTA status (below) |
| `POST /ota` | **raw image bytes**, `Content-Length` required | `{v:1, ok:true, result:<OTA status>}` then reboot; or `{v:1, ok:false, error}` (`web_server.cpp:212-252`) |
| `POST /system/reboot` | (ignored) | Usually no response (device resets first) |
| `POST /system/factory_reset` | (ignored) | Usually no response. Erases NVS user config (Wi-Fi, pins, add-ons, rules, MQTT, name, AP password) and reboots → **device leaves the LAN and comes back as an open SoftAP** |
| `GET /ws` | WebSocket | see §2.6 |
| `GET /openapi.json` | — | OpenAPI 3.0.3 with `x-commands` (= `kCmds`), `x-mqtt` `{root, prefix, topics[]}`, `x-discovery` `{mdns, service:"_http._tcp", de_service:"_de-esp32._tcp", board, port:80}`. CORS `*`. |
| `GET /`, `/index.html` | — | Embedded UI (the Manager links to it as "Open device page") |

### 2.3 Payload shapes

**Telemetry snapshot** (`telemetry.cpp:21-41`; `GET /telemetry`, the base of `GET /status`, and the WS `telemetry` topic every 15 s):

```jsonc
{
  "v": 1,
  "id": "a4cf12b3c4d5",          // MAC hex, 12 chars — the stable device key
  "fw": "0.1.0",                 // RUNTIME_VERSION — a hard-coded constant, see §12
  "uptime_s": 5231,
  "boot_count": 12,
  "reset_reason": 1,             // numeric esp_reset_reason_t
  "heap_free": 151200,
  "heap_min": 118400,
  "memory": {                    // runtime_core/src/memory_budget.cpp:176
    "pressure": "ok",            // ok | warn | critical
    "alloc_failed": false, "alloc_failed_size": 0, "reserve": 24576,
    "internal": { "total": 327200, "min": 118400, "used": 176000, "free": 151200, "largest": 90112 },
    "dma": { "free": 140000, "largest": 86016 },
    "psram": null,
    "boot": [ { "stage": "identity", "free": 290000, "largest": 110592 } ],   // ≤ 8
    "tasks": [ { "name": "httpd", "stack_min": 2412 } ],                      // ≤ 24, refreshed ≤ every 5 s
    "tasks_truncated": false
  },
  "boot_state": "healthy",       // boot|diagnostics|identity|config|capability|safe_pins|network|provisioning|management|mqtt|components|healthy|safe_mode|unknown
  "safe_mode": false,
  "network": { /* network status */ },
  "mqtt":    { /* mqtt status */ },
  "ota":     { /* ota status */ },
  "io":      { /* live I/O map, §2.4 */ }
}
```

Added by `GET /status` only: `name` (falls back to hostname when unset), `topic_id`, `hostname` (`esp32-xxxxxx`, last 3 MAC bytes), `mac` (`aa:bb:..`), `chip` (`"ESP32 rev3"`), `chip_info` `{model, revision, cores, features: ["wifi","bt","ble","emb_flash","psram"]}`, `ap_ssid` (= hostname), `schema` (config schema, 4), `generation`, `safe_reason`.

Not in status (unverified elsewhere): there is no `board` field in `/status` even though `nodered/.../lib/fingerprint.js:36` reads one; board id comes from `/hardware.board_id`, mDNS TXT `board`, or `openapi.x-discovery.board`.

**Network status** (`network_manager.cpp:348-360`):

```json
{ "state": "sta_connected", "sta_ip": "192.168.1.42", "ap_ip": "192.168.4.1", "ap_ssid": "esp32-b3c4d5",
  "ap_open": true, "hostname": "esp32-b3c4d5", "rssi": -58, "provisioned": true, "sta_connected": true }
```

`state` ∈ `idle | ap_only | sta_connecting | sta_connected | apsta_recovery` (`network_manager.cpp:212-226`). **The saved SSID is not exposed anywhere.** `rssi` is sampled at connect time, not live (`network_manager.cpp:116-119`).

Pending firmware (§2.9, branch `claude/wifi-change-fallback-ab5ac7`, unmerged) adds optional fields to this object: `wifi_change`, `ip_mode`, `netmask`, `gateway`, `dns`, `ap_clients`, `ip_change`. They are absent on current firmware: feature-detect.

**MQTT status** (`mqtt_manager.cpp:333-358`):

```json
{ "connected": true, "uri": "mqtt://192.168.1.10:1883", "reconnects": 1, "published": 1840, "publish_fail": 0,
  "received": 3, "last_error": "", "root": "devices", "prefix": "devices/workshop_node", "topic_id": "workshop_node",
  "sub": ["system/command","config/set","components/+/set"], "pub": ["availability","status","telemetry","io","events","api"] }
```

`uri` is the in-RAM value, empty when MQTT never started. MQTT user/password are **not** readable.

**OTA status** (`ota_manager.cpp:427-483`):

```json
{ "fw": "0.1.0", "idf": "v5.4.2", "app_version": "9dcba89", "project": "de_esp32_runtime",
  "compile_date": "Nov 10 2026", "compile_time": "09:12:44",
  "running_partition": "ota_0", "running_offset": 65536, "running_size": 1835008, "image_state": "valid",
  "next_partition": "ota_1", "next_size": 1835008, "rollback_possible": true,
  "busy": false, "session": "idle", "bytes": 0, "total": 0, "percent": 0,
  "last_error": "…", "incoming_version": "…", "incoming_project": "…" }
```

`image_state` ∈ `new | pending_verify | valid | invalid | aborted | undefined`; `session` ∈ `idle | writing | fetching | rebooting | error`. `last_error`, `incoming_*` present only when set. (Offsets/sizes above are illustrative.)

**Hardware** (`web_server.cpp:126-139`, `board_profiles.cpp:99-126`, `capability_manager.cpp:152-182`):

```jsonc
{
  "board_id": "esp32-devkitc", "board_name": "ESP32-WROOM-32 DevKitC",
  "status_led_gpio": 2, "status_led_active_high": true, "boot_gpio": 0,
  "header": {
    "usb": "bottom",
    "left":  [ { "i": 0, "silk": "3V3", "kind": "power", "gpio": null }, { "i": 2, "silk": "VP", "kind": "gpio", "gpio": 36 }, ... ],   // 19 pads
    "right": [ { "i": 0, "silk": "GND", "kind": "gnd",   "gpio": null }, { "i": 1, "silk": "23", "kind": "gpio", "gpio": 23 }, ... ]    // 19 pads
  },
  "buses": [ { "id": "vspi", "kind": "spi", "label": "VSPI", "hint": "…", "pins": { "sck": 18, "miso": 19, "mosi": 23, "ss": 5 } },
             { "id": "hspi", ... }, { "id": "i2c0", "kind": "i2c", "pins": { "sda": 21, "scl": 22 } }, { "id": "uart0", ... }, { "id": "uart2", ... } ],
  "chip": "ESP32 rev3", "chip_info": { "model": "ESP32", "revision": 3, "cores": 2, "features": ["wifi","bt","ble"] },
  "pins": [ { "gpio": 4, "flags": 123, "input": true, "output": true, "pull": true, "pwm": true, "adc1": false, "adc2": true,
              "touch": true, "dac": false, "strap": false, "flash": false, "input_only": false, "status_led": false, "boot_btn": false,
              "adc_channel": 0, "touch_channel": 0, "role": "", "notes": "general I/O", "owner": "" }, ... ]
}
```

Pad `kind` ∈ `gpio | power | gnd | en`. Left header top→bottom: 3V3, EN, VP(36), VN(39), 34, 35, 32, 33, 25, 26, 27, 14, 12, GND, 13, D2(9), D3(10), CMD(11), 5V. Right: GND, 23, 22, TXD(1), RXD(3), 21, GND, 19, 18, 5, 17, 16, 4, 0, 2, 15, D1(8), D0(7), CLK(6). `owner` strings seen in code: `""`, `gpio_N`, `adc_N`, `pwm_N`, `servo_N`, `mod_<id>`, `bus_…` (`nodered/.../lib/pins.js:14-30`; the exact `bus_` names are unverified).

Mode legality (`capability_manager.cpp:102-150`): flash pins (6–11) reject everything; `out|pwm|servo` need `output` and not `input_only` (pwm/servo also need `pwm`); `in` needs `input`; `adc` needs `adc1` and is rejected on ADC2 pins ("ADC2 cannot be used while Wi-Fi is on"). Pins owned by `mod_*`/`bus_*` cannot be reconfigured; a `servo_*` owner may only be retargeted as servo.

### 2.4 Live I/O map (`status.io`, `GET /pins`, WS `io/*`)

Object keyed by state key; up to **48 keys** total (`state_registry.cpp:15`). Shapes (verified at the publishing call sites):

| Key | Shape | Source |
|---|---|---|
| `gpio_N` | `{id:"gpio_N", mode:"in"\|"out", gpio, level:0\|1, debounce_ms?}` (`debounce_ms` only for `in`) | `io_gpio.cpp:38-52` |
| `adc_N` | `{id, mode:"adc", gpio, mv, raw, sample_ms, hysteresis_mv, smooth}` | `io_adc.cpp:65-81` |
| `pwm_N` | `{id, mode:"pwm", gpio, hz, duty}` (duty 0–1000) | `io_pwm.cpp:42-54` |
| `servo_N` | `{id, mode:"servo", gpio, angle, pulse_us, min_us, max_us, hz:50}` | `io_servo.cpp:94-110` |
| `mod_<id>` (bme280) | `{id, type:"bme280", ok, addr, t_c?, p_hpa?, rh?}` (readings only when `ok`) | `mod_bme280.cpp:317-334` |
| `mod_<id>` (mfrc522) | `{id, type:"mfrc522", present, uid, version, tx}` (`uid` uppercase hex, `""` when absent) | `mod_mfrc522.cpp:385-392` |

Live state does **not** include `name`, `invert`, `pull_up`, `pull_down`, or `boot` for GPIO pins, and disabled pins are absent.

### 2.5 Command catalog (`kCmds`, `command_router.cpp:232-274`; dispatch `:336-605`)

All via `POST /command` (or WS, or MQTT `{prefix}/system/command`). `v`/`corr` are optional on input and `corr` is echoed.

| Command | Request (beyond `cmd`) | `result` on success | Notable errors / behaviour |
|---|---|---|---|
| `pin.configure` | `pin: {gpio, mode, ...}` (or fields at top level) | the pin object as applied (defaults clamped in) | Modes: `disabled`, `out`, `in`, `pwm`, `servo`, `adc`. `out`/`in`: `pull_up`, `pull_down`, `invert` (bool), `boot` (0/1 initial level), `irq` (default true for `in`), `debounce_ms` (`in`, 0–500, default 50). `pwm`: `hz` (default 1000, clamped 50–20000), `duty` (0–1000). `servo`: `angle` 0–180 (90), `min_us` 500–1500 (500), `max_us` 1500–2500 (2500). `adc`: `sample_ms` 20–1000 (50), `hysteresis_mv` 5–500 (20), `smooth` 0–90 (70). "unknown mode", capability errors (§2.3). **The whole pin object is persisted verbatim** (any extra keys such as `name` too) into the 2 KB `io.pins` blob. |
| `pin.set` | `gpio`, `value`, `mode` (`out` default \| `pwm` \| `servo`) | `{gpio, value}` | `out`: level; `pwm`: duty 0–1000; `servo`: angle 0–180. Error is the raw `esp_err_to_name` string (e.g. `ESP_ERR_INVALID_STATE` when the pin is not in that mode). Not persisted. |
| `io.hydrate` | — | `{pins: n}` | Re-emits every I/O and module key on the event bus (useful right after the Manager's WS connects). |
| `module.catalog` | — | `{types:[{type, label, summary, bus:"spi"\|"i2c", default_bus, id_prefix, max_instances, pins:[{role, required, share:"bus"\|"instance", cap:"in"\|"out"}], settings:[{key, label, kind:"int"\|"enum", def, min?, max?, choices?:[{value,label}]}]}]}` | `module_manager.cpp:474-523` |
| `module.list` | — | `{v:1, modules:[{id, type, bus, enabled, pins:{role:gpio}, settings?, state?}]}` | `state` = live `mod_<id>` value. This is the **persisted** config — full fidelity. |
| `module.add` | `type`, `id?` (auto `id_prefix`+n), `bus?`, `pins`, `settings?`, `enabled?` (or nested under `module`) | same as `module.list` | id must match `[a-z][a-z0-9_]{0,15}`; "id already in use"; "`<type>` limited to N instances" (bme280 2, mfrc522 4); bus `vspi\|hspi` / `i2c0\|i2c1`; "pin X required"; "module pins must be unique"; shared bus pins must match; CS unique per SPI bus; I²C addr unique per bus; memory admission "need N bytes, largest L, free F". Applied immediately, persisted in a 2 KB blob. |
| `module.configure` | `id` + any of `bus`, `pins`, `settings`, `enabled` | same as `module.list` | Missing fields inherit. Rolls back to the old instance if apply fails. `enabled:false` tears down but keeps the instance. |
| `module.remove` | `id` | same as `module.list` | "unknown module id" |
| `module.cmd` | `id`, … | type-specific | **Both current types return "module has no commands".** No UI for it in v1. |
| `rule.set` | `rule: {id?, enabled?, on:{gpio, op, value}, then:{gpio, value}, else?:{gpio, value}}` | `{v:1, rules:[…]}` | `op` ∈ `gt ge lt le eq ne` (also `> >= < <= == !=`). ADC compares `mv`, digital compares `level`. **Max 8 rules**, `id` ≤ 7 chars (default `r<src>`), upsert by id then by source GPIO (one rule per source). `then.gpio`/`else.gpio` ≠ `on.gpio`. A destination that is not `out`/`pwm`/`servo` makes the rule inert (accepted, logs a warning). |
| `rule.remove` | `id` or `gpio` | `{v:1, rules:[…]}` | "rule not found" |
| `rule.list` | — | `{v:1, rules:[{id, enabled, on, then, else?}]}` | `io_rules.cpp:570-580` |
| `network.wifi.set` | `ssid`, `password` | network status + `mdns` | Tests the network for up to 20 s **before** saving; "wifi test failed; credentials not saved". **See §2.7 — dangerous from the LAN.** |
| `network.wifi.scan` | — | array of APs (same as `GET /network/scan`) | blocks ≤ 8 s |
| `network.wifi.clear` | — | network status | Forgets STA creds and drops to SoftAP — **device leaves the LAN immediately.** |
| `network.recovery_ap` | — | network status | Brings up the SoftAP alongside STA. |
| `network.ap.set_password` | `password` (`""` = open, else 8–63 chars) | network status | "AP password must be empty (open) or 8-63 characters" |
| `mqtt.configure` | `uri?`, `user?`+`password?` (only written when `user` is a string), `root?` | `{uri, root}` | "uri required (mqtt://host:1883)" when neither new nor saved. **Always sets `mqtt.enabled = 1`; there is no way to disable MQTT once configured** (§12). `root` is sanitised to `[A-Za-z0-9_-/]`, default `devices`. Reconnects immediately and retires retained topics under the old prefix. |
| `identity.set_name` | `name` (≤ 31 chars; defaults to hostname if missing) | `{name, topic_id, id}` | `topic_id` = name with spaces/dots → `_`, other chars dropped. Changes MQTT topics and the mDNS instance/TXT `name`. |
| `system.reboot` | — | (none; device resets) | |
| `system.factory_reset` | — | (none; device resets) | |
| `ota.apply` | `url` (`http://` or `https://`, < 384 chars; HTTPS uses the IDF cert bundle) | OTA status + `note` | "ota busy", "url must be http:// or https://". Device fetches in the background, publishes `ota/progress`, reboots when written. Needs the device to reach the URL (internet for GitHub Pages). |
| `ota.rollback` | — | (none; device reboots) | "ota busy", "no valid previous slot" |
| `serial.hello` / `serial.bye` | — | identity / `{session:false}` | UART-session helpers; **not used by the Manager** (they toggle a serial live-sink flag). |

### 2.6 WebSocket `/api/v1/ws`

- **Out (device → client)**: `{"topic": "<bus topic>", "data": {…}}` for every event-bus publish while at least one WS client is registered.
  - `io/gpio`, `io/adc`, `io/pwm`, `io/servo` — the §2.4 shapes. `io/adc` only when the filtered value moves by `hysteresis_mv`.
  - `io/env` (BME280), `io/rfid` (MFRC522) — the §2.4 module shapes.
  - `telemetry` — full telemetry snapshot every 15 s (`telemetry.cpp:43-51`).
  - `net` — `{state, sta_ip}` on every network state change (`network_manager.cpp:78-85`).
  - `ota/progress` — `{session, bytes, total, percent, error?}`, every 64 KB and on state changes (`ota_manager.cpp:70-94`).
  - `identity/rename` — `{old_topic_id, topic_id, name}`.
  - `mqtt/reconfigure` — **the raw `mqtt.configure` request incl. password + `old_root`. Must be dropped by the Manager server.**
- **In (client → device)**: any command object; the reply envelope comes back on the same socket.
- No ping/heartbeat from the device; the 15 s `telemetry` frame is the liveness signal.

### 2.7 Behaviours the UI must respect

1. **Changing Wi-Fi from the LAN is a one-way trip.** `network.wifi.set` disconnects the current STA link to test the new one (`network_manager.cpp:255-283`), so the HTTP request that triggered it usually dies. On success the device joins the new network (maybe a new subnet / IP, possibly unreachable from the Manager) and keeps the SoftAP up until reboot (`s_want_ap = true`, state shows `apsta_recovery`). On failure it **does not reconnect to the old network**; it sits in `apsta_recovery` with the SoftAP up until a reboot/power-cycle restores the saved (old) credentials. ~~The Manager frames this as "Move device to another network", requires typing the device name to confirm, then watches for the device id to reappear (rescan by MAC id).~~ Superseded by Amendment 4: the Manager does **not** offer Wi-Fi changes from the LAN in v1 (the Network screen has no such control; `network.wifi.set` is still reachable through the generic command endpoint). The feature returns as milestone L1, only for devices reporting `wifi_change` (§2.9), whose firmware restores the old network on failure. Over the setup AP, Wi-Fi credentials are sent by the M4b setup job (§3.11), which is a different, supervised path.
2. `network.wifi.clear` and `system.factory_reset` remove the device from the LAN. Confirm with explicit copy: "It will reappear as Wi-Fi network `esp32-xxxxxx`."
3. **PWM frequency is global.** All PWM channels share `LEDC_TIMER_0` (`io_pwm.cpp:96-111`), so configuring any PWM pin with a new `hz` changes every PWM pin; other pins' `pwm_N.hz` in state are not refreshed (stale until their next publish). UI: "Frequency (shared by all PWM pins)".
4. **Back-to-back OTA is blocked until the new image is marked valid** ("running image still pending verify", `ota_manager.cpp:179-186`). Bulk update waits for `ota.image_state == "valid"` / `boot_state == "healthy"` before declaring success and before any second update on that device.
5. OTA images are checked on-device: ESP32 magic/chip, and `project_name == de_esp32_runtime` (`ota_manager.cpp` `finish_locked`). The Manager pre-checks the same before uploading.
6. The `io.pins` blob is 2 KB. Because the full pin object is persisted, **the Manager must send minimal pin objects** (only `gpio`, `mode`, and non-default options; no `name`, no `cmd`). Note: `persist_pin` re-reads the blob into a 2 KB buffer and starts from empty on read failure, so an over-size blob could silently drop other pins (`command_router.cpp:57-98`; behaviour of `config_get_blob` on over-size unverified).
7. `pin.set` is not persisted; the next boot uses `boot` (out) / `duty` (pwm) / `angle` (servo) from `pin.configure`.
8. Rules only fire on changes of the source pin; an inert rule (dest not an output) is accepted silently. The rules UI validates destinations client-side against live state.
9. `GET /network/scan` stalls the device for several seconds; only run it on explicit user action.

### 2.8 What a config backup can and cannot capture (no export endpoint exists)

| Item | Read from | Fidelity |
|---|---|---|
| Add-ons | `module.list` | Full (persisted config) |
| Rules | `rule.list` | Full |
| Pins | `status.io` | **Partial**: mode + PWM `hz`/`duty`, servo `angle`/`min_us`/`max_us`, ADC tuning, input `debounce_ms`. **Missing:** `invert`, `pull_up`, `pull_down`, `boot`, `irq`, `name`. |
| Device name | `status.name` | Ambiguous: equals hostname when unset |
| MQTT | `status.mqtt.uri`, `.root` | URI + root only; **no user/password** |
| Wi-Fi, AP password | — | **Not readable** (only `network.ap_open`) |

Mitigation in v1: the Manager keeps a **pin shadow** — the last `pin.configure` payload it successfully sent per device+GPIO — in the registry, and prefers it over live state when building a backup. Backups record per-field provenance (`live` / `shadow`) so restore can warn about gaps. A firmware `config.export` command is the proper fix (§12).

### 2.9 Pending firmware (branch `claude/wifi-change-fallback-ab5ac7`, unmerged, untested on hardware)

Source: `components/network_manager/network_manager_README.md` on that branch (sections "Safe Wi-Fi change", "Lost network", "Static IP"; read with `git show claude/wifi-change-fallback-ab5ac7:components/network_manager/network_manager_README.md`, no checkout needed), plus the relayed notes. The branch is **uncompiled and untested on hardware**, so every shape below is the firmware author's description, not an observed response. Where the README and the relayed notes differ, this section follows the README (differences listed at the end).

**Rule: feature-detect everything.** `ip_mode` and `wifi_change` are absent on current firmware (`main`). The Manager shows or enables a feature only when the device reports the field, and treats unknown enum values as "unknown", not as an error. Types: `server/src/types/device-api.ts` (`WifiChange`, `IpChange`, `NetworkIpSetCommand`, `NetworkIpConfirmCommand`, all optional).

**`wifi_change`** on `GET /network` and `status.network`: the outcome of the last `network.wifi.set`. RAM only, lost on reboot. Only `result` is present while it is `none`. Compare `seq` before and after an attempt to tell it from an older one.

| Field | Meaning |
|---|---|
| `result` | `none` (no change since boot) · `testing` · `ok` (connected and saved) · `failed` |
| `ssid` | SSID that was tried (never the password) |
| `reason` | when failed: `auth` (wrong password) · `no_ap` (SSID not found) · `no_ip` (associated, no DHCP lease) · `timeout` · `connect_failed` · `save_failed` (connected but the NVS write failed; a reboot returns to the old network) |
| `disconnect_reason` | last raw `wifi_err_reason_t`, 0 if none |
| `restored_previous` | true when the STA was pointed back at the saved network (the reconnect may still be pending) |
| `uptime_s` / `time` | when the result was recorded; `time` is Unix seconds, 0 until SNTP has set the clock |
| `seq` | attempts since boot |

Safe-change behaviour: the saved network stays in NVS until the new one has associated **and** got a DHCP lease; the test runs up to 20 s; on failure the STA is pointed back at the saved network at once and the error reply is not delayed; only one test runs at a time. If a client is on the SoftAP when the test fails (setup over `192.168.4.1`), only the saved config is put back and the reconnect waits for the background retry, so the client can still read `wifi_change` at `http://192.168.4.1/api/v1/network`. With no saved network (first-time provisioning) there is nothing to go back to and the SoftAP stays up. A change to another subnet succeeds and the caller loses the device: expected; find it again by mDNS or on the new network.

**Static IP commands** (via `POST /api/v1/command`, WS, MQTT or serial; reply `{v:1, ok:true, result:<network status>}` or `{v:1, ok:false, error}`):

```json
{"cmd":"network.ip.set","mode":"static","ip":"192.168.1.50","netmask":"255.255.255.0","gateway":"192.168.1.1","dns":"1.1.1.1"}
{"cmd":"network.ip.set","mode":"dhcp"}
{"cmd":"network.ip.confirm","seq":3}
```

`dns` is optional and defaults to the gateway. `seq` on confirm is optional; when given it must match `ip_change.seq`.

**Apply, confirm or revert:**

1. `network.ip.set` replies first (`ip_change.result` `pending`, `applied` false). About **1.5 s** later the device applies the new config.
2. The client must reach the device **at the new address** and send `network.ip.confirm` within **90 s** (`ip_change.confirm_left_s` counts down). Only then is the config written to NVS. A confirm sent before the change has been applied is refused, so it cannot be confirmed over the old address.
3. With no confirm the previous mode is restored: `result` `reverted`, `reason` `not_confirmed`. A switch to DHCP confirms itself when a lease arrives (`reason` `dhcp_lease`) and reverts with `no_dhcp_lease` if none comes.
4. Power loss before the confirm boots with the previous mode (nothing was saved).
5. Switching to DHCP while the STA is offline is saved at once (`reason` `offline`): nothing to confirm against.
6. A confirm is accepted from any transport once the new config is applied (over the LAN it can only arrive at the new address; serial, the SoftAP, or MQTT through a broker reached on the new address are accepted too).

**New network status fields:** `ip_mode` (`dhcp` | `static`, what the STA uses now), `netmask`, `gateway`, `dns` (live values, `""` while not connected), `ap_clients` (clients on the SoftAP), and `ip_change`:

| Field | Meaning |
|---|---|
| `result` | `none` · `pending` · `ok` · `reverted` · `reset` · `failed` |
| `reason` | `confirmed` · `dhcp_lease` · `offline` · `not_confirmed` · `no_dhcp_lease` · `wifi_change` · `save_failed` |
| `mode`, `ip`, `netmask`, `gateway`, `dns` | the config that was tried (address fields only for static) |
| `applied` | true while the change is live and waiting for a confirm |
| `confirm_left_s` | seconds left to confirm (only while `applied`) |
| `uptime_s`, `time`, `seq` | as in `wifi_change` |

`ip_change` is RAM only. The README does not say which fields accompany `result: "none"` (for `wifi_change` it is `result` alone); treat every field other than `result` as optional.

**Device-side validation** (`parse_ip4`, `validate_static`; the UI mirrors it, §4.4 Network): strict dotted quads (no leading zeros); a contiguous netmask from /1 to /30; `ip` and `gateway` are unicast hosts in the same subnet, different from each other, and neither is the network or broadcast address; the subnet must not overlap `192.168.4.0/24` (the SoftAP); `dns` must be unicast. The device **refuses** when: there is no saved Wi-Fi network, a Wi-Fi change test is running, another IP change is still pending, or (static only) the STA is not connected.

**Wi-Fi changes and IP mode:** every Wi-Fi credential change (and factory reset and `network.wifi.clear`) goes back to DHCP: on success `ip_change.result` is `reset`, `reason` `wifi_change`, when a static config was dropped; starting a Wi-Fi test also cancels an unconfirmed IP change (`reverted`, `wifi_change`). A **failed** Wi-Fi change restores the old network together with its saved IP mode, static included.

**Lost network and the recovery SoftAP** (`net_watch`, `CONFIG_RUNTIME_WIFI_FAIL_AP_MS`, default 60000): with saved credentials the device raises its SoftAP once the STA has been down for **60 s** (measured from the drop, or from boot). It then retries the saved network (8 fast retries, then one attempt every **30 s**) but **pauses the retries while any client is on the SoftAP**, because a successful join moves the SoftAP's channel and would drop that client. When the router is back the SoftAP stays up for **60 s** after the STA gets an IP and the AP has **no clients**, then drops. Saved credentials are never cleared by any of this. The recovery SoftAP is **open unless an AP password is set** (`network.ap.set_password`), so anyone in range can reach the API while the home network is down; `ap_clients` shows how many are connected. Manager consequences: an offline device may be recoverable over its setup AP (M4b), and a setup job must leave the SoftAP promptly (§3.11).

**README vs. relayed notes, differences found:** (a) the notes say the device refuses when "the station is not connected"; the README refuses only a *static* IP then, a switch to DHCP while offline is accepted and saved at once (`offline`). (b) The static-IP feature note says the confirm window is "roughly 60 to 120 s"; the README fixes it at 90 s (`kIpConfirmMs`). (c) The README adds details absent from the notes: `dns` defaults to the gateway, `ip_change.reason` `dhcp_lease`/`no_dhcp_lease` semantics, confirm accepted from any transport, and the 8-fast-retries-then-30-s retry schedule. Nothing contradicts otherwise.

---

## 3. Server design

Node.js ≥ 20, TypeScript, built with esbuild to a single `dist/server.cjs`. Runtime deps kept tiny: `ws`, `multicast-dns` (plus the shared package, §6). HTTP via `node:http` with a ~150-line router (no Express needed); if that grows, Fastify is the fallback.

**API-first (Amendment 1).** The server is the product's API: one simple REST surface under `/api` plus the browser WebSocket `/api/ws`, and it is the only path to a device. The SPA, the Electron shell, scripts and `curl` call the same endpoints; no frontend code ever contacts a device directly. Each device function gets a backend endpoint in the milestone that introduces it. The route table is the single source of truth: the router registers routes from it and `GET /api/openapi.json` (OpenAPI 3.1, generated from the same table) is derived from it, so documentation cannot drift. `manager/API.md` documents every endpoint with a working `curl` example. Readable, explicit endpoints are preferred where they help (e.g. `POST /api/devices/:id/command` with `{cmd, ...}`), and the generic `/api/devices/:id/v1/*` passthrough (§3.5) stays for anything without a dedicated endpoint.

### 3.1 Process and CLI

```
de-esp32-manager [--port 5180] [--host 127.0.0.1] [--lan] [--allow-origin <origin>]... [--data-dir <path>] [--no-open]
```

- Default bind `127.0.0.1:5180`; opens the default browser at `http://localhost:5180/` unless `--no-open`. `--allow-origin` (repeatable) adds an origin to the Origin allow-list (the Vite dev server).
- **Localhost mode** defends against DNS rebinding / drive-by CSRF: reject requests whose `Host` is not `localhost|127.0.0.1|[::1]:<port>`, and reject mutating requests and WS upgrades whose `Origin` is present and not same-origin.
- **LAN mode is first-class (Amendment 2).** One flag, `--lan`, binds `0.0.0.0` and **requires an access token**: generated on the first `--lan` start and stored in `settings.json` (never created in localhost mode). At start-up the server prints the LAN URL(s) and the token clearly, e.g. `http://192.168.1.20:5180/?token=…`; the same information is available from `GET /api/access` for the Settings screen (exact shape in `manager/API.md`). A token is accepted as `Authorization: Bearer <token>`, as `?token=` on the first page load (exchanged for an HttpOnly cookie), and as that cookie (also for the WS upgrade). **A loopback request that passes the localhost checks above needs no token even in LAN mode**, so the Manager PC's own browser and Electron keep working unchanged. The Origin check for mutating requests and WS upgrades stays in LAN mode. Later (M12) the same switch is a Settings toggle with token rotate; the CLI flag stays.
- Data dir: `%APPDATA%\de-esp32-manager` (Windows), `~/Library/Application Support/de-esp32-manager`, `$XDG_CONFIG_HOME/de-esp32-manager`. Contents: `registry.json`, `settings.json`, `backups/*.json`, `firmware/*.bin` + `firmware/index.json`, `manager.log`.
- Writes are atomic (write temp + rename). Registry is loaded once and saved debounced (1 s).

### 3.2 Registry file (`registry.json`)

```jsonc
{
  "v": 1,
  "devices": [
    {
      "id": "a4cf12b3c4d5",            // MAC hex (status.id) — primary key
      "host": "192.168.1.42",          // last good address (IP preferred over .local)
      "hostname": "esp32-b3c4d5",
      "name": "Workshop node",          // last seen status.name
      "label": "",                      // manager-only display override (optional)
      "notes": "",                      // manager-only free text
      "addedAt": "2026-11-10T09:12:00Z",
      "addedVia": "mdns" ,              // mdns | sweep | manual
      "lastSeen": "2026-11-10T10:02:11Z",
      "last": {                         // cached last summary so the fleet renders instantly when offline
        "fw": "0.1.0", "app_version": "9dcba89", "compile_date": "Nov 10 2026",
        "boot_state": "healthy", "safe_mode": false, "uptime_s": 5231,
        "rssi": -58, "pressure": "ok", "mqtt_connected": true, "running_partition": "ota_0", "image_state": "valid"
      },
      "pinShadow": { "4": { "gpio": 4, "mode": "out", "invert": true, "boot": 1 } }
    }
  ],
  "ignored": ["c8f09e112233"]           // discovered ids the user dismissed
}
```

### 3.3 Discovery

Runs on demand ("Scan") and on a slow background timer (default every 5 min, off by default when > 50 devices).

1. **mDNS** (2.5 s): query `_de-esp32._tcp.local` and `_http._tcp.local` PTR; collect A records; prefer answers whose TXT looks like ours (`api=/api/v1`, `id` 12 chars, `board=esp32*`) — logic from `nodered/.../lib/discover.js` (`parseTxt`, `looksLikeOursTxt`). TXT gives `id`, `name`, `fw`, `board` before any HTTP call.
2. **/24 sweep** of every local IPv4 interface (skip loopback, link-local, and interfaces > /24 are clamped to their /24): `GET /api/v1/status` with 800 ms timeout, concurrency 48 (port of `tools/discover.py` `find_devices`; the Node-RED lib has **no** sweep). Redirects are not followed.
3. **Fingerprint** with `fingerprint.isOurs()` (`ota.project == "de_esp32_runtime"` or hostname `esp32-*` or ESP32 chip + 12-char id), summarise with `fingerprint.summarize()`, merge by `id` (`discover.mergeDevice`).
4. **Classify** each result: `known` (in registry → update host/lastSeen; **IP change is followed automatically by id**), `new` (not in registry, not ignored), `ignored`. Devices whose `network.state` is `ap_only`/`apsta_recovery` are flagged "in setup / recovery".
5. Progress is streamed over the SPA WS (`scan` messages) — phase, hosts probed / total, found count.

Manual add: `POST /api/devices {host}` probes `/status` (2 s), fingerprints, adds. Accepts IP, `host:port`, or `name.local` (resolved by the OS).

SoftAP devices: the Manager cannot see a board on `192.168.4.1` unless the PC is joined to its SoftAP; if the PC's own interface is `192.168.4.x`, the sweep naturally finds it and the UI labels it "Setup AP — connect it to Wi-Fi from its own page". (Until M4b: link only; M4b, §3.11, adds the guided setup that joins the SoftAP itself.) The discovery module exposes a library call **"wait for device id X on the LAN, with a timeout"** (probe by id via mDNS + sweep until found or timed out), which the M4b setup job and later jobs (M8b IP change, L1) use; the device client (§3.5) accepts an optional `localAddress` to bind its sockets to a specific local interface.

### 3.4 Health polling

- Every registered device: `GET /status` every 30 s (configurable 10–300 s), 2 s timeout, via the per-device queue. Skipped while the device is *watched* (WS open and telemetry frames arriving).
- States: `online` (last poll ok), `unreachable` (1 failure), `offline` (≥ 2 consecutive failures or > 2 intervals since lastSeen), `rebooting` (manager-initiated restart window, up to 60 s), `updating` (OTA job running).
- **Attention** flags derived from the summary: `safe_mode`, `boot_state != healthy`, `memory.pressure != ok`, `memory.alloc_failed`, `ota.image_state == pending_verify`, `ota.session == error`, MQTT configured (`mqtt.uri` non-empty) but not connected, `network.state == apsta_recovery`, firmware differs from the selected target.

### 3.5 Device proxy

`/api/devices/:id/v1/*` → `http://<host>/api/v1/*` for `GET` and JSON `POST`. Rules:

- Per-device FIFO queue, concurrency 1, default timeout 5 s; 25 s for `network/wifi` and `network.wifi.set`; 12 s for `network/scan`/`network.wifi.scan`.
- `POST /ota` is **not** proxied (use §3.7). `system/reboot`, `system/factory_reset`, `system.reboot`, `system.factory_reset`, `ota.rollback`: a socket reset/timeout is mapped to `{ok:true, result:{expectedRestart:true}}` and the device enters `rebooting`.
- Bodies > 1536 bytes are refused locally with a clear error (never sent).
- Successful `pin.configure` responses update `pinShadow`. Successful `identity.set_name` updates the registry name.
- Responses are passed through unchanged (status code + JSON), wrapped only on transport failure: `{ok:false, error:"device unreachable", transport:true}`.

### 3.6 WebSocket fan-in

**Device side**: at most **one** `ws` client per device, opened only while ≥ 1 browser subscriber *watches* that device (plus an optional "keep fleet live" setting that watches all, capped at 16 devices). On open: send `{"cmd":"io.hydrate","corr":"mgr-hydrate"}` to get a fresh I/O burst. Reconnect with backoff 1 s → 30 s. Closed 10 s after the last watcher leaves. "Full" detection as in §2.1. Frames with `topic == "mqtt/reconfigure"` are dropped.

**Browser side**: one WS at `/api/ws` (same-origin, token cookie when `--lan`). JSON messages:

Client → server

```jsonc
{ "t": "watch",   "ids": ["a4cf12b3c4d5"] }   // replaces the watch set for this socket
{ "t": "cmd",     "id": "a4cf12b3c4d5", "corr": "c-17", "body": { "cmd": "pin.set", "gpio": 4, "value": 1 } }  // sent over the device WS (no 1536 B limit); reply as "cmdResult"
```

Server → client

```jsonc
{ "t": "hello",      "server": { "version": "0.1.0", "lan": false } }
{ "t": "device",     "id": "…", "summary": { /* registry entry + live health, §4.2 */ } }   // on any health change
{ "t": "devices",    "list": [ /* full list */ ] }                                         // on connect
{ "t": "link",       "id": "…", "ws": "open|connecting|closed|full" }
{ "t": "io",         "id": "…", "topic": "io/gpio", "data": { … } }
{ "t": "event",      "id": "…", "topic": "net|ota/progress|identity/rename|telemetry", "data": { … } }
{ "t": "cmdResult",  "id": "…", "corr": "c-17", "res": { "v":1, "ok":true, "result":{…} } }
{ "t": "scan",       "phase": "mdns|sweep|done", "probed": 120, "total": 254, "found": [ … ] }
{ "t": "job",        "job": { /* §3.7 job object */ } }
```

### 3.7 Firmware and OTA

**Firmware sources**

- *Latest CI build*: `https://terraseraph.github.io/esp32-joat/firmware/de_esp32_runtime.bin` (published by `.github/workflows/install.yml`, Pages root = `install/`). Also fetch `…/manifest.json` (only `name`/`chipFamily`/`parts`; **it has no version**). The base URL is a setting.
- *Local file*: uploaded by the user (drag-drop `.bin`).

Every image is stored once in `firmware/<sha256>.bin` and indexed with metadata parsed from the image: header magic `0xE9`; `esp_app_desc_t` at byte offset 32 (magic `0xABCD5432`, `version` at +16 [32 B], `project_name` at +48 [32 B], `time` +80, `date` +96, `idf_ver` +112) — standard ESP-IDF v5 layout, **to be verified with a fixture built from this repo**. Reject if `project_name != "de_esp32_runtime"`, magic wrong, chip id not ESP32, or size > the device's `ota.next_size`.

**Version comparison**: `status.fw` is the constant `RUNTIME_VERSION "0.1.0"` (`runtime_version.hpp`) and does not change between builds, so the Manager compares **`ota.app_version`** (IDF `PROJECT_VER`, which defaults to `git describe`) plus `compile_date`/`compile_time` against the image descriptor. Result is `same` / `different` (not newer/older — git hashes are unordered). UI shows "Up to date" / "Differs from target".

**Single-device update** (`POST /api/devices/:id/ota {firmwareId}`): pre-checks (online, `ota.busy == false`, `image_state != pending_verify`, size fits) → stream the file with `Content-Length` to `POST /api/v1/ota` (Manager-pushed, works without device internet access; ~1.2–1.6 MB over Wi-Fi). Progress = bytes written to the socket + device `ota/progress` if watched. Then expect restart → poll `/status` every 2 s up to 120 s → success when reachable, `ota.app_version` matches the image and `image_state == "valid"` (allow `pending_verify` → `valid` transition up to 60 s). If the device comes back on the *old* `running_partition` with the old version → `rolled_back`.

Alternative path offered per job: **device pull** via `ota.apply {url}` with the Pages URL (device needs internet; fewer bytes through the Manager). Default: push.

**Bulk update job** (`POST /api/jobs/ota {deviceIds, firmwareId, mode:"push"|"pull", concurrency:1..4 (default 2), stopOnFailures: 1}`):

Per-device states: `queued → checking → uploading (pct) → rebooting → verifying → done` or `skipped` (already same version / offline / busy) / `failed (stage, error)` / `rolled_back` / `cancelled`. Job states: `running | paused | done | cancelled`; the job pauses automatically after `stopOnFailures` failures. Cancel stops starting new devices; an in-flight upload is aborted (device aborts the write on connection loss: `ota_abort_write`). Jobs live in memory and are summarised into `jobs.json` on finish (history of last 20).

### 3.8 Backup / restore / clone

**Backup file** (`backups/<id>-<timestamp>.json`, also downloadable):

```jsonc
{
  "kind": "de-esp32-backup", "v": 1,
  "createdAt": "2026-11-10T10:00:00Z", "manager": "0.1.0",
  "source": { "id": "a4cf12b3c4d5", "name": "Workshop node", "app_version": "9dcba89", "board_id": "esp32-devkitc" },
  "name": "Workshop node",
  "pins": [ { "gpio": 4, "mode": "out", "invert": true, "boot": 1, "_from": "shadow" },
            { "gpio": 34, "mode": "adc", "sample_ms": 50, "hysteresis_mv": 20, "smooth": 70, "_from": "live" } ],
  "modules": [ { "id": "env0", "type": "bme280", "bus": "i2c0", "enabled": true, "pins": { "sda": 21, "scl": 22 }, "settings": { "addr": 118, "sample_ms": 1000, "osrs_t": 1, "osrs_p": 1, "osrs_h": 1, "filter": 0, "mode": "normal" } } ],
  "rules": [ { "id": "r32", "enabled": true, "on": { "gpio": 32, "op": "gt", "value": 1000 }, "then": { "gpio": 18, "value": 1 }, "else": { "gpio": 18, "value": 0 } } ],
  "mqtt": { "uri": "mqtt://192.168.1.10:1883", "root": "devices" },
  "gaps": [ "wifi", "ap_password", "mqtt_credentials", "pin:13:invert/pull" ]
}
```

**Restore / clone** (`POST /api/backups/:bid/apply {targetIds, include:{pins, modules, rules, mqtt, name}, dryRun}`):

1. Dry run builds a per-target **plan** by reading the target's `status`, `module.list`, `rule.list` and diffing: pins to configure / disable, modules to remove / add, rules to remove / set, MQTT change, name change. Conflicts are reported (e.g. backup pin owned by an existing add-on on the target that isn't being removed).
2. Apply order (dependencies): remove rules → remove add-ons not in backup → disable pins not in backup → `pin.configure` each pin → `module.add` (or `module.configure` when same id+type) → `rule.set` each → `mqtt.configure` (only if included; MQTT creds are never in a backup, so the user may type them) → `identity.set_name` (restore only; clone defaults to off).
3. Each step is one command; failures stop that target and are shown with the step. No device-side transactions exist — a partial apply is possible and is reported as such.

Clone = restore a fresh in-memory backup of device A onto targets B…N with `name` excluded by default.

### 3.9 Server REST API (for the SPA)

All under `/api`, JSON.

| Method + path | Purpose |
|---|---|
| `GET /api/health` | `{version, lan, dataDir, uptime}` |
| `GET /api/openapi.json` | OpenAPI 3.1 document of this API, generated from the router's own route table (Amendment 1) |
| `GET /api/access` | LAN access info for the Settings screen: whether LAN mode is on, the LAN URL(s) and the token (Amendment 2; shape in `manager/API.md`) |
| `GET /api/devices` | registry + live health (summary objects) |
| `GET /api/devices/:id` | one summary object (§3.10) |
| `POST /api/devices` `{host}` | manual add (probe + fingerprint) → summary or `{error}` |
| `PATCH /api/devices/:id` `{label?, notes?, host?}` | manager-only metadata / pin a host |
| `DELETE /api/devices/:id` | forget (does not touch the device) |
| `POST /api/devices/:id/refresh` | poll now |
| `POST /api/devices/:id/command` `{cmd, ...}` | explicit command endpoint: sends one device command (same envelope and queue as the proxy, §3.5) and returns the device's `{v, ok, result|error}` envelope |
| `GET|POST /api/devices/:id/v1/*` | generic device proxy (§3.5) |
| `POST /api/devices/:id/ota` `{firmwareId, mode}` | single-device update (creates a 1-device job) |
| `POST /api/discovery/scan` `{mdns?, sweep?, subnets?}` | start scan; progress over WS |
| `GET /api/discovery` | last scan result, running flag |
| `POST /api/discovery/cancel` | stop a running scan (results so far are kept) |
| `POST /api/discovery/ignore` `{id}` · `DELETE /api/discovery/ignore/:id` | hide / un-hide a found device |
| `GET /api/firmware` | cached images + `latest` (remote metadata, fetched-at) |
| `POST /api/firmware/latest` | download/refresh the Pages image |
| `POST /api/firmware` (raw `application/octet-stream`, `X-Filename`) | upload a local `.bin` → parsed metadata or rejection reason |
| `DELETE /api/firmware/:fid` | remove cached image |
| `POST /api/jobs/ota` · `GET /api/jobs` · `GET /api/jobs/:jid` · `POST /api/jobs/:jid/{pause,resume,cancel}` · `POST /api/jobs/:jid/retry-failed` | bulk OTA |
| `GET /api/backups` · `POST /api/devices/:id/backup` · `GET /api/backups/:bid` (download) · `POST /api/backups/import` · `DELETE /api/backups/:bid` | backups |
| `POST /api/backups/:bid/apply` `{targetIds, include, dryRun}` · `POST /api/clone` `{sourceId, targetIds, include, dryRun}` | restore / clone |
| `GET /api/settings` · `PUT /api/settings` | app settings |
| `GET /api/ws` | browser WebSocket (§3.6) |
| *(M4b, §3.11; paths proposed, fixed at implementation)* `GET /api/wifi/adapter` · `GET /api/setup/aps` · `POST /api/setup/jobs` · `GET /api/setup/jobs` · `GET /api/setup/jobs/:jid` · `POST /api/setup/jobs/:jid/cancel` · `POST /api/setup/jobs/:jid/restore` | Wi-Fi adapter status, nearby device APs, SoftAP setup/recovery job |
| *(M8b, §3.12; proposed)* `GET /api/devices/:id/ip` · `POST /api/devices/:id/ip` (starts a "Change IP" job) · `GET /api/jobs/:jid` | per-device IP mode and the change job |

All of these are listed in `/api/openapi.json` and `manager/API.md` with `curl` examples as their milestone lands.

### 3.10 Summary object (what the SPA renders for a device)

```jsonc
{
  "id": "a4cf12b3c4d5", "name": "Workshop node", "label": "", "hostname": "esp32-b3c4d5", "host": "192.168.1.42",
  "health": "online",                      // online | unreachable | offline | rebooting | updating
  "attention": ["mqtt_disconnected"],       // §3.4 flags
  "lastSeen": "2026-11-10T10:02:11Z",
  "fw": "0.1.0", "app_version": "9dcba89", "compile_date": "Nov 10 2026", "fwMatchesTarget": true,
  "uptime_s": 5231, "boot_state": "healthy", "safe_mode": false, "safe_reason": "",
  "rssi": -58, "net_state": "sta_connected", "mqtt": { "configured": true, "connected": false },
  "memory": { "pressure": "ok", "free": 151200, "total": 327200 },
  "ota": { "running_partition": "ota_0", "image_state": "valid", "rollback_possible": true, "busy": false },
  "io_count": 7, "module_count": 2,
  "link": "closed",                          // device WS state
  "ip_mode": "dhcp"                          // OPTIONAL (§2.9): absent when the device does not report it; M8b adds netmask/gateway/dns
}
```

### 3.11 SoftAP setup and recovery (M4b, after the first usable version)

Requested by the user: a board that is not on any network (never provisioned, after a factory reset or `network.wifi.clear`, or whose Wi-Fi is gone) is only reachable on its own SoftAP (`esp32-<last6>`, `192.168.4.1`). The Manager can switch the PC's Wi-Fi to that SoftAP, put the board on the user's network, and switch back, "similar to how some smart devices work". Also covers the "reset it and put it on our own network" case. Implementation is **batch 2**, after M3 discovery and the M4 Discover screen. API-first (Amendment 1): everything below is an endpoint in `/api/openapi.json` and `manager/API.md`.

**Wi-Fi adapter service** for the host PC, behind an interface (`server/src/wifi/adapter.ts`):

- Windows: `netsh wlan` (show interfaces, show networks, add a **temporary profile**, connect, delete that profile). macOS/Linux adapters come later.
- Anything else (no Wi-Fi adapter, Ethernet-only PC, non-Windows OS) reports **"not supported on this machine"** cleanly; the endpoints still exist and answer with that status, and the UI hides or disables the feature with the reason.

**Endpoints** (paths proposed in §3.9): adapter status; list nearby device access points (SSIDs matching `esp32-<last6>`, open or secured); start, inspect (poll or via the WS `job` message) and cancel a setup job; restore the original network after a crash.

**Setup job state machine** (`jobs/setupJob.ts`; the adapter is injected so it can be faked):

1. Remember the PC's current Wi-Fi network (and persist that fact to disk for crash recovery).
2. Join the device AP (ask for the AP password only if the AP is secured).
3. Wait for `192.168.4.1`; fingerprint the device with `GET /api/v1/status`.
4. Optionally pick the target network from the device's own `GET /api/v1/network/scan`.
5. Optional **factory reset first** (the "reset it" case), then `POST /api/v1/network/wifi` with the new credentials.
6. **Before leaving the AP, read `wifi_change` at `192.168.4.1`** (pending firmware, §2.9; absent on current firmware) and compare its `seq` with the value read before step 5 to tell this attempt from an older one; this explains a failure ("wrong password", "network not found") instead of guessing. Then **leave the SoftAP promptly** (rejoin the PC's original network) so the device can retry its saved network: it pauses retries while a client is on its SoftAP.
7. Wait for the device on the LAN via discovery ("wait for device id X on the LAN, with timeout", §3.3), matched by id.
8. Add it to the registry.

**Always restore the PC's original network**: on failure, on cancel, on server shutdown. If the server crashed mid-job, the persisted job record is detected on the next start and the UI offers to restore (adapter: reconnect the remembered network). Every temporary Wi-Fi profile the job created is removed (also on the restore path).

**Network side effects, and what the user must be told before starting:**

- While on the device AP the PC is **off the LAN**. A browser on the same PC keeps working (localhost). A **remote browser in LAN mode loses the server**; warn before starting. The job runs to completion server-side and its result stays readable afterwards.
- A PC with **Ethernet and Wi-Fi** keeps its LAN; sockets for `192.168.4.1` are bound to the Wi-Fi adapter's local address (device client `localAddress`, §3.3/§3.5) so traffic does not leave via Ethernet.
- The user's Wi-Fi password is **never stored** (registry, settings, logs, job records); it lives in memory for the job only.

Failure messages are plain: wrong AP password, device rejected the Wi-Fi password (`wifi_change.reason` `auth`), network not found (`no_ap`), device did not appear on the LAN, could not rejoin the original network (with the restore action).

**Testing.** The fake device cannot exercise a real `netsh`. The state machine is unit-tested against a **fake adapter** (including failure at every step, cancel, and crash-restore). The real adapter path needs a real board **and the user's explicit go-ahead** before anything switches this PC's Wi-Fi; do not do it unprompted during development.

### 3.12 Per-device IP settings: DHCP default, optional static IP (M8b)

Requested by the user: "have DHCP by default, but also be able to set their own static IP so they don't get stuck; if the device changes Wi-Fi config it should reset back to DHCP for the new network". Firmware: branch `claude/wifi-change-fallback-ab5ac7`, unmerged; shapes in §2.9 (`ip_mode`, `ip_change`, `network.ip.set`, `network.ip.confirm`). Placed after M8 (Network screen). Not in batch 1 or 2's critical path.

**Backend (API-first):**

- **Read the IP mode**: an endpoint returning `ip_mode`, `sta_ip`, `netmask`, `gateway`, `dns` and `ip_change` from the device's network status; "not supported" (feature-detect) when the device does not report `ip_mode`.
- **"Change IP" job**: (1) send `network.ip.set` (static or `dhcp`); the device replies first and applies about **1.5 s** later; (2) reach the device **at the new address** (probe `GET /status` by id on the new IP; for DHCP, find it again by id via discovery); (3) send `network.ip.confirm` (with the `ip_change.seq` read from the set reply) within the **90 s** window; (4) update the registry entry: the device is keyed by MAC id, only `host` changes; (5) report the outcome from `ip_change` plainly: `ok`/`confirmed`, or `reverted`/`not_confirmed` (device could not be reached at the new address, it went back to its previous setting), `no_dhcp_lease`, `failed`. If the Manager loses the device and cannot see it again, the job ends `reverted/unknown` and the registry host is left unchanged until discovery finds the device.
- **DHCP return path**: `network.ip.set {mode:"dhcp"}` self-confirms on a lease (`dhcp_lease`); the job then finds the device's new DHCP address by id.
- Pre-checks mirror the device's refusals (§2.9): needs saved Wi-Fi, no Wi-Fi test or other IP change running, STA connected for static. In OpenAPI and `API.md`.
- Testing: the fake device's opt-in `pendingFirmware` mode (clock-injectable, so the 90 s window is testable) covers set, confirm, revert and the Wi-Fi-change reset. Limitation: the fake cannot really move to another IP on loopback, so the "reach it at the new address" step is state only until a second listener exists.

---

## 4. Frontend information architecture

Vite + React + TypeScript (React 19, see Implementation notes), React Router, plain CSS with tokens (`manager/web/src/styles/tokens.css`, ported from `manager/proto/tokens.css`), `motion` (from `motion/react`) for transitions, `lucide-react` icons, and Radix UI primitives (dialog, dropdown-menu, tabs, tooltip, switch, slider) (Amendment 3). The UI runs on a PC, so bundle size is not a constraint; polish is. `prefers-reduced-motion` is respected (animations collapse to instant state changes), and the device header must not wrap badly at narrow widths (title truncates with a tooltip, chips and actions collapse into an overflow menu). Data via a small hook layer over `fetch` + the single WS (no Redux; a `useSyncExternalStore` store keyed by device id). The frontend talks only to the Manager API (§3), never to a device. Desktop-first, usable at 768 px (tablet): the side nav collapses to icons < 1024 px and to a top bar < 768 px.

### 4.1 Visual language (shared with `docs/ui-redesign.md` §3)

Soft 16 px cards, pill chips, one accent colour (blue), colour is semantic only (green ok, amber warn, red bad, accent = interactive/selected), light + dark via `prefers-color-scheme` with a manual override, system font stack, no web fonts, stroke icons from `lucide-react` (~~no icon fonts, inline SVG~~ superseded by Amendment 3), `motion` transitions (disabled under `prefers-reduced-motion`), tabular numerals for live values, 40 px+ hit targets (44 px on touch).

### 4.2 Terminology (use exactly these words)

| Term | Meaning |
|---|---|
| Device | one board. Title = `label` ‖ `name` ‖ `hostname`. Secondary line: `hostname · IP`. |
| Fleet | all devices in the registry |
| Online / Unreachable / Offline / Rebooting / Updating | health states (§3.4) |
| Needs attention | any attention flag |
| Add-on | a module instance (`module.*`). Never "module" in UI copy. |
| Pin | a GPIO; modes shown as **Output, Input, PWM, Servo, Analog (ADC), Off** |
| Rule | on-device rule ("When … then … otherwise …") |
| Firmware update | OTA. "Update", never "flash" (flash = USB). |
| Target firmware | the image chosen for comparison/update |
| Backup / Restore / Clone | §3.8 |
| Setup AP | the device's own Wi-Fi network (SoftAP) |
| Safe mode | `safe_mode == true`; I/O config was not applied |

### 4.3 Navigation

Side nav (always visible on desktop): **Fleet**, **Discover**, **Firmware**, **Backups**, **Settings**. Bottom of the nav: manager status (server connected / LAN mode badge).
Device detail is a route under Fleet (`/devices/:id/live|pins|network|system`) with a device header (name, chips, actions: Open device page ↗, Refresh, Back up, Update, Reboot) and four tabs: **Live**, **Pins & add-ons**, **Network**, **System**.

### 4.4 Screens

States every data screen must design: **loading** (skeleton cards, never spinners over forms), **empty**, **device offline** (cached last values greyed with "Last seen 5 min ago", controls disabled, "Retry" button; plus **"Recover over its setup Wi-Fi"** from M4b, §3.11, when the Wi-Fi adapter is supported), **device busy** (queue indicator), **error** (inline card with the device's error string verbatim + retry), **safe mode** banner on device screens.

1. **Fleet overview** (`/`)
   - Purpose: health of every device at a glance; entry point to everything.
   - Data: `GET /api/devices`, WS `device` updates, target firmware from settings.
   - Layout: summary strip (Total, Online, Offline, Needs attention, Firmware differs), toolbar (search by name/IP/id, filter chips: All / Online / Offline / Attention / Differs, sort, **Cards ⇄ Table** toggle, Scan button), device cards or table rows, **bulk-select bar** (Update firmware…, Back up, Reboot, Forget).
   - Card: name, hostname · IP, health chip, chips for Wi-Fi RSSI / MQTT / memory, firmware `app_version` with "differs" chip, uptime, attention line, quick actions (Open, Open device page ↗).
   - Table columns: select, Name, Health, IP (with a small **DHCP / Static** chip from M8b when the device reports `ip_mode`; no chip on firmware that does not), Firmware, Uptime, RSSI, MQTT, Memory, Last seen.
   - States: empty fleet ("No devices yet" → Scan / Add by IP / link to the browser installer), loading, some offline (rows greyed, last seen), all offline (banner: "Can't reach any device — is this PC on the same network?").
2. **Discover** (`/discover`)
   - Purpose: scan, adopt, manual add.
   - Data: `POST /api/discovery/scan`, WS `scan`, `POST /api/devices`.
   - Layout: scan card (progress bar: mDNS phase then sweep `120 / 254` per subnet, subnets listed, Cancel), results grouped **New** (Add / Add all / Ignore), **Already in fleet** (with "IP changed" note), **In setup / recovery** (explains Setup AP; link "Open its page" when reachable), **Ignored** (collapsed). From M4b (§3.11) a **"Devices in setup mode"** section lists nearby device access points (`esp32-<last6>`, open or secured, signal) from the PC's Wi-Fi adapter, each with **Set up**; where the adapter is unsupported the section says "not supported on this machine" and why. **Set up** opens a guided flow: steps with progress (remember network, join the device AP, find the device, pick the target network, send Wi-Fi, rejoin your network, wait for the device on the LAN, add it), a warning first that this PC will leave the LAN (and that a remote browser in LAN mode will lose the Manager until it ends), optional "Reset the device first", and plain failure messages: wrong AP password, the device rejected the Wi-Fi password, the device did not appear on the LAN, could not rejoin the original network (with a Restore button). Manual add card (IP or hostname, Add, inline validation and probe errors: timeout, "not a de-esp32 device", redirect to 192.168.4.1).
   - States: never scanned, scanning, nothing found (troubleshooting: same subnet, Windows mDNS, VPN), errors.
3. **Device · Live** (`/devices/:id/live`)
   - Purpose: watch and drive I/O.
   - Data: `GET …/v1/status`, `module.list`, `rule.list` (for "driven by rule" hints); watch via WS (`io/*`, `telemetry`).
   - Tiles per configured channel: Output (switch → `pin.set`), Input (level dot), PWM (slider 0–100 % → duty 0–1000, Hz shown), Servo (slider 0–180°), Analog (volts, raw, bar), BME280 (°C, %RH, hPa; "No sensor" when `ok:false`), RFID (UID / "No tag", reader version). Tiles say when a rule drives the pin. Header chips: link state (Live / Polling / WS full), Wi-Fi, MQTT, memory.
   - States: nothing configured (→ Pins & add-ons), offline (frozen tiles), WS full (banner: "Device already has 4 live viewers; updating every 30 s").
4. **Device · Pins & add-ons** (`/devices/:id/pins`)
   - Purpose: configure pins, add-ons, rules.
   - Data: `GET …/v1/hardware`, `status.io`, `module.catalog`, `module.list`, `rule.list`.
   - Layout: DevKitC **pinout** (two 19-pad headers from `hardware.header`, USB at bottom, pads coloured by mode/owner, power/GND/EN greyed, flash pins hatched) next to a **pin list** (All / Used / Free); **pin sheet** (mode segmented control limited by capability; per-mode fields; strap/boot/input-only notes; owner explanation; shared-PWM-Hz note); **Add-ons** card list (+ Add add-on wizard: pick type → id, bus, pins (free-pin pickers, bus defaults from `hardware.buses`), settings from catalog → Add; Edit = `module.configure`; Enable/Disable; Remove); **Rules** list (n / 8 used; When GPIO [op] value then GPIO = value otherwise …; enable toggle; edit; delete).
   - Validation mirrors firmware errors client-side; firmware error strings are still shown verbatim if the device rejects.
5. **Device · Network** (`/devices/:id/network`)
   - Purpose: Wi-Fi, IP address, Setup AP password, MQTT.
   - Data: `GET …/v1/network`, `…/v1/mqtt`, `…/v1/network/scan` (on demand), all through the Manager API (§3).
   - Wi-Fi card: state, IP, hostname.local, RSSI (at connect), provisioned, and, when the device reports `wifi_change` (§2.9), the last Wi-Fi change result in words (e.g. "Last change failed: wrong password; kept the old network"); **Forget Wi-Fi** (danger). ~~**Move to another network** (danger flow, §2.7)~~ is **not in v1** (Amendment 4); it returns as L1 (§9), only for devices reporting `wifi_change`.
   - **IP address card (M8b, §3.12)**: shows **DHCP** or **Static** with IP, netmask, gateway, DNS from `ip_mode`/`sta_ip`/`netmask`/`gateway`/`dns`, and an **Edit** button. When the device does not report `ip_mode` the card is hidden or disabled with "needs newer firmware". The **edit sheet** (DHCP / Static segmented control) validates as the device does (§2.9): strict IPv4 dotted quads, contiguous netmask /1–/30, IP and gateway distinct unicast hosts in the same subnet and not the network/broadcast address, subnet not overlapping `192.168.4.0/24`, DNS optional (defaults to the gateway). It **warns** when the new address is outside the PC's current subnet ("this PC may not be able to reach it") and when **another registry device already has that address**. Saving runs the Change IP job with a **progress state for the confirm step**: "Applying… looking for the device at 192.168.1.50… confirming (xx s left)"; if the device cannot be reached it **goes back to its previous setting by itself** and the UI says so (`ip_change` `reverted`/`not_confirmed`). Offline DHCP switch and DHCP return are explained in the same sheet.
   - Setup AP card: SSID, open/protected, set/clear password (8–63). MQTT card: connected, URI, root, prefix, counters, last error, edit URI/user/password/root (password write-only; hint that MQTT cannot be disabled once set), topic list (from `x-mqtt` or `sub`/`pub`).
6. **Device · System** (`/devices/:id/system`)
   - Purpose: identity, firmware, diagnostics, power actions.
   - Data: `status`, `…/v1/ota`, `…/v1/logs`, `memory`.
   - Cards: Identity (rename, id, MAC, hostname, chip, board, schema/generation); Firmware (running slot, `app_version`, compile date, IDF, image state, rollback possible; Update from: target / local file / URL (`ota.apply`); progress; Roll back); Memory (internal bar, free/min/largest, DMA, pressure, alloc failed, boot stages table, task stack table); Uptime & resets (uptime, boot count, reset reason with label); Logs (load on demand, refresh, copy, download, ANSI stripped, level colouring by `E/W/I/D` prefix); Danger zone (Reboot, Factory reset with type-to-confirm).
7. **Firmware** (`/firmware`)
   - Purpose: pick a target image and update many devices.
   - Data: `GET /api/firmware`, `GET /api/devices`, jobs over WS.
   - Layout: target image card (Latest CI build: app_version, date, size, fetched-at, Refresh; or Uploaded images list; drop zone for `.bin` with validation result), device selection table (version, status, eligibility reason: offline / busy / pending verify / already up to date), options (push vs device pull, parallel 1–4, pause after N failures), **Start update**. Running job view: overall progress, per-device rows with stage + % + error, Pause / Resume / Cancel / Retry failed. History of past jobs.
8. **Backups** (`/backups`)
   - Purpose: back up, restore, clone.
   - Layout: backup list (device, date, size of config: pins/add-ons/rules counts, gaps chip), actions (Download, Restore to…, Delete), Import file; **Clone** wizard (source device → target devices → include checkboxes → dry-run plan per target with diff lines → Apply → per-target progress).
9. **Settings** (`/settings`)
   - Poll interval, background scan (on/off, period), extra subnets to sweep, firmware source URL, default OTA mode and parallelism, "keep fleet live" toggle, theme, **LAN access** (Amendment 2: on/off toggle in M12 — until then `--lan` at start-up; the LAN URL(s) and token from `GET /api/access` with copy buttons; **rotate token**), data directory (open folder), about/version, link to the browser installer.

---

## 5. Folder layout

```
manager/
  package.json                # workspaces-free single package; scripts: dev, build, test, lint, start, dist:win
  .npmrc                      # install-links=true (see §6)
  tsconfig.base.json
  README.md                   # (written in phase 2)
  proto/                      # static design prototypes (this phase)
    tokens.css  index.html  fleet.html  discover.html  device-live.html  device-pins.html
    device-network.html  device-system.html  firmware.html  backups.html  settings.html
  server/
    src/
      main.ts                 # CLI entry: args, data dir, start(), open browser
      app.ts                  # start({port, host, lan, dataDir}) → {url, close}; used by Electron too
      http/router.ts  http/static.ts  http/security.ts (host/origin/token)
      api/devices.ts  api/proxy.ts  api/discovery.ts  api/firmware.ts  api/jobs.ts  api/backups.ts  api/settings.ts
      ws/browserHub.ts  ws/deviceLink.ts
      device/client.ts        # typed wrappers over /api/v1 + per-device queue
      device/queue.ts
      discovery/mdns.ts  discovery/sweep.ts  discovery/index.ts
      firmware/image.ts       # header + esp_app_desc_t parser
      firmware/store.ts  firmware/remote.ts
      jobs/otaJob.ts  jobs/setupJob.ts (M4b)  jobs/ipJob.ts (M8b)
      wifi/adapter.ts  wifi/netsh.ts  wifi/unsupported.ts   # M4b host Wi-Fi adapter interface + Windows `netsh wlan` + "not supported"
      api/openapi.ts  api/access.ts   # route table → OpenAPI; LAN URL + token
      backup/snapshot.ts  backup/plan.ts  backup/apply.ts
      store/registry.ts  store/settings.ts  store/atomicWrite.ts
      types/device-api.ts     # TS types for §2 shapes (single source for server + web)
      types/shared-lib.d.ts   # types for node-red-contrib-de-esp32/lib/*
    test/                     # node:test + a fake device (in-process HTTP+WS server replaying §2 shapes)
  web/
    index.html  vite.config.ts
    src/
      main.tsx  App.tsx  routes/…  components/…  hooks/…  api/…  styles/tokens.css styles/app.css
  electron/
    main.ts                   # starts app.ts in-process on 127.0.0.1:0, opens BrowserWindow
    electron-builder.yml
  scripts/
    bundle.mjs                # esbuild server → dist/server.cjs, copies web/dist → dist/public
```

Build output: `manager/dist/` = `server.cjs` + `public/` (the SPA) + `package.json` with `bin` → runnable with `node dist/server.cjs` or `npx de-esp32-manager` once published.

---

## 6. Shared device-client code — recommendation

**Recommendation: the Manager depends on the existing Node-RED package as a local `file:` dependency, installed as a real copy (`install-links=true`), and imports only its pure modules. No change to the Node-RED package.**

```jsonc
// manager/package.json
"dependencies": { "node-red-contrib-de-esp32": "file:../nodered/node-red-contrib-de-esp32", "ws": "^8", "multicast-dns": "^7" }
// manager/.npmrc
install-links=true
```

```ts
import fingerprint = require("node-red-contrib-de-esp32/lib/fingerprint");   // isOurs, summarize
import discover = require("node-red-contrib-de-esp32/lib/discover");          // parseTxt, looksLikeOursTxt, mergeDevice
import pins = require("node-red-contrib-de-esp32/lib/pins");                  // pinClaimed, ownerBlocks, …
import devkitc = require("node-red-contrib-de-esp32/lib/devkitc-hardware");  // offline pinout fallback
```

Why this one:

- **Zero disruption**: the published package keeps its `files` whitelist and layout; nothing moves. `lib/` is already in `files`, so the `file:` install sees exactly what npm users see.
- **Single source of truth** for fingerprinting, TXT parsing, merge-by-id, pin-ownership rules and the DevKitC snapshot.
- **Dependency resolution works**: with `install-links=true` npm packs the folder and installs it like a registry package, so its own deps (`multicast-dns`, `mqtt`, `ws`) land in `manager/node_modules`. A plain symlink (`install-links=false`) or a relative `require("../nodered/...")` would make `discover.js`'s lazy `require("multicast-dns")` resolve from `nodered/…/node_modules`, which usually isn't installed — and it fails *silently* (returns `[]`).
- esbuild bundles it into `dist/server.cjs`, so the Electron and Node artifacts are self-contained.

Costs / rules:

- Edits to `nodered/…/lib` need `npm install` in `manager/` to be picked up (it's a copy). The manager CI path filter includes `nodered/node-red-contrib-de-esp32/lib/**` and `package.json`.
- The Manager needs its own TypeScript declarations (`server/src/types/shared-lib.d.ts`).
- The Manager uses **its own** mDNS browse (it needs TXT + streaming progress) and **its own** `/24` sweep (ported from `tools/discover.py`); `discover.scan()` is not reused. `http.js` is not reused either (the Manager needs keep-alive agents and queues) — only its timeout/error conventions.
- Alternatives rejected: npm workspaces at the repo root (adds a root `package.json`, changes how the Node-RED package is developed); extracting `@de-esp32/client` to npm now (a second published package and release process for ~300 lines — do it later if a third consumer appears); copy-and-sync (drift).

---

## 7. CI workflow outline (`.github/workflows/manager.yml`, written in batch 4, not yet run on GitHub)

- **Triggers**: `push` and `pull_request` with `paths: [manager/**, nodered/node-red-contrib-de-esp32/lib/**, nodered/node-red-contrib-de-esp32/package.json, .github/workflows/manager.yml]`; `push` of tags `manager-v*` (tags ignore path filters).
- **Job `check`** (ubuntu-latest, Node 22 and 24 matrix): `npm ci` in `manager/` → `npm run lint` (eslint + `tsc --noEmit` for server/web/electron) → `npm test` (node:test against the fake device; vitest for web hooks/components) → `npm run build` (vite + esbuild) → smoke: start `node dist/server.cjs --no-open --port 0`, `GET /api/health`, kill. Upload `manager/dist` as a workflow artifact (7 days).
- **Job `release`** (only on `manager-v*` tag, needs `check`):
  - `bundle` (ubuntu): build → `de-esp32-manager-<ver>-node.zip` (`dist/` + `README` + `LICENSE`; run with `node server.cjs`).
  - `win` (windows-latest): build → `electron-builder --win portable` → `de-esp32-manager-<ver>-portable.exe`. Unsigned in v1 (SmartScreen warning documented).
  - `publish`: `softprops/action-gh-release` (or `gh release create`) attaching both files and SHA256SUMS; release notes from the tag message. Version in `manager/package.json` must equal the tag (checked).
- Permissions: `contents: read` for check, `contents: write` for release only. Concurrency group per ref.
- `install.yml` is untouched. Note: `install.yml` runs on every push to `main` (it decides internally whether to rebuild firmware), so Manager-only pushes will also redeploy Pages unchanged — harmless.

---

## 8. Electron packaging notes

- `electron/main.ts`: `const { url, close } = await start({ host: "127.0.0.1", port: 0, dataDir: app.getPath("userData") })` in the main process, then `new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } }).loadURL(url)`. No preload API in v1 — the SPA is identical to the browser build.
- Single-instance lock; second launch focuses the window. Closing the window quits (no tray in v1).
- External links (`Open device page ↗`, installer) open in the system browser via `setWindowOpenHandler` → `shell.openExternal`, restricted to `http(s)://`.
- LAN mode is not offered in the Electron build (localhost only).
- electron-builder: `win.target: portable`, `asar: true`, include `dist/server.cjs` + `dist/public`; the server is required from inside asar (pure JS deps only — `multicast-dns` and `ws` are pure JS; `ws` optional native addons `bufferutil`/`utf-8-validate` are not installed).
- Windows firewall: binding UDP 5353 for mDNS may trigger a firewall prompt on first scan; the sweep still works if denied. Document it.
- Size target: portable exe < 90 MB. (Batch 4: 102.7 MB with Electron 45, almost all of it Electron/Chromium; see the batch 4 notes.)

---

## 9. Phased implementation plan

Each milestone is independently buildable and verifiable. "Verify" lists the check that closes it.

| # | Milestone | Verify |
|---|---|---|
| M0 | Scaffold `manager/` (package.json, tsconfig, eslint, vite app showing the shell from `tokens.css`, esbuild server serving it, `npm run dev` with Vite proxy). | `npm run build && node dist/server.cjs` opens a page; `GET /api/health` ok. |
| M1 | `types/device-api.ts` from §2 + **fake device** (HTTP + WS, scripted state, 4-WS cap, reboot-without-response, 1536 B limit). | Unit tests exercise every §2 route on the fake. |
| M2 | Registry + settings stores (atomic writes), manual add, device list API, health poller. | Add fake device by IP; kill it → `offline` after 2 polls; restart server → registry persists. |
| M3 | Discovery: mDNS + `/24` sweep + fingerprint via shared package, scan progress over browser WS. Also exposes the library call "wait for device id X on the LAN, with timeout" (§3.3) that M4b needs. | Fake device on a second loopback port is found; real board found on LAN. |
| M4 | Fleet + Discover screens (cards/table, search/filter, empty/offline states). | Manual UI pass vs prototypes; Playwright smoke optional. |
| M5 | Device WS link with fan-in (one device WS per device, browser `watch`/`cmd`), "WS full" detection, `mqtt/reconfigure` redaction. *(The REST device proxy, per-device queue and `POST /api/devices/:id/command` already shipped in M2.)* | Two browser tabs watching one device → one device WS; fake device rejects a 5th socket and the server reports `full`. |
| M6 | Device Live screen (tiles + controls). | Toggle/slider round-trips on a real board; WS frames update tiles. |
| M7 | Pins & add-ons (pinout, pin sheet, add-on wizard, rules) + pin shadow. | Configure every mode on a real board; capability errors shown verbatim; add/remove BME280 and RC522. |
| M8 | Network + System screens (rename, logs, memory, reboot, factory reset, Forget Wi-Fi, Setup AP password, MQTT; ~~Wi-Fi move flow~~ out of v1, Amendment 4 / L1). | Rename reflected in mDNS rescan; reboot → `rebooting` → `online`. |
| | **— First usable version ends here (M4–M8 = batch 2). Then, in this order: —** | |
| M4b | **SoftAP setup and recovery** (after M8; §3.11): host Wi-Fi adapter interface (Windows `netsh wlan`; "not supported on this machine" elsewhere), nearby device-AP listing, setup job state machine (join AP → fingerprint → pick network → optional factory reset → send Wi-Fi → read `wifi_change` → leave the AP → wait for the device on the LAN → add), always restore the PC's network (failure, cancel, shutdown, crash recovery on next start), temporary profiles removed, Wi-Fi password never stored; endpoints in OpenAPI + `API.md`; Discover "Devices in setup mode" + guided flow; offline device page "Recover over its setup Wi-Fi". Needs the device client's `localAddress` option and M3's "wait for device id". | State machine unit-tested against a fake adapter (every step failing, cancel, crash-restore, password never persisted). The real adapter path needs a real board **and the user's explicit go-ahead** before this PC's Wi-Fi is switched. |
| M8b | **Per-device IP settings: DHCP default, optional static IP** (after M8; §3.12; firmware: branch `claude/wifi-change-fallback-ab5ac7`, unmerged): read-IP-mode endpoint; "Change IP" job (`network.ip.set` → reach the device at the new address → `network.ip.confirm` within the 90 s window → update the registry host, same MAC id → report `ip_change` revert/timeout clearly); DHCP return path; Network-tab "IP address" card + edit sheet with validation and warnings; confirm-step progress; Fleet table mode chip; feature-detected ("needs newer firmware" when `ip_mode` is absent). Endpoints in OpenAPI + `API.md`. | Fake device with `pendingFirmware` (injectable clock): set → confirm → `ok`; no confirm → `reverted`; invalid configs rejected; Wi-Fi change resets to DHCP. Real hardware only once the firmware branch is merged and flashed. |
| M9 | Firmware store + image parser + single-device push OTA + verification. | Update a real board to the Pages image; `app_version` changes; rollback detected when forced. |
| M10 | Bulk OTA jobs (concurrency, pause on failure, cancel, retry) + Firmware screen. | 3 fake devices incl. one that fails mid-upload and one that rolls back. |
| M11 | Backups: snapshot, plan (dry run), apply, clone + Backups screen. | Clone board A → B; dry-run diff matches; post-apply `module.list`/`rule.list` equal. |
| L1 | **"Move device to another network"** (Amendment 4; gated on firmware `wifi_change`, §2.9). Offered **only** when the device reports `wifi_change`. Uses the safe-Wi-Fi-change behaviour (the device keeps the saved network until the new one has a lease, and restores the old network on failure) and then watches for the device id to reappear (discovery by id with timeout), reporting `wifi_change.reason` in words on failure. Danger flow with type-the-name confirmation; endpoint + OpenAPI + `API.md`; Network-tab control. A static IP is reset to DHCP on the new network (`ip_change` `reset`) and the UI says so. | Fake device with `pendingFirmware`: failure returns to the old network with `restored_previous`; success is found again by id; on a device without `wifi_change` the control is absent. Real hardware only after the firmware branch is merged and flashed. |
| M12 | Settings screen. **LAN mode itself ships in M0** (`--lan`, token, host/origin checks, `GET /api/access`; Amendment 2), so M12 shrinks to the Settings UI: the LAN on/off toggle (re-bind), LAN URL + token display with copy, token rotate, and the other settings. | Toggle LAN from Settings; rotated token invalidates the old cookie; LAN URL with token works from a phone. (The foreign `Host`/`Origin` rejection is already covered from M0.) |
| M13 | CI workflow `manager.yml` (check job). | Green on a PR touching `manager/**`. |
| M14 | Electron shell + release job (portable exe + node zip). | Tag `manager-v0.1.0` on a fork produces both assets; exe runs on a clean Windows VM. |

**Order of work.** Rows are listed in build order; milestone ids are kept stable, so they are not sequential. Batch 1 = M0–M3 (done). Batch 2 = M4, M5, M6, M7, M8, which together are the first usable version. After that: M4b SoftAP setup, M8b static IP, M9–M10 firmware (single, then bulk), M11 backups, L1 Wi-Fi move (gated on firmware `wifi_change`, not v1), M12 settings and LAN hardening, M13 CI, M14 Electron.

---

## 10. Prototype set (`manager/proto/`)

Static HTML, inline JS only for tab/sheet toggling, mock data in §2 shapes, all linking `tokens.css`: `index.html` (links), `components.html` (component reference with markup), `fleet.html` (also holds the canonical mock fleet in a comment), `discover.html`, `device-live.html`, `device-pins.html`, `device-network.html`, `device-system.html`, `firmware.html`, `backups.html`, `settings.html`. Serve the folder over HTTP (any static server) or open the files directly.

Patterns that started as page-local CSS in the prototypes and should become shared components in `web/src/styles` during M0: radio option rows (`firmware.html` `.opt`), segmented job progress bar (`.segbar`), diff list with +/−/~ markers (`backups.html` `.diff`), spinner, Wi-Fi signal bars (`device-network.html` `.sig`), selectable type cards (`device-pins.html` `.type`), and the DevKitC pinout (`device-pins.html` `.board`/`.pad`).

---

## 11. Open questions for the human

1. **Firmware versioning.** `status.fw` is a constant `0.1.0`; the Manager will compare `ota.app_version` (git describe). OK to treat "different" as "update available", or should firmware set `PROJECT_VER` from a tag first?
2. **Firmware URL.** Hard-code `https://terraseraph.github.io/esp32-joat/` as the default source (setting-overridable)? Should the Manager also publish/consume a small `install/firmware/version.json` (would need a change to `install.yml`, which is off-limits for now)?
3. **Default OTA mode**: Manager push (works without device internet, ~1.5 MB per device through the PC) vs device pull from Pages (needs internet on the device LAN). Spec defaults to push.
4. ~~**Wi-Fi move from the Manager**: keep it (with the danger flow in §2.7) or leave Wi-Fi changes to the device's own page / installer only?~~ **Answered (Amendment 4):** out of v1; it returns as milestone L1, gated on firmware `wifi_change`. SoftAP setup (M4b) covers boards with no network.
5. **Config export endpoint**: accept lossy pin backups in v1 (with the pin shadow), or add a firmware `config.export` command first (§12)?
6. ~~**LAN mode**: is a printed token enough, or should LAN mode be dropped from v1 entirely?~~ **Answered (Amendment 2):** LAN mode is first-class and ships in M0 (`--lan`); a printed token (Bearer / `?token=` / HttpOnly cookie) is the credential, loopback needs none; M12 adds the Settings toggle and token rotate.
7. **Background scanning** default on or off? (A /24 sweep every 5 min is ~254 HTTP probes.)
8. **Electron**: Windows portable exe only for v1, or also an NSIS installer? Code-signing certificate available?
9. **Telemetry history**: worth a small on-disk ring (e.g. 24 h of heap/RSSI per device) in v1, or later?
10. **Node-RED sharing**: OK to depend on the palette package via `file:` (§6)? If the palette is later renamed/moved, the Manager's dependency path moves with it.

---

## 12. Device API gaps and firmware follow-ups found while writing this

Severity: **B** = blocks or degrades a planned feature, **S** = security, **N** = nice to have.

| # | Finding | Where | Impact / proposal |
|---|---|---|---|
| 1 | **S** — `mqtt.configure` publishes the raw request (incl. MQTT `password`) on the event bus as `mqtt/reconfigure`, and the WS forwards every topic to every client. | `command_router.cpp:456-457`, `web_server.cpp:391-406` | Any LAN client with a WS sees broker credentials. Manager redacts; firmware should publish a copy without `user`/`password`. |
| 2 | **B** — No config export: pin options (`invert`, pulls, `boot`, `irq`, `name`), Wi-Fi SSID, MQTT user and AP password are unreadable. | §2.8 | Backups are lossy. Proposal: `config.export` returning the `io.pins` blob, modules, rules, name, MQTT uri/root/user (no secrets). |
| 3 | **B** — `status.fw` is the constant `RUNTIME_VERSION "0.1.0"`. | `runtime_version.hpp` | Use `ota.app_version`; firmware should set `PROJECT_VER` from tags in CI. |
| 4 | **B** — `install/manifest.json` has no version. | `install/manifest.json` | Manager must download the `.bin` to know its version (parses app descriptor). A `version.json` beside it would avoid the download. |
| 5 | **B** — No way to disable MQTT once configured (`mqtt.configure` always sets `enabled = 1`). | `command_router.cpp:455` | UI can't offer "Disable MQTT". Proposal: `mqtt.configure {enabled:false}` or `mqtt.disable`. |
| 6 | **B** — `network.wifi.set` from the LAN drops the link and, on failure, does not fall back to the saved network. | `network_manager.cpp:255-283, 92-108` | Risky remote Wi-Fi change; the Manager does not offer it in v1 (Amendment 4). Proposal: on test failure, restore the saved STA config. **Addressed on branch `claude/wifi-change-fallback-ab5ac7` (unmerged, untested on hardware): `rollback_sta` + `wifi_change`, see §2.9.** L1 (§9) is gated on it. |
| 7 | **N** — WS client #5 is accepted but silently not registered. | `web_server.cpp:277-297` | Manager infers "full". Proposal: close with a status/reason or send `{topic:"ws/full"}`. |
| 8 | **N** — `system.reboot` / `factory_reset` restart before replying. | `command_router.cpp:480-490` | Manager treats a reset as success. Proposal: delayed restart task like OTA (800 ms). |
| 9 | **N** — PWM frequency is shared by all PWM pins, and other pins' state `hz` goes stale. | `io_pwm.cpp:96-121` | UI note. Proposal: republish all PWM states after a timer change. |
| 10 | **N** — `persist_pin` ignores persist errors and rebuilds from empty if the blob read fails. | `command_router.cpp:57-98, 171-173` | Possible silent loss of other pins if the 2 KB blob overflows (unverified). Manager sends minimal pin objects. |
| 11 | **N** — `network.rssi` is only sampled on connect. | `network_manager.cpp:116-119` | Fleet RSSI is "at connect", labelled as such. |
| 12 | **N** — Rule ids are truncated to 7 chars silently. | `io_rules.cpp:436-438` | UI limits id input to 7 chars. |
| 13 | **N** — `nodered/.../lib/fingerprint.js` reads `status.board`, which `/status` does not send. | `fingerprint.js:36`, `web_server.cpp:105-118` | Harmless; Manager takes board from `/hardware` or mDNS TXT. |
| 14 | **N** — The task brief assumed the Node-RED lib has a `/24` sweep; it does not (only `tools/discover.py` does). | `nodered/.../lib/discover.js` | Manager ports the sweep from `discover.py`. |
| 15 | **N** — No `GET` for a single module's catalog entry / no `module.cmd` for either type. | `module_manager.cpp` | Nothing to build in v1. |
