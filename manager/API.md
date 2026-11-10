# de-esp32 Manager API

REST + WebSocket API served by the Manager for its web app (and for scripts). Machine-readable version:
`GET /api/openapi.json` (OpenAPI 3.1, generated from the same route table the server uses).
This file is checked by a test: every route needs a `### METHOD /path` heading below, with a curl example.

## Basics

- **Base URL**: `http://localhost:5180` (default). All Manager routes live under `/api`. JSON in, JSON out.
- **Success**: HTTP 2xx with the resource JSON directly (no wrapper).
- **Errors**: HTTP 4xx/5xx with `{ "error": "<human message>", "code": "<snake_case_code>", "details"?: ... }`.

  | Status | `code` | Meaning |
  |---|---|---|
  | 400 | `invalid_body` / `invalid_params` / `invalid_query` | schema validation failed; `details` is a list of `{ path, message }` |
  | 400 | `invalid_json`, `bad_request` | body is not JSON / malformed path |
  | 401 | `unauthorized` | LAN mode without a valid token |
  | 429 | `too_many_attempts` | more than 10 wrong tokens from one address within 60 s (`Retry-After` says when to retry) |
  | 403 | `forbidden_host`, `forbidden_origin` | DNS-rebinding / CSRF protection |
  | 404 | `not_found` | unknown `/api/*` route |
  | 405 | `method_not_allowed` | known path, wrong method (`Allow` header lists the right ones) |
  | 413 / 415 | `payload_too_large` / `unsupported_media_type` | JSON bodies must be `application/json`, max 1 MB |
  | 500 | `internal_error` | bug; details are in the server log only |

- Manager-owned objects use camelCase fields. Device payloads proxied from a device keep the device's snake_case verbatim.

### Authentication

- **Localhost mode (default)**: no token. Requests must carry a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]` with the
  server's port), and `POST/PUT/PATCH/DELETE` or WebSocket requests with an `Origin` header must be same-origin.
- **LAN mode** (`--lan`, a non-loopback `--host`, or switched on in Settings / `PUT /api/access`): a token is required. It is
  generated the first time LAN mode is enabled, stored in `<data dir>/settings.json` and printed at start-up on stdout. Send it as
  `Authorization: Bearer <token>`, as the `dem_token` cookie (HttpOnly), or open `http://<lan-ip>:5180/?token=<token>` in a browser
  once (sets the cookie and redirects to the same URL without the token). A `?token=` on an `/api` call is never accepted.
  Requests from this machine with a loopback `Host` need no token.

```bash
TOKEN=...   # printed at startup, or GET /api/access from this machine
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.1.20:5180/api/health
```

#### Security model

Read this before turning LAN mode on.

- **The token is the only protection.** Whoever has it can read and change every device behind this Manager (pins, Wi-Fi and
  MQTT settings, firmware). **The devices themselves have no authentication of their own.** The Manager speaks plain http, so
  anyone who can sniff your network can read the token. Use LAN mode on a network you trust, never on the internet.
- **Who is "local".** A request is local only if its socket comes from a loopback address **and** its `Host` is a loopback name with
  the server's port. Either alone is not enough (a tunnel on this PC connects from 127.0.0.1; any remote client can type
  `Host: localhost`). Local requests need no token, even in LAN mode.
- **DNS rebinding.** In localhost mode every other `Host` is `403 forbidden_host`. In LAN mode names are not allow-listed (you
  reach the Manager by IP or any name); a rebound name has a non-loopback `Host` and no cookie, so it needs the token and fails.
- **CSRF.** `POST/PUT/PATCH/DELETE` and WebSocket upgrades that carry an `Origin` must be same-origin (equal to `Host`) or in
  `--allow-origin`; `Origin: null` is refused. This applies to the local user and to token holders too. Requests without
  `Origin` (curl, scripts) are not browser requests and pass.
- **Cookie**: `dem_token`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30 days), no `Secure` because the Manager speaks plain
  http (a Secure cookie would never be sent back). Regenerating the token invalidates every cookie.
- **Brute force.** Tokens are compared in constant time. More than 10 wrong tokens within 60 s from one remote address are `429
  too_many_attempts` with `Retry-After` (HTTP and WebSocket) until the window passes; during that time even the right token waits.
  A request with no token at all is not counted, and the local user is never limited. A browser still holding an old cookie after
  a regeneration counts as wrong attempts too: open the new link after the `Retry-After` time.
- **Logs.** The token is never written to a log, job or WebSocket message. It is printed once, on stdout, in the start-up banner.
  Switching LAN mode on later is logged without it.

## Routes

### GET /api/health

Server version, mode and uptime, plus how this Manager was started:

- `networkScan`: `false` when started with `--no-network-scan` (no mDNS, no subnet sweeps anywhere; see Discovery).
- `wifiAdapter`: `fake` (simulated Wi-Fi, for development), `system` (this PC's Wi-Fi adapter, the default) or `none` (SoftAP setup disabled); the `--wifi-adapter` flag.
- `lan`: LAN mode is on **right now** (it follows `PUT /api/access`). `dataDir`: the data folder (only callers that passed the security check see it). `startedAt`: when the server started, epoch milliseconds (`uptime` is in seconds).

```bash
curl -s http://localhost:5180/api/health
# {"version":"0.1.0","lan":false,"dataDir":"C:\\Users\\me\\AppData\\Roaming\\de-esp32-manager","uptime":42,"startedAt":1760000000000,"networkScan":true,"wifiAdapter":"system"}
```

### GET /api/access

How to reach this server, live (it changes when LAN access is switched). Fields:

| Field | Meaning |
|---|---|
| `lan` | LAN access is on right now |
| `host`, `port` | the address the server is bound to right now |
| `localUrl` | URL for a browser on this PC |
| `lanUrls` | one URL per LAN IPv4 address of this PC (empty while off) |
| `token`, `tokenMasked` | the access token in full / with all but the last 4 characters hidden; `null` while off |
| `tokenUrls`, `openUrl` | the `lanUrls` with `?token=` appended; `openUrl` is the first, ready to open on a phone |
| `remote` | this request came from another device (not from this PC) |
| `toggleAvailable`, `toggleUnavailableReason` | whether `PUT /api/access` can work, and a plain-language reason when not (desktop app, or a fixed `--host`) |

The token is only returned to a caller that already passed the security check as the local user or with the valid token; any other
request never reaches this handler (it gets 401 first).

```bash
curl -s http://localhost:5180/api/access
# {"lan":false,"host":"127.0.0.1","port":5180,"localUrl":"http://localhost:5180/","lanUrls":[],"token":null,"tokenMasked":null,"tokenUrls":[],"openUrl":null,"remote":false,"toggleAvailable":true,"toggleUnavailableReason":null}
```

### PUT /api/access

Switch LAN access on or off while the server runs. Body `{ "enabled": true|false }`; returns the same object as `GET /api/access`.

- **On**: creates the token the first time (kept afterwards), then re-binds the **same port** on all network interfaces. From now on
  everything except this PC needs the token. The choice is saved, so the next start comes up the same way.
- **Off**: re-binds on this PC only and **at once cuts off every other device**: their open HTTP connections are destroyed and
  their browser WebSockets are closed (code 4001). Connections from this PC stay open. The token is kept for the next time.
- If the new address cannot be bound (`EADDRINUSE` ...) the Manager keeps listening where it was: `409 rebind_failed`.
- `409 lan_unavailable`: not offered in the desktop app (`StartOptions.lanToggle: false`), or the server was started with a fixed
  `--host` that is neither loopback nor `0.0.0.0` / `::`. `toggleAvailable` says so in advance.
- Allowed for the local user and for a caller with the token. A remote caller that switches it off gets this response and then loses
  its connection (and its access) like everybody else.
- Start-up: LAN mode is on when `--lan` is given **or** it was last saved as on (and the toggle is available). `--lan` always wins
  at start; switching off in Settings does not remove the flag from your launcher.
- A WebSocket message `{ "t": "access", "lan": boolean }` is pushed to the browsers that stay connected.

```bash
curl -s -X PUT http://localhost:5180/api/access -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -s -X PUT http://localhost:5180/api/access -H 'Content-Type: application/json' -d '{"enabled":false}'
```

### POST /api/access/token

Regenerate the access token. The old token and every cookie that carries it are rejected from now on, and the browser WebSockets of
other devices are closed. A remote caller (holding the old token) receives a `Set-Cookie` with the new one in this response and keeps
access; a local caller gets no cookie. Returns the same object as `GET /api/access` (with the new `token`).
`409 lan_disabled` while LAN access is off (switch it on first). Share the new link (`openUrl`) with the people who should keep access.

```bash
curl -s -X POST http://localhost:5180/api/access/token
```

### GET /api/openapi.json

OpenAPI 3.1 document for every route in this file (the WebSocket is described in `info.description`).

```bash
curl -s http://localhost:5180/api/openapi.json | head -c 300
```

### GET /api/settings

App settings: `pollIntervalS` (seconds between health polls of each device, 10-300, default 30), `discoveryTargets`
(extra `host[:port]` addresses probed on every scan, default none), `extraSubnets` (extra CIDR ranges swept on every scan) and
`backgroundScan` `{ enabled, periodMin }` (scan on a timer; default off, every 5 minutes, 1-60; skipped while a scan runs and when
more than 50 devices are registered) and `firmwareBaseUrl` (the "Pages URL" that "Get latest firmware" fetches from, default
`https://terraseraph.github.io/esp32-joat/`; see "Firmware"). The LAN access token is never part of this API (use `GET /api/access`).

```bash
curl -s http://localhost:5180/api/settings
# {"pollIntervalS":30,"discoveryTargets":[],"extraSubnets":[],"backgroundScan":{"enabled":false,"periodMin":5},"firmwareBaseUrl":"https://terraseraph.github.io/esp32-joat/"}
```

### PUT /api/settings

Partial update; send only the keys to change (`backgroundScan` may carry just `enabled` or `periodMin`). Takes effect immediately
(the poller reschedules, the background timer restarts). Unknown keys (including `lanToken`), out-of-range values and invalid
`discoveryTargets` / `extraSubnets` entries are `400 invalid_body` (`details` has one `{path, message}` per bad entry). Lists are
replaced and de-duplicated; targets are stored in canonical form (`http://` and a trailing `/` removed, lower case, `:80` dropped).
`firmwareBaseUrl` must be an http(s) address (stored with one trailing `/`; `400 invalid_body` otherwise). The target firmware is not a
setting you PUT here: use `PUT /api/firmware/target`. Returns the full settings.

```bash
curl -s -X PUT http://localhost:5180/api/settings -H 'Content-Type: application/json' -d '{"pollIntervalS":60}'
# {"pollIntervalS":60,"discoveryTargets":[],"extraSubnets":[],"backgroundScan":{"enabled":false,"periodMin":5},"firmwareBaseUrl":"https://terraseraph.github.io/esp32-joat/"}
curl -s -X PUT http://localhost:5180/api/settings -H 'Content-Type: application/json' \
  -d '{"discoveryTargets":["127.0.0.1:8101","127.0.0.1:8102"],"backgroundScan":{"enabled":true,"periodMin":10}}'
```

## Devices

The Manager is the only path to a device: the web app, scripts and curl all use these endpoints. A device is identified by its
`id` (12 lowercase hex chars, the MAC). A **summary** (`DeviceSummary` in `server/src/types/api.ts`, spec 3.10) is what every
endpoint that returns a device gives back. Fields that come from the device (`fw`, `uptime_s`, `rssi`, `memory`, ...) are
`null` until the device was seen once, and keep their last values (from the registry cache) while it is offline.

| Field | Meaning |
|---|---|
| `health` | `unknown` (not polled yet since the server started; a deviation from the spec) · `online` · `unreachable` (1 failed poll) · `offline` (>= 2 failed polls, or nothing for 2 poll intervals) · `rebooting` (a restart the Manager caused, up to 60 s, ends on the first good poll) · `updating` (reserved for OTA) |
| `attention` | any of `safe_mode`, `boot_unhealthy`, `memory_pressure`, `alloc_failed`, `ota_pending_verify`, `ota_error`, `mqtt_disconnected`, `wifi_recovery`, plus `host_mismatch` (the stored address answers as a different device) |
| `host` | address the Manager uses: `ip`, or `ip:port` when the port is not 80 |
| `queue` | requests waiting or running for this device (the device handles one request at a time; use it for a "busy" indicator) |
| `link` | device WebSocket state: `closed` (nobody watches the device, so there is no socket) · `connecting` · `open` · `full` (see "Device link" under the browser WebSocket) |
| `fwMatchesTarget` | `null` until firmware targets exist |

Every request to a device goes through a per-device FIFO queue (concurrency 1). Default timeout 5 s; 25 s for
`network.wifi.set` / `POST v1/network/wifi`; 12 s for `network.wifi.scan` / `GET v1/network/scan`; health polls and the add
probe use 2 s. The device is never sent a JSON body over 1536 bytes (it would reject it): such requests fail locally with
`413 body_too_large_for_device`.

Device error codes (in addition to the table at the top):

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_host` | the address is not `ip`, `host:port`, `name.local` or a hostname (an optional leading `http://` is accepted, nothing else) |
| 400 | `use_ota_endpoint`, `use_ws_link`, `invalid_path` | refused passthrough targets / malformed path |
| 400 | `device_rejected_body` | the device answered `400 json` to a command body |
| 404 | `unknown_device` | no such id in the registry |
| 413 | `body_too_large_for_device` | JSON body over 1536 bytes, not sent |
| 422 | `probe_timeout`, `device_unreachable`, `captive_redirect`, `not_de_esp32` | `POST /api/devices` could not add the address (see there) |
| 502 | `device_unreachable`, `device_timeout`, `device_reset`, `device_captive_redirect`, `device_bad_response`, `device_http_status` | transport failure on a command/passthrough call; the body is `{ "ok": false, "error": "...", "code": "...", "transport": true }` |

### GET /api/devices

All registered devices as summaries, sorted by title (label, else name, else hostname).

```bash
curl -s http://localhost:5180/api/devices
# [{"id":"fe5e1fa50000","name":"Fake bench 1","label":"","notes":"","hostname":"esp32-a50000","host":"127.0.0.1:8101",
#   "addedAt":"2026-11-10T09:02:14.591Z","addedVia":"manual","health":"online","attention":[],"lastSeen":"2026-11-10T09:02:15.272Z",
#   "fw":"0.1.0","app_version":"9dcba89","compile_date":"Nov 10 2026","fwMatchesTarget":null,"uptime_s":10,"boot_state":"healthy",
#   "safe_mode":false,"safe_reason":"","rssi":-58,"net_state":"sta_connected","mqtt":{"configured":true,"connected":true},
#   "memory":{"pressure":"ok","free":151200,"total":327200},"ota":{"running_partition":"ota_0","image_state":"valid",
#   "rollback_possible":true,"busy":false},"io_count":5,"module_count":1,"link":"closed","queue":0}]
```

### POST /api/devices

Add a device by address. The Manager probes `GET /api/v1/status` (2 s), checks that it is a de-esp32 device and registers it
(`addedVia: "manual"`). `host` accepts `192.168.1.42`, `192.168.1.42:8080`, `esp32-b3c4d5.local` or a hostname (names are
resolved to an IPv4 and the IP is stored), with an optional leading `http://`.

- `201` + summary when new; `200` + summary when the id is already registered (its address is updated).
- `422` with a specific `code`: `probe_timeout` (nothing answered within 2 s), `device_unreachable` (refused / unreachable /
  name did not resolve), `captive_redirect` (the address redirects, e.g. to `http://192.168.4.1/`: a device in setup mode or another
  captive portal), `not_de_esp32` (answered, but the fingerprint failed). `400 invalid_host` for malformed input.

```bash
curl -s -X POST http://localhost:5180/api/devices -H 'Content-Type: application/json' -d '{"host":"127.0.0.1:8101"}'
# 201 {"id":"fe5e1fa50000","name":"Fake bench 1", ... "health":"online", ...}
curl -s -X POST http://localhost:5180/api/devices -H 'Content-Type: application/json' -d '{"host":"127.0.0.1:9"}'
# 422 {"error":"127.0.0.1:9 refused the connection. Check the address and the port.","code":"device_unreachable"}
```

### GET /api/devices/:id

One summary. `404 unknown_device` for an unknown id.

```bash
curl -s http://localhost:5180/api/devices/fe5e1fa50000
```

### PATCH /api/devices/:id

Edit Manager-only metadata and the stored address: `{ "label"?: string (<= 64), "notes"?: string (<= 2000), "host"?: string }`.
`host` is validated like `POST /api/devices` (a name is resolved to an IP) and the device is polled afterwards, so a wrong address
shows up straight away as `unreachable` / `host_mismatch`. Never sends anything but a status poll to the device.

```bash
curl -s -X PATCH http://localhost:5180/api/devices/fe5e1fa50000 -H 'Content-Type: application/json' -d '{"label":"Garage door"}'
```

### DELETE /api/devices/:id

Forget the device: removed from the registry, polling stops. Never touches the device. Returns `204` with no body.

```bash
curl -s -X DELETE http://localhost:5180/api/devices/fe5e1fa50000 -w '%{http_code}\n'
# 204
```

### POST /api/devices/:id/refresh

Poll the device now (through its queue) and return the fresh summary, also when it is unreachable (the summary says so).

```bash
curl -s -X POST http://localhost:5180/api/devices/fe5e1fa50000/refresh
```

### POST /api/devices/:id/command

Send a device command: body `{ "cmd": "<name>", ...args }` (catalog: `docs/manager-app.md` section 2.5). It is forwarded to the
device's `POST /api/v1/command` and the device's envelope comes back unchanged, with HTTP 200 whether `ok` is true or false:
`{ "v": 1, "ok": true, "result": {...} }` or `{ "v": 1, "ok": false, "error": "..." }`. The device validates the arguments.

- `system.reboot`, `system.factory_reset` and `ota.rollback`: when the device restarts instead of answering you get
  `{ "v": 1, "ok": true, "result": { "expectedRestart": true } }` and the device's `health` becomes `rebooting` until it answers a poll again.
- A successful `pin.configure` is remembered (the minimal pin object that was sent, per GPIO; `mode: "disabled"` forgets it);
  a successful `identity.set_name` updates the stored name immediately. This holds on every path (this endpoint, `POST v1/command`,
  `POST v1/pins`, browser WebSocket `cmd`). After a successful `pin.configure`, `module.add`, `module.configure` or `module.remove`
  watching browsers get a fresh `live` snapshot.
- `413 body_too_large_for_device` for bodies over 1536 bytes; `502 {ok:false,transport:true,code}` when the device cannot be reached.

```bash
curl -s -X POST http://localhost:5180/api/devices/fe5e1fa50000/command -H 'Content-Type: application/json' \
  -d '{"cmd":"pin.set","gpio":4,"value":1}'
# {"v":1,"ok":true,"result":{"gpio":4,"value":1}}
curl -s -X POST http://localhost:5180/api/devices/fe5e1fa50000/command -H 'Content-Type: application/json' -d '{"cmd":"system.reboot"}'
# {"v":1,"ok":true,"result":{"expectedRestart":true}}
```

### GET /api/devices/:id/pin-config

The configured pins of a device with a ready-to-resend `pin.configure` object each (for the pin editor). The server reads
`GET /pins` and lists every non-`mod_*` key that has a `gpio`, sorted by gpio. `config` is the Manager's **pin shadow** (the
minimal object it last sent for that GPIO) when its `mode` equals the live mode (`source: "shadow"`); otherwise it is derived
from the live state (`source: "live"`): `{gpio, mode}` plus only non-default options (`in`: `debounce_ms` != 50; `pwm`: `hz` != 1000,
`duty` != 0; `servo`: `angle` != 90, `min_us` != 500, `max_us` != 2500; `adc`: `sample_ms` != 50, `hysteresis_mv` != 20,
`smooth` != 70). A derived config lacks `invert`, pulls, `boot` and `irq`, which the device does not report. `live` is the state
value (the device's snake_case). `404 unknown_device`; `502` when the device cannot be reached.

```bash
curl -s http://localhost:5180/api/devices/fe5e1fa50000/pin-config
# {"pins":[{"gpio":4,"mode":"out","config":{"gpio":4,"mode":"out"},"source":"live","live":{"id":"gpio_4","mode":"out","gpio":4,"level":0}},
#   {"gpio":27,"mode":"in","config":{"gpio":27,"mode":"in","pull_up":true},"source":"shadow","live":{"id":"gpio_27","mode":"in","gpio":27,"level":1,"debounce_ms":50}},
#   {"gpio":32,"mode":"adc","config":{"gpio":32,"mode":"adc"},"source":"live","live":{"id":"adc_32","mode":"adc","gpio":32,"mv":1650,"raw":2048,"sample_ms":50,"hysteresis_mv":20,"smooth":70}}]}
```

### GET /api/devices/:id/v1/*

Generic passthrough to the device's `GET /api/v1/<path>` (`status`, `telemetry`, `hardware`, `pins`, `network`, `network/scan`,
`mqtt`, `logs`, `ota`, `openapi.json`), through the same queue and timeouts. The device's status code and body come back unchanged
(non-JSON with its content type). Query strings are forwarded. `v1/ws` is refused (`400 use_ws_link`): the device WebSocket is
managed by the server. A device answering with a redirect (an unknown route: the firmware redirects to its captive portal) is
`502 device_captive_redirect`.

```bash
curl -s http://localhost:5180/api/devices/fe5e1fa50000/v1/status | head -c 200
# {"v":1,"id":"fe5e1fa50000","fw":"0.1.0","uptime_s":11,"boot_count":1,...
```

### POST /api/devices/:id/v1/*

Generic passthrough of a JSON body to `POST /api/v1/<path>` (`command`, `pins`, `network/wifi`, `mqtt`, `system/reboot`,
`system/factory_reset`). Same rules as `POST /api/devices/:id/command` (which is the preferred way to send commands): 1536 byte
limit, per-call timeouts, expected-restart mapping, pin shadow and rename bookkeeping. `v1/ota` is refused with
`400 use_ota_endpoint`. The device's own status (for instance its `400` with the text `json` for an empty body) is passed through.

```bash
curl -s -X POST http://localhost:5180/api/devices/fe5e1fa50000/v1/pins -H 'Content-Type: application/json' -d '{"gpio":13,"mode":"out"}'
# {"v":1,"ok":true,"result":{"gpio":13,"mode":"out","pull_up":false,"pull_down":false,"invert":false,"boot":0}}
```

## Discovery

Finds de-esp32 devices without you typing an address (spec 3.3). One scan runs at a time; its progress is pushed over the
browser WebSocket (`scan` messages) and readable with `GET /api/discovery`. A scan has two phases plus an end state:

1. `mdns`, the quick phase: probes the stored address of every registered device (this is how a known device that moved is
   noticed even when mDNS is blocked), the extra **targets**, and browses mDNS (`_de-esp32._tcp` and `_http._tcp`, 2.5 s).
2. `sweep`: `GET /api/v1/status` on every host of every local IPv4 network (`.1`-`.254` of the interface's /24; loopback and
   169.254/16 interfaces are skipped; an interface wider than /24 is clamped to the /24 containing its address; a narrower one
   keeps its real size) plus the settings' `extraSubnets` and the request's `subnets`, minus this machine's own addresses.
3. `done`, `cancelled` or `error`.

Every probe is a single `GET /api/v1/status` (800 ms timeout, no redirects, 48 in flight) that does not use the per-device
queue; the address of a registered device is therefore probed in parallel with the health poller, which is tolerated.
Only answers that fingerprint as a de-esp32 device (`isOurs`, 12-hex-char id) become results; captive portals, routers and
other web servers are never reported. Results are one entry per device id; `via` lists how it was found (`mdns`, `sweep`,
`target`, `registry`, joined with `+`).

| `classification` | Meaning |
|---|---|
| `known` | already in the fleet. The registry address is updated when the device answered somewhere else (`ipChanged: {from, to}`), name/hostname/lastSeen are refreshed and the device is polled. Scans never add devices |
| `new` | not in the fleet and not ignored; adopt it |
| `ignored` | on the ignore list |

`setup: true` marks a device whose `network.state` is `ap_only` or `apsta_recovery` (in setup / recovery).
Scans can only see a board's own setup network when this PC is on it.

**`--no-network-scan`.** The server flag (`node dist/server.cjs --no-network-scan`; `npm run dev` uses it by default) hard-disables mDNS
browsing and subnet sweeps everywhere, whatever a request or the settings ask: UI scans, the background scan (it never runs) and
`waitForDevice` used by setup jobs. Explicit `targets`, the settings' `discoveryTargets` and the addresses of registered devices
are still probed. `GET /api/health` and the discovery state carry `networkScan: false`. A scan that asked for `mdns` or `sweep`
(they default to true) runs without them and adds this warning: "Network scanning is turned off on this Manager (started with
--no-network-scan). Only the addresses you entered and known devices were checked." The settings `extraSubnets` are not swept
either, and `subnets` stays empty.

Error codes: `409 scan_running` (a scan is already running), `400 invalid_body` (a bad `targets[i]` or `subnets[i]`, with `details`),
`400 invalid_id` (ignore/un-ignore with something that is not 12 hex characters).

### POST /api/discovery/scan

Starts a scan and answers `202` with the discovery state. The body is optional: `mdns` (default true), `sweep` (default true),
`subnets` (CIDR strings such as `192.168.7.0/24`; prefixes 8-30; **anything wider than /24 is clamped to the /24 containing the
given address**, so `10.1.2.3/16` sweeps `10.1.2.0/24`) and `targets` (`host[:port]` addresses probed exactly as given, port 80
by default; names are resolved to IPv4). The settings' `discoveryTargets` and `extraSubnets` are added to every scan.
Use targets to find devices that are not on a swept network, for example the fake devices on loopback.

```bash
curl -s -X POST http://localhost:5180/api/discovery/scan -H 'Content-Type: application/json' \
  -d '{"mdns":false,"sweep":false,"targets":["127.0.0.1:8101","127.0.0.1:8102"]}'
# {"running":true,"phase":"mdns","probed":0,"total":2,"startedAt":"2026-11-10T09:00:00.000Z","finishedAt":null,"warnings":[],"subnets":[],"results":[],"ignored":[]}
curl -s -X POST http://localhost:5180/api/discovery/scan      # no body: mDNS + sweep of the local networks
```

### GET /api/discovery

The current or last scan. `phase` is `idle` before the first scan since the server started. `probed`/`total` count hosts
(`total` grows when mDNS finds more); `subnets` lists the ranges the sweep covers; `warnings` explains partial failures
(mDNS socket error because UDP 5353 is in use or firewalled, no local network found, a target that did not resolve);
`results` are sorted by name; `ignored` is the registry's ignore list; `networkScan` is `false` when the Manager runs with `--no-network-scan`.

```bash
curl -s http://localhost:5180/api/discovery
# {"running":false,"phase":"done","probed":2,"total":2,...,"results":[{"id":"fe5e1fa50000","host":"127.0.0.1:8101","name":"esp32-5e1fa5",
#   "hostname":"esp32-5e1fa5","fw":"0.1.0","app_version":"9dcba89","via":"target","classification":"new","setup":false,
#   "netState":"sta_connected","lastSeen":"2026-11-10T09:00:00.512Z"}],"ignored":[]}
```

### POST /api/discovery/cancel

Aborts the running scan (in-flight probes are dropped) and keeps the results found so far; phase becomes `cancelled`.
Always `200` with the state, also when nothing runs.

```bash
curl -s -X POST http://localhost:5180/api/discovery/cancel
```

### POST /api/discovery/ignore

Adds `id` to the ignore list; results with that id become `ignored`. Returns the discovery state.

```bash
curl -s -X POST http://localhost:5180/api/discovery/ignore -H 'Content-Type: application/json' -d '{"id":"fe5e1fa50002"}'
```

### DELETE /api/discovery/ignore/:id

Removes `id` from the ignore list (idempotent). Returns the discovery state.

```bash
curl -s -X DELETE http://localhost:5180/api/discovery/ignore/fe5e1fa50002
```

### POST /api/discovery/adopt

Registers devices from the **current** results using the address the scan found, then polls them. Answers
`{ "added": DeviceSummary[], "skipped": [{ "id", "reason" }] }`; reasons are `unknown_id` (not in the results) and
`already_known`. `addedVia` is `mdns` when the device was found by mDNS, otherwise `sweep`; a device found only through
an address you typed (a target) is `manual`. Adopting an ignored id un-ignores it.

```bash
curl -s -X POST http://localhost:5180/api/discovery/adopt -H 'Content-Type: application/json' -d '{"ids":["fe5e1fa50000","fe5e1fa50001"]}'
# {"added":[{"id":"fe5e1fa50000","health":"online","addedVia":"manual",...}],"skipped":[]}
```

## Jobs

Everything that takes a while and can fail halfway (SoftAP setup, changing a device's IP address, firmware updates, applying a
backup) is a **job**. The feature starts it through its own endpoint (documented under its heading below) and answers with the
job; from then on the job is read, watched and controlled with the generic endpoints here, and the web app renders every kind
with the same `JobProgress` component. Types: `server/src/types/api-jobs.ts` (`import type { Job } from "@shared/api"`).

```jsonc
{
  "id": "5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44",
  "kind": "ota",                       // setup | ip-change | ota | backup-apply
  "title": "Update 2 devices to 0.2.0",
  "state": "running",
  "steps": [                           // job-level steps; may be [] for bulk jobs
    { "id": "upload", "label": "Sending the firmware", "status": "running", "progress": 0.4, "detail": "Bench node", "startedAt": "2026-11-10T09:00:01.000Z" },
    { "id": "verify", "label": "Checking the new firmware", "status": "pending" }
  ],
  "progress": 0.2,                     // 0..1 overall, null = indeterminate
  "message": "Sending to Bench node",  // current status line for a person
  "deviceIds": ["fe5e1fa50000", "fe5e1fa50001"],
  "devices": [                         // one row per device (empty for setup jobs until a device is known)
    { "deviceId": "fe5e1fa50000", "name": "Bench node", "state": "running", "step": "upload", "progress": 0.4 },
    { "deviceId": "fe5e1fa50001", "state": "queued" }
  ],
  "params": { "version": "0.2.0" },    // public summary of the request; never secrets
  "error": null,                       // { code, message, step?, details? } when failed
  "actions": ["cancel"],               // what you may do right now
  "createdAt": "...", "updatedAt": "...", "startedAt": "...", "finishedAt": null
  // "result": kind-specific outcome, once there is one
}
```

**`state`**

| State | Meaning | `actions` |
|---|---|---|
| `queued` | created, the body has not started (a few milliseconds) | `cancel` |
| `running` | working | `cancel`, and `pause` for jobs that support it |
| `paused` | held at its next safe point | `cancel`, `resume` |
| `cancelling` | cancel was asked; the job is winding down (undoing what it can, putting this PC's network back ...) | none |
| `succeeded` | finished, everything worked (`progress` is 1) | none |
| `failed` | finished, `error` says why; with devices: none of them succeeded | `retry` when the kind supports it |
| `partial` | finished with devices: some succeeded and some did not (the rows say which) | `retry` when supported |
| `cancelled` | finished after a cancel; anything not started is `cancelled` / `skipped` | `retry` when supported |
| `interrupted` | the Manager stopped (closed, crashed, was killed) while the job was unfinished; only ever seen on jobs loaded from the history after a restart. `error.code` is `interrupted`, `message` is "The Manager stopped while this job was running"; unfinished steps became `failed` / `skipped`, devices `failed` / `skipped`. Whatever the job already changed on a device stays as it was: check the device | none |

`succeeded`, `failed`, `partial`, `cancelled` and `interrupted` are final: the job never changes again. Always read `actions` instead of
guessing from `state`.

**`steps[].status`**: `pending` · `running` · `done` · `failed` · `skipped` · `cancelled`. `detail` is an optional second line,
`progress` (0..1) is set while the step has a measurable progress. When a job ends, a step still `running` becomes `done`
(success), `failed` (failure) or `cancelled`; steps still `pending` become `skipped` (or `cancelled` after a cancel).

**`devices[].state`** (multi-device jobs): `queued` · `running` · `done` · `failed` · `skipped` · `cancelled` · `rolled_back`
(the device undid the change by itself, for example after a firmware that did not start) · `reverted` (the Manager undid it).
`step` names the step the device is on, `message` is a line for a person, `error` the device's own `{ code, message }`, `result`
a kind-specific outcome. A job with devices ends `succeeded` when no device failed, `partial` when some `done` and some
`failed` / `rolled_back` / `reverted` / `cancelled`, and `failed` when none succeeded (then `error` is the first device error).

**`error`**: `code` is a snake_case machine code (each feature documents its own), `message` is plain words meant to be shown to
a person, `step` the step that failed. An unexpected bug in a job body is `internal_error` ("Something went wrong inside the
Manager"); the details are only in the server log.

**No secrets.** `params` is a public summary of the request. Before a job is stored, every key that matches
`/pass|psk|secret|token|key$/i` is removed, at any depth (`password`, `wifiPsk`, `apiSecret`, `authToken`, `apiKey` ...). A
test asserts that a password given to a job never appears in any response or WebSocket message. Features must not put secrets in
`result`, `message` or `error.details` either.

**Retention and history.** The service keeps every active job plus the last 50 finished ones. Jobs are also written to
`<data dir>/jobs.json` (the public `Job` objects exactly as this API returns them; `params`, `result`, device `result` and
`error.details` are stripped of secret-looking keys again on write; atomic write, debounced, bounded to the same 50 finished
jobs; flushed when the Manager closes). After a restart the file is loaded: finished jobs are back in `GET /api/jobs` and
`GET /api/jobs/:id` (with `actions: []`: nothing can run for them any more), and jobs that were queued, running, paused or
cancelling when the Manager stopped are listed as `interrupted`. A restored job cannot be retried: `POST /api/jobs/:id/retry` on it is
`409 job_action_unavailable` ("kept from before the Manager restarted ... start the action again from its own screen"). An unreadable
or corrupt `jobs.json` is logged and renamed to `jobs.json.corrupt-<time>`, the history starts empty, the Manager still starts.
Asking for a job that was dropped is `404 not_found`.

**WebSocket.** Every change of a job is pushed to all browsers as `{ "t": "job", "job": Job }` (the whole job, so the newest
message replaces what you have). Updates of one job are throttled to one message per 150 ms; the final state is always sent at
once, never delayed. A browser that connects later should `GET /api/jobs` once.

```bash
curl -s http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44   # poll, or watch the WebSocket (see below)
```

Error codes: `404 not_found` (unknown or dropped job), `409 job_action_unavailable` (pause / resume / retry when the action is not
in `actions`; `details` has the current `state` and `actions`), `400 invalid_query`.

### GET /api/jobs

Active jobs and the most recent finished ones, newest first. Query: `kind` (`setup`, `ip-change`, `ota` or `backup-apply`) and
`active` (`true` = not finished yet, `false` = finished).

```bash
curl -s 'http://localhost:5180/api/jobs?active=true'
curl -s 'http://localhost:5180/api/jobs?kind=ota&active=false'
# [{"id":"5b0d7e0e-...","kind":"ota","title":"Update 2 devices to 0.2.0","state":"succeeded","progress":1,...}]
```

### GET /api/jobs/:id

One job. `404 not_found` when the id is unknown or the finished job was dropped.

```bash
curl -s http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44
```

### POST /api/jobs/:id/cancel

Asks the job to stop. Answers `200` with the job in state `cancelling`; it becomes `cancelled` when the job has wound down
(this can take a few seconds: a setup job puts this PC's network back first). Idempotent: a finished or already cancelling job is
returned unchanged.

```bash
curl -s -X POST http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44/cancel
# {"id":"5b0d7e0e-...","state":"cancelling","actions":[],...}
```

### POST /api/jobs/:id/pause

Pauses a running job that lists `pause` in `actions`; it stops at its next safe point. `409 job_action_unavailable` otherwise.

```bash
curl -s -X POST http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44/pause
```

### POST /api/jobs/:id/resume

Continues a paused job (`resume` in `actions`). `409 job_action_unavailable` otherwise.

```bash
curl -s -X POST http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44/resume
```

### POST /api/jobs/:id/retry

Retries a finished job that lists `retry` in `actions` (`failed`, `partial` or `cancelled`, for kinds that support it). It usually
starts a **new** job and answers with it: follow the returned `id` from then on. A job can be retried once; after that `retry`
is gone from its `actions`. `409 job_action_unavailable` otherwise, also for a job restored from `jobs.json` after a restart.

```bash
curl -s -X POST http://localhost:5180/api/jobs/5b0d7e0e-3c8a-4f0b-9a7e-8f6d1c2b3a44/retry
```

## SoftAP setup

Set up a new board (or recover one that lost its Wi-Fi) over the device's own setup Wi-Fi (`esp32-<last 6 hex of its id>`).
The Manager temporarily moves **this PC's** Wi-Fi onto that network, talks to the device at `192.168.4.1`, sends it your
network's name and password, puts this PC's Wi-Fi back and waits for the device on your network. A run is a job of kind
`setup` (see "Jobs"); types are in `server/src/types/api-setup.ts`.

### GET /api/setup/adapter

Whether the Manager can control this PC's Wi-Fi: `{ kind: "fake"|"system"|"none", supported, reason, interfaceName, connectedSsid, localAddress }`.
`reason` is plain words when `supported` is false.

```bash
curl -s http://localhost:5180/api/setup/adapter
```

### GET /api/setup/aps

Devices in setup mode that are visible right now: `{ supported, reason, aps: [{ ssid, idSuffix, secured, signal, knownDeviceId }], scannedAt }`.
Only networks named `esp32-` plus six hex characters are listed. `knownDeviceId` is set when a device of the fleet has that id suffix.
`?refresh=true` scans again; without it the last scan is returned (the first call always scans).

```bash
curl -s 'http://localhost:5180/api/setup/aps?refresh=true'
```

### POST /api/setup/jobs

Starts a setup job (201, a `Job` of kind `setup`). Body: `{ ssid, apPassword?, deviceId?, wifi?: { ssid, password? }, factoryResetFirst? }`.
`deviceId` turns on recover mode (the device found must have that id). Without `wifi` the job stops at the `choose` step and waits
(see the next route). `409 setup_running` when another setup job is active, `409 adapter_unsupported`, `409 recovery_pending` (an earlier
run left a crash marker: restore or dismiss it first), `400 invalid_body` (also when `deviceId` does not match the setup Wi-Fi's name).

```bash
curl -s -X POST http://localhost:5180/api/setup/jobs -H 'Content-Type: application/json' \
  -d '{"ssid":"esp32-d4e5f6","wifi":{"ssid":"HomeNet","password":"secret"}}'
```

### POST /api/setup/jobs/:id/wifi

Answers the `choose` step. Body `{ ssid, password?, factoryResetFirst? }`; returns the job. `409 job_not_waiting` when the job is not
waiting for a choice (also for an unknown or foreign job id: `404 not_found`). While it waits, `job.result` is
`{ networks: [{ ssid, rssi, secure }], device: { id, name, fw, app_version } }` and `job.message` is "Choose the network for the device".
Waiting ends after 180 s with `choose_timeout`.

```bash
curl -s -X POST http://localhost:5180/api/setup/jobs/<jobId>/wifi -H 'Content-Type: application/json' -d '{"ssid":"HomeNet","password":"secret"}'
```

### GET /api/setup/recovery

`{ pending, marker }`. `pending` is true when a previous run stopped (crash, power loss) before it put this PC's Wi-Fi back.
`marker` is `{ jobId, startedAt, originalSsid, profiles }` (never a password). The Manager never switches networks by itself at start-up.

```bash
curl -s http://localhost:5180/api/setup/recovery
```

### POST /api/setup/recovery/restore

Reconnects this PC to the remembered network, deletes leftover temporary profiles and clears the marker: `{ restored, message }`.
When it cannot rejoin, `restored` is false and the marker is kept so you can try again.

```bash
curl -s -X POST http://localhost:5180/api/setup/recovery/restore
```

### POST /api/setup/recovery/dismiss

Forgets the marker without touching the network (204).

```bash
curl -s -X POST http://localhost:5180/api/setup/recovery/dismiss
```

### Job steps and errors

Steps, in order (a step that does not apply ends `skipped`): `remember` Remember this PC's Wi-Fi · `join_ap` Join the device's
setup Wi-Fi · `fingerprint` Check the device · `scan` Look for networks · `choose` Choose a network · `factory_reset` Factory reset ·
`send_wifi` Send Wi-Fi details · `check_result` Check the device's answer · `leave_ap` Rejoin this PC's Wi-Fi · `wait_lan` Wait for the
device on your network · `add` Add to the fleet.

`job.result` on success: `{ deviceId, host, name, added }`. `job.params` has only `ssid`, `wifiSsid`, `deviceId`, `factoryResetFirst`:
**passwords are never stored or returned anywhere** (a test checks every response, WebSocket message, file and log line).

Error codes (`job.error.code`): `adapter_unsupported`, `ap_not_found`, `ap_password_wrong`, `device_not_responding`, `not_our_device`,
`wifi_auth`, `wifi_no_ap`, `wifi_no_ip`, `wifi_failed`, `device_not_on_lan`, `restore_failed` (this PC could not rejoin its network:
use the recovery routes), `choose_timeout`, `cancelled`, plus `adapter_failed` (this PC's Wi-Fi refused a command, for example saving
the temporary network) and `factory_reset_failed`. Cancel with `POST /api/jobs/:id/cancel`: the network is always put back first.

**Side effects.** While the job runs, this PC leaves its normal Wi-Fi for about a minute. A browser on ANOTHER machine (Manager in
LAN mode) loses the Manager during that time; reload it afterwards and the job result is still readable (`GET /api/jobs`).

**Trying it without hardware.** Start the Manager with the simulated Wi-Fi and a simulated device in setup mode (nothing touches your network):

```bash
npm run fake -- --count 1 --base-port 8211 --ap-mode
node dist/server.cjs --port 5281 --no-open --no-network-scan --wifi-adapter fake \
  --fake-ap "esp32-130000=127.0.0.1:8211,secured=apsecret1,lan=127.0.0.1:8211" --data-dir .data/setup
```

`--fake-ap <ssid>=<host:port>[,secured=<password>][,lan=<host:port>]` (repeatable) declares a simulated access point; `host:port` is where
"192.168.4.1" really is, `lan` where the device shows up on the network afterwards.

## IP address

Change a device's Wi-Fi address between automatic (DHCP) and a fixed (static) one. Needs firmware that reports `ip_mode`
(`GET` says `supported: false` otherwise). Types: `server/src/types/api-ip.ts` (`import type { IpSettings } from "@shared/api"`).

How a change works: the Manager sends `network.ip.set`; the device answers, then applies it about 1.5 s later. For a static
address the device must be confirmed **at the new address** within 90 s or it goes back to its previous setting by itself.
The job reaches the device at the new address, sends `network.ip.confirm`, and only then updates the address the Manager
stores. Switching to DHCP confirms itself when the device gets a lease; the job finds the device by its id.

The job is `kind: "ip-change"` (see "Jobs") with steps `check` "Check the device", `send` "Send the new settings",
`apply` "Device applies them", `reach` "Reach it at the new address", `confirm` "Confirm (keeps the change)" (the detail line
shows the seconds left) and `save` "Update the Manager's address". `job.result` is
`{ outcome: "ok"|"reverted"|"no_dhcp_lease"|"failed"|"unknown", reason: string|null, host: string|null, ipMode: "dhcp"|"static" }`.
**When the device cannot be reached at the new address** the job does not fail at once (the device undoes the change by itself
when the confirm window closes). The `reach` step ends `failed` and a step `revert` "Waiting for the device to go back to its
previous setting" is added. Its `detail` counts down ("42 seconds left. Checking 192.168.1.42."; the window is
`ip_change.confirm_left_s` from the device's reply to `network.ip.set` when it gave one, else the configured window, 90 s) while
the job polls the **old** address. The job then ends:
`failed` / `reverted` when the device answers at the old address with `ip_change.result` `reverted` (or `failed`, or no record
after the window): message "Could not reach the device at 192.168.1.50; it went back to 192.168.1.42 (DHCP) by itself. Nothing was
changed.", `result.outcome` `reverted`; or `failed` / `not_reachable` when the device is not seen at the old address within the
window plus a margin (10 s): the message says it may still be at the new address on another network, to run a scan, and to use
the device's own setup Wi-Fi if it does not show up; `result.outcome` `unknown`. The stored host is unchanged in both cases.
Cancelling while waiting ends the job `cancelled` with a message that the Manager stopped waiting.

Job error codes: `reverted` (the device went back to its previous setting; before: after a failed reach or an unconfirmed
change), `not_reachable` (not seen at the new or the old address; replaces `not_reachable_new_address` of earlier versions),
`no_dhcp_lease`, `confirm_refused`, `lost_device` (outcome unknown; the stored address is unchanged until discovery finds the
device), `cancelled` (cancelled before the confirm: the device reverts by itself).

### GET /api/devices/:id/ip

Current address settings from the device's status. `ipChange` is the device's own `ip_change` record (snake_case). 404
`unknown_device`; 502 when the device cannot be reached.

```bash
curl -s http://localhost:5180/api/devices/a4cf12b3c4d5/ip
# {"supported":true,"reason":null,"ipMode":"dhcp","ip":"192.168.1.42","netmask":"255.255.255.0","gateway":"192.168.1.1",
#  "dns":"192.168.1.1","staConnected":true,"ipChange":{"result":"none"},"activeJobId":null}
```

### POST /api/devices/:id/ip/check

Dry run of the same body as `POST /api/devices/:id/ip`. `errors` are rules the device would refuse (field `ip`, `netmask`,
`gateway`, `dns`, or `mode` for the request as a whole). `warnings` never block: `outside_pc_subnets`, `address_in_use`
(another registered device uses it), `same_as_current`. Always 200.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/ip/check -H 'Content-Type: application/json' \
  -d '{"mode":"static","ip":"192.168.1.50","netmask":"255.255.255.0","gateway":"192.168.1.1"}'
# {"ok":true,"errors":[],"warnings":[]}
```

### POST /api/devices/:id/ip

Start the change. Body `{ "mode": "dhcp" }` or `{ "mode": "static", "ip", "netmask", "gateway", "dns"? }` (`dns` defaults to the
gateway). 201 with the `Job`. 422 `invalid_ip_config` (`details` = the errors list), 409 `ip_change_unsupported`,
409 `ip_change_running` (a job for this device is active), 409 `ip_change_refused` (the device said no: no saved Wi-Fi, a Wi-Fi
test running, a change already pending, not connected; the message is the device's words made plain), 502 transport.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/ip -H 'Content-Type: application/json' \
  -d '{"mode":"static","ip":"192.168.1.50","netmask":"255.255.255.0","gateway":"192.168.1.1"}'
curl -s http://localhost:5180/api/jobs/<job id>
```

### Testing without moving a device (loopback)

Fake devices live on 127.0.0.1 and cannot change address. When the stored host is a loopback address the job reaches the
device at that same host and port, and the stored host stays the loopback one. For a manual run,
`--ip-change-map <ip>=<host:port>` (repeatable) maps a new address to the place the job should look; map it to a closed port to
see the revert path (the job then waits for the fake to report `reverted` at its old address; `StartOptions.ipChange.confirmWindowMs` / `revertMarginMs` keep the timing small in tests). This does **not** prove a real address move, ARP or DHCP behaviour, a subnet change, or that the device
is gone from its old address.

## Wi-Fi move

Move a device to another Wi-Fi network ("L1"). Offered only for devices whose firmware reports `wifi_change` (the safe Wi-Fi change:
the device keeps its saved network until the new one has joined **and** got an address, and goes back to the old one if that fails).
`GET` says `supported: false` otherwise. Types: `server/src/types/api-wifimove.ts` (`import type { WifiMoveSettings } from "@shared/api"`).

How a move works: the Manager sends `network.wifi.set` (the device tests the network for up to 20 s and may answer, or may stop
answering when it changes network; both are normal). The job then compares the device's own `wifi_change.seq` with the value it read
before and looks for the device **by its id**: at the old address and at every discovery target, plus mDNS and a sweep when network
scanning is on (`--no-network-scan` turns those two off; typed `discoveryTargets` in the settings are always probed). It ends:

- `succeeded`: the device is on the new network. The stored address is updated, health is polled. `job.result.addressChanged` says
  whether the address is a new one. A static address is reset to DHCP by the device (`ip_change.result` `reset`): `result.staticIpReset`.
- `failed` with the device's reason, when its `wifi_change` says `failed` with a newer `seq`: `auth` (wrong password), `no_ap`
  (network not found), `no_ip` (joined but no address from the router), `timeout`, `connect_failed`, `save_failed` (joined but could
  not save: the device returns to the old network at its next restart; `restoredPrevious` is false). Otherwise the device went back to
  its previous network (`result.restoredPrevious` true) and the message says so. The device is also looked for at its (possibly new)
  address on the old network, and the stored address follows.
- `failed` / `not_found`: not seen again within the wait (default 90 s, `timeoutS` per request). The message explains that it may be on a
  network this PC cannot reach and how to recover: connect this PC to that network and scan, or use "Recover over its setup Wi-Fi"
  (the device raises its own setup Wi-Fi after about 60 s without a network).
- `failed` / `device_refused`: the device answered `ok:false` and its record explains nothing; the message carries the device's words.
- `cancelled`: the Manager stopped waiting. The device may already have moved; `result.outcome` is `unknown`.

The job is `kind: "wifi-move"` (see "Jobs") with steps `check` "Check the device", `send` "Send the new network", `switch` "Device tries
the new network", `find` "Find the device again" and `save` "Update the Manager's address". `job.result` is
`{ outcome: "ok"|"failed"|"not_found"|"unknown", ssid, reason: string|null, reasonCode: string|null, restoredPrevious: boolean|null,
oldHost, newHost: string|null, addressChanged, staticIpReset }`. `job.params` is `{ ssid, open }`.
**The password is held in memory for the job only**: it is in no job field, WebSocket message, log line or data file (a test searches
for it everywhere). The job cannot be retried (the password is gone); start a new one.

Error codes: HTTP `wifi_change_unsupported` (409), `device_offline` (409), `device_busy` (409: a firmware update or a Wi-Fi test is
running), `job_running` (409), `invalid_wifi_config` (422, `details` = list of `{ field: "ssid"|"password", message }`),
`unknown_device` (404), 502 transport. Job error codes: `auth`, `no_ap`, `no_ip`, `timeout`, `connect_failed`, `save_failed`,
`wifi_failed` (a failure the device gave no known reason for), `device_refused`, `not_found`.

### GET /api/devices/:id/wifi

The device's Wi-Fi state: `supported` (it reports `wifi_change`) with a plain `reason` when not, `state`, `connected`, `ip`, `hostname`,
`ipMode`, `staticIp`, `lastChange` (its own record with `words` in a sentence; null while it has nothing to report), the network
this PC is on (`pcSsid`; `pcSsidKnown` false when the Wi-Fi adapter cannot tell), `setupApAvailable` (this PC can join a device's
setup Wi-Fi) and `activeJobId`. The device does not report which network it joined, so there is no "current SSID". 404
`unknown_device`; 502 when the device cannot be reached. To list networks the device can see, use
`GET /api/devices/:id/v1/network/scan` (it blocks the device for a few seconds).

```bash
curl -s http://localhost:5180/api/devices/a4cf12b3c4d5/wifi
# {"supported":true,"reason":null,"state":"sta_connected","connected":true,"ip":"192.168.1.42","hostname":"esp32-b3c4d5",
#  "ipMode":"dhcp","staticIp":false,"lastChange":null,"pcSsid":"HomeNet","pcSsidKnown":true,"setupApAvailable":true,"activeJobId":null}
```

### POST /api/devices/:id/wifi/check

Dry run of the same body as the move. `errors` (field `ssid`, `password`, or `device` for the device as a whole: unsupported, not
answering, testing a change right now) block it. `warnings` never block: `pc_other_network` (this PC is on another network and may not
reach the new one), `pc_network_unknown` (the Manager cannot tell), `static_ip_reset`. Always 200. The password is only checked for length.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/wifi/check -H 'Content-Type: application/json' \
  -d '{"ssid":"workshop-wifi","password":"correct-horse-battery"}'
# {"ok":true,"errors":[],"warnings":[{"code":"pc_other_network","message":"This PC is on \"HomeNet\", not on \"workshop-wifi\". ..."}]}
```

### POST /api/devices/:id/wifi

Start the move. Body `{ "ssid", "password"?, "timeoutS"? }`: SSID 1-32 bytes; password empty or missing (open network) or 8-63 characters;
`timeoutS` 1-600, how long the job looks for the device afterwards (default 90). 202 with the `Job`. Errors as listed above.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/wifi -H 'Content-Type: application/json' \
  -d '{"ssid":"workshop-wifi","password":"correct-horse-battery"}'
curl -s http://localhost:5180/api/jobs/<job id>
```

### Testing without a second network (fake device)

A fake device listens on one loopback port. With `--pending-firmware` it emulates `wifi_change`; `--wifi-move <ssid>=<host:port>`
(repeatable) makes a **successful** Wi-Fi change to that SSID move the device to that address (the old port stops answering, same id and
state). In the fake, the password `wrong-password` is refused (`auth`); the SSIDs `noap`, `noip`, `timeout`, `connect`, `savefail` fail with
`no_ap`, `no_ip`, `timeout`, `connect_failed`, `save_failed`; any other SSID joins. In tests: `startFakeDevice({ pendingFirmware: true,
wifiMoves: { "workshop-wifi": "127.0.0.1:<port>" } })` and `StartOptions.wifiMove` (`findTimeoutMs`, `roundMs`, `intervalMs`, `settleMs`).
This does **not** prove a real subnet change, DHCP, or mDNS on a real router.

Recipe (ports 8221-8223 and 5281 are examples; the id of the device started with `--base-port 8221` is `fe5e203d0000`):

```bash
# 1. a fake device that can move to 8222 (workshop-wifi) or 8223 (neighbour-5g)
npm run fake -- --base-port 8221 --pending-firmware --seed demo \
  --wifi-move workshop-wifi=127.0.0.1:8222 --wifi-move neighbour-5g=127.0.0.1:8223
# 2. the Manager: no mDNS, no sweep, fake PC Wi-Fi adapter, a scratch data dir
node dist/server.cjs --port 5281 --no-open --no-network-scan --wifi-adapter fake --data-dir /tmp/wifimove-demo
curl -s -X POST localhost:5281/api/devices -H 'Content-Type: application/json' -d '{"host":"127.0.0.1:8221"}'
# 3. failed, previous network restored: the job fails with code "auth", the stored address stays 127.0.0.1:8221
curl -s -X POST localhost:5281/api/devices/fe5e203d0000/wifi -H 'Content-Type: application/json' \
  -d '{"ssid":"workshop-wifi","password":"wrong-password"}'
# 4. success: tell the Manager where it may look (a typed target, no scanning), then move
curl -s -X PUT localhost:5281/api/settings -H 'Content-Type: application/json' -d '{"discoveryTargets":["127.0.0.1:8222"]}'
curl -s -X POST localhost:5281/api/devices/fe5e203d0000/wifi -H 'Content-Type: application/json' \
  -d '{"ssid":"workshop-wifi","password":"correct-horse-battery"}'
curl -s localhost:5281/api/devices/fe5e203d0000        # "host":"127.0.0.1:8222" once the job has succeeded
# 5. not found: the fake is at 8222 now; clear the target, then move it to 8223, which the Manager does not know
curl -s -X PUT localhost:5281/api/settings -H 'Content-Type: application/json' -d '{"discoveryTargets":[]}'
curl -s -X POST localhost:5281/api/devices/fe5e203d0000/wifi -H 'Content-Type: application/json' \
  -d '{"ssid":"neighbour-5g","password":"correct-horse-battery","timeoutS":10}'
```

Poll `GET /api/jobs/<id>` (or `GET /api/jobs?kind=wifi-move`) until `state` is final; `error.code`, `error.message` and `result` show the
outcome. The fake's Wi-Fi test takes 2 s, like the firmware's.

## Firmware

The **firmware library** is a folder of de-esp32 images (`<dataDir>/firmware/<sha256>.bin` plus `index.json`). Images come from a
file you upload or from the firmware web page (**Get latest**). One image can be the **target firmware**: every device summary then
says whether it matches it (`fwMatchesTarget`). A device is updated by a **job** of kind `ota` (see "Jobs"): one device, many
devices, or a roll back. Types: `server/src/types/api-firmware.ts` (`FirmwareImage`, `FirmwareListResponse`, `OtaDeviceResult`...).

```jsonc
// FirmwareImage
{ "id": "9f1c...e0", "filename": "de_esp32_runtime.bin", "size": 1199984, "version": "1bf09cc", "project": "de_esp32_runtime",
  "date": "Sep 24 2026", "time": "10:32:26", "idfVer": "v5.4.2", "chip": "esp32", "source": "upload", "addedAt": "2026-11-10T09:00:00.000Z" }
```

An image is only added when it looks right: first byte `0xE9`, the ESP32 chip id, a readable application header, project
`de_esp32_runtime`, 288 bytes to 4 MB. Otherwise `422 invalid_image` with the reason in plain words.

**Update flow of one device** (job steps and device row `step` ids): `checking` (reads the device first) -> `uploading`
(`progress` 0..1) -> `rebooting` (waits for it to come back) -> `verifying` (the new version must report itself, and the image must
become `valid`; up to 60 s are allowed for `pending_verify`). Outcomes per device: `done` (`result: { fromVersion, toVersion,
partition }`), `failed` (`error` says at which step and why; the device keeps running the old firmware when the upload failed),
`rolled_back` (the device restarted but went back to the previous firmware: the new image did not start), `skipped`
(bulk: already on this image), `cancelled`. While a device is in an active `ota` job its summary `health` is `updating`.

Error codes: `404 unknown_device`, `404 unknown_image`, `409 device_offline`, `409 ota_busy` (the device is already writing an
image), `409 pending_verify` (the running image has not confirmed itself yet: wait or roll back), `409 ota_running` (the device is
already in an active update job), `409 rollback_not_possible`, `409 image_in_use`, `422 invalid_image`, `422 image_too_large` (does
not fit the device's next partition), `502 fetch_failed`.

### GET /api/firmware

The library (newest first), the target image id and the state of the last "Get latest".

```bash
curl -s http://localhost:5180/api/firmware
# {"images":[{"id":"9f1c...","filename":"de_esp32_runtime.bin","size":1199984,"version":"1bf09cc","project":"de_esp32_runtime",
#   "date":"Sep 24 2026","time":"10:32:26","idfVer":"v5.4.2","chip":"esp32","source":"upload","addedAt":"2026-11-10T09:00:00.000Z"}],
#  "targetId":null,"latest":{"baseUrl":"https://terraseraph.github.io/esp32-joat/","checkedAt":null,"imageId":null,"error":null}}
```

### POST /api/firmware

Adds an image: the raw file as the request body (`Content-Type: application/octet-stream`), its name in the `X-Filename` header
(optional, default `firmware.bin`). `201` with the new `FirmwareImage`, `200` with the existing one when the same file (same
SHA-256) is already in the library. `422 invalid_image` when it is not a usable image (`details.reason` repeats the message).

```bash
curl -s -X POST http://localhost:5180/api/firmware --data-binary @de_esp32_runtime.bin \
  -H "Content-Type: application/octet-stream" -H "X-Filename: de_esp32_runtime.bin"
```

### POST /api/firmware/latest

Fetches `<firmwareBaseUrl>/firmware/de_esp32_runtime.bin` (setting `firmwareBaseUrl`, default
`https://terraseraph.github.io/esp32-joat/`; change it with `PUT /api/settings`, for example to a local web server) and adds it to
the library like an upload (`source: "latest"`). Answers the `FirmwareImage` (`200` when it was already there, else `201`). The
outcome is also kept in `latest` of `GET /api/firmware`. `502 fetch_failed` when the page cannot be reached or does not answer
with a file; `422 invalid_image` when the file is not a usable image.

```bash
curl -s -X POST http://localhost:5180/api/firmware/latest
```

### DELETE /api/firmware/:fid

Removes an image from the library (and the file). `204`. `404 unknown_image`; `409 image_in_use` while an active update job uses
it. Deleting the target image also clears the target.

```bash
curl -s -X DELETE http://localhost:5180/api/firmware/9f1c0000000000000000000000000000000000000000000000000000000000e0
```

### PUT /api/firmware/target

Chooses the target firmware (`{ "firmwareId": null }` clears it). Stored as setting `firmwareTarget`. Answers like
`GET /api/firmware`. Device summaries then carry `fwMatchesTarget`: `true` when the device's `app_version` and compile date and
time equal the target's, `false` when they differ, `null` without a target or before the device reported a version.
`404 unknown_image`.

```bash
curl -s -X PUT http://localhost:5180/api/firmware/target -H 'Content-Type: application/json' -d '{"firmwareId":"9f1c...e0"}'
```

### POST /api/devices/:id/ota

Starts a firmware update of one device. Answers `201` with the `Job` (kind `ota`, `params.action` = `"update"`, one device row, the
four steps above). Checks first (answered as errors, nothing is sent): `404 unknown_device`, `404 unknown_image`, `409 ota_running`,
`409 device_offline`, `409 ota_busy`, `409 pending_verify`, `422 image_too_large`. Follow the job with `GET /api/jobs/:id` or the
WebSocket; cancel it with `POST /api/jobs/:id/cancel` (an upload in progress is aborted; the device keeps its old firmware).

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/ota -H 'Content-Type: application/json' -d '{"firmwareId":"9f1c...e0"}'
```

### POST /api/devices/:id/rollback

Asks the device to go back to its previous firmware (`ota.rollback`; the device restarts) and checks that it came back on the other
partition. `201` with the `Job` (kind `ota`, `params.action` = `"rollback"`). `409 rollback_not_possible` when the device has no
previous firmware (`ota.rollback_possible` is false), plus `404 unknown_device`, `409 device_offline`, `409 ota_running`.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/rollback
```

### POST /api/firmware/update

Updates many devices with one image: `{ "deviceIds": [...], "firmwareId": "...", "concurrency": 2, "stopOnFailures": 1, "skipSame": true }`
(`concurrency` 1-4, default 2; `stopOnFailures` default 1; `skipSame` default true). `201` with the `Job` (kind `ota`,
`params.action` = `"bulk"`) that supports pause, resume and retry. A device that is offline, busy or still in `pending_verify` fails
alone with the reason in its row; the others carry on. After `stopOnFailures` devices failed or rolled back the job **pauses
itself** (`state: "paused"`, `message` says why; devices already started finish): `POST /api/jobs/:id/resume` continues,
`.../cancel` stops. Cancel aborts uploads in progress and starts no further devices. `retry` starts a **new** job with only the
devices that failed, rolled back or were cancelled. `404 unknown_device` / `unknown_image`, `409 ota_running` (one of the devices is
already in an active update job; `details.deviceIds`). Job `result`: `{ updated, skipped, failed, rolledBack, cancelled }`.

```bash
curl -s -X POST http://localhost:5180/api/firmware/update -H 'Content-Type: application/json' \
  -d '{"deviceIds":["a4cf12b3c4d5","a4cf12b3c4d6"],"firmwareId":"9f1c...e0","concurrency":2}'
```

## Backups

A backup is a JSON file the Manager stores in `<dataDir>/backups/<id>.json` (spec 3.8, `server/src/types/api-backups.ts`):
`{kind:"de-esp32-backup", v:1, createdAt, manager, source:{id,name,app_version,board_id?}, name, pins[], modules[], rules[], mqtt|null, gaps[], note?}`.
Each pin has `_from: "shadow"|"live"` (shadow = the exact `pin.configure` the Manager last sent; live = derived from the device's
state, which does not report invert, pulls, boot or irq). `gaps` lists what the device would not tell us, as stable tokens:

| Token | Plain label |
|---|---|
| `wifi` | Wi-Fi network and password are not readable |
| `ap_password` | Setup access point password is not readable |
| `mqtt_credentials` | MQTT user name and password are not readable (never stored) |
| `pin:<gpio>:invert/pull/boot` (output) · `pin:<gpio>:invert/pull/irq` (input) | Options of that pin that could not be read; restored with defaults |
| `modules_unavailable` / `rules_unavailable` | The device did not report its add-ons / rules; restoring leaves them alone |

**Plan** = the steps that make a target match the backup, diffed against the target's live state (nothing is sent for what already
matches). Order: remove rules not in the backup, remove add-ons not in the backup (or of another type), disable pins not in the
backup, `pin.configure` each changed pin, `module.add` / `module.configure`, `rule.set`, `mqtt.configure`, `identity.set_name`.
A step that cannot succeed (a backup pin on a GPIO an add-on that stays owns, or the other way round) is left out of `steps` and
reported in `conflicts`. MQTT: only `uri` and `root` are sent; the device keeps the user name and password it already has (it only
writes credentials when the command carries a `user`). A backup cannot switch MQTT off.

**Apply** re-plans each target against its live state when the job runs, then sends the steps through the normal command path (pin
shadow and rename bookkeeping included). A failing step stops that target only; the device's own message is in the row's `error`,
the step id in `error.step`, and `result` is `{applied, total, failedStep?}`. The job ends `succeeded`, `partial` or `failed` from the
device rows. Retry (`POST /api/jobs/:id/retry`) re-runs the targets that did not finish. Error codes: `device_offline` (409, the device
is known to be offline), `invalid_backup` (422), `unknown_backup` (404), `unknown_device` (404), `invalid_targets` (400, e.g. a clone
onto its own source), `device_unreachable`/`device_timeout`/... (502, `transport:true`).

### GET /api/backups

Stored backups, newest first. Query `deviceId` keeps only backups made from that device. Returns `BackupMeta[]`:
`{id, createdAt, source:{id,name,app_version}, name, counts:{pins,modules,rules}, gaps, size, note}`.

```bash
curl -s 'http://localhost:5180/api/backups?deviceId=a4cf12b3c4d5'
# [{"id":"bk_20261110T101500_3fa9c2","createdAt":"2026-11-10T10:15:00.000Z","source":{"id":"a4cf12b3c4d5","name":"Workshop node","app_version":"9dcba89"},"name":"Workshop node","counts":{"pins":5,"modules":1,"rules":1},"gaps":["wifi","ap_password","mqtt_credentials","pin:4:invert/pull/boot"],"size":1234,"note":""}]
```

### POST /api/devices/:id/backup

Reads the device (pins, add-ons, rules, MQTT settings, name, board) and stores a backup. Optional body `{note}`. `201` with the
`BackupMeta`. `409 device_offline`, `404 unknown_device`, `502` when the device cannot be reached.

```bash
curl -s -X POST http://localhost:5180/api/devices/a4cf12b3c4d5/backup -H 'Content-Type: application/json' -d '{"note":"before rewiring"}'
```

### GET /api/backups/:bid

The backup file. `?download=1` adds `Content-Disposition: attachment; filename="<name>-<date>.json"`. `404 unknown_backup`.

```bash
curl -s 'http://localhost:5180/api/backups/bk_20261110T101500_3fa9c2?download=1' -o backup.json
```

### POST /api/backups/import

Body is a backup file (as downloaded). It is validated strictly; `422 invalid_backup` with a plain reason otherwise. `201` with the `BackupMeta` (a new id; `createdAt` is kept).

```bash
curl -s -X POST http://localhost:5180/api/backups/import -H 'Content-Type: application/json' --data-binary @backup.json
```

### PATCH /api/backups/:bid

Body `{note}`. Returns the `BackupMeta`.

```bash
curl -s -X PATCH http://localhost:5180/api/backups/bk_20261110T101500_3fa9c2 -H 'Content-Type: application/json' -d '{"note":"known good"}'
```

### DELETE /api/backups/:bid

Deletes the file. `204`.

```bash
curl -s -X DELETE http://localhost:5180/api/backups/bk_20261110T101500_3fa9c2
```

### POST /api/backups/:bid/plan

Body `{targetIds, include?}` where `include` is `{pins?, modules?, rules?, mqtt?, name?}`; `pins`, `modules`, `rules` and `mqtt` default to true, **`name` defaults to false** (a restore does not rename the device unless you send `include.name: true`; earlier versions defaulted it to true). The plan has an `identity.set_name` step only when `name` is true and the names differ. Returns
`{plans: BackupPlan[]}`, one per target in the order given: `{targetId, targetName, reachable, error, steps:[{id, op, summary, cmd}], conflicts:[{message}], warnings:[string], unchanged:{pins,modules,rules}}`.
An unreachable target has `reachable:false`, a plain `error` and no steps. Nothing is sent to a device except reads.

```bash
curl -s -X POST http://localhost:5180/api/backups/bk_20261110T101500_3fa9c2/plan -H 'Content-Type: application/json' \
  -d '{"targetIds":["b1c2d3e4f5a6"],"include":{"name":false}}'
# {"plans":[{"targetId":"b1c2d3e4f5a6","targetName":"Bench","reachable":true,"error":null,"steps":[{"id":"pin.configure:4","op":"pin.configure","summary":"Set GPIO 4 to output","cmd":{"cmd":"pin.configure","gpio":4,"mode":"out"}}],"conflicts":[],"warnings":[],"unchanged":{"pins":0,"modules":0,"rules":0}}]}
```

### POST /api/backups/:bid/apply

Same body as the plan. Starts a `backup-apply` job (one device row per target) and returns it with `201`. Follow it with
`GET /api/jobs/:id` or the WebSocket. Device row `result`: `{applied, total, failedStep?}`.

```bash
curl -s -X POST http://localhost:5180/api/backups/bk_20261110T101500_3fa9c2/apply -H 'Content-Type: application/json' \
  -d '{"targetIds":["b1c2d3e4f5a6"]}'
```

### POST /api/clone/plan

Body `{sourceId, targetIds, include?}`. Takes a fresh snapshot of the source (not stored) and plans it onto each target. `name`
defaults to **false** here, as for a restore (opt in with `include.name: true`). `400 invalid_targets` when a target is the source; `409 device_offline` / `502` when the source cannot be read.

```bash
curl -s -X POST http://localhost:5180/api/clone/plan -H 'Content-Type: application/json' -d '{"sourceId":"a4cf12b3c4d5","targetIds":["b1c2d3e4f5a6"]}'
```

### POST /api/clone

Same body (plus optional `saveSnapshot: true` to also keep the snapshot as a normal backup). Starts a `backup-apply` job and returns it with `201`.

```bash
curl -s -X POST http://localhost:5180/api/clone -H 'Content-Type: application/json' -d '{"sourceId":"a4cf12b3c4d5","targetIds":["b1c2d3e4f5a6"],"saveSnapshot":true}'
```

## Browser WebSocket: `/api/ws`

Connect with `ws://localhost:5180/api/ws` (same Host/Origin/token rules as HTTP; a plain GET returns 426).
Frames are JSON text: `{ "t": "<type>", ... }`. The server pings every 30 s and drops sockets that stop answering.

Server to browser (types are in `server/src/types/api.ts`, `BrowserWsMessage`):

| `t` | Payload | When |
|---|---|---|
| `hello` | `{ server: { version, lan } }` | right after connecting |
| `access` | `{ lan }` | LAN access was switched on or off (`PUT /api/access`); never carries the token. Re-read `GET /api/health` / `GET /api/access` |
| `devices` | `{ list: DeviceSummary[] }` | right after `hello`: the full list (sorted by title) |
| `device` | `{ id, summary: DeviceSummary }` | a summary changed (health, a poll result, label/notes/host edit, queue depth, a new device). Bursts are coalesced (100 ms) and identical summaries are not re-sent |
| `deviceRemoved` | `{ id }` | the device was forgotten (`DELETE /api/devices/:id`); an addition to the spec |
| `scan` | `{ phase, probed, total, found: DiscoveryResult[] }` | discovery progress: `phase` is `mdns`, `sweep`, then `done` / `cancelled` / `error`. Sent at every phase change and at the end, otherwise at most 4 per second; `found` is every result so far. Background scans (see settings) send only their final message |
| `job` | `{ job: Job }` | a job changed (see [Jobs](#jobs)): the whole job, every change, at most one message per job per 150 ms, the final state always at once |
| `cmdResult` | `{ id, corr?, res }` | answer to a browser `cmd`: the device envelope `{ v, ok, result?, error? }` (transport failures and the 10 s timeout are `ok:false` with an `error` string) |
| `link` | `{ id, ws }` | watched devices only: link state `open` · `connecting` · `closed` · `full`, on watch and on every change |
| `live` | `{ id, io, telemetry }` | watched devices only: full snapshot (`io` replaces what you have; `telemetry` may be `null`). Sent when a socket starts watching (if anything is cached) and after each device-socket (re)open once the `io.hydrate` burst settled |
| `io` | `{ id, topic, data }` | watched devices only: one I/O change (`io/gpio`, `io/adc`, `io/pwm`, `io/servo`, `io/env`, `io/rfid`; `data.id` is the state key, except for add-on modules (`io/env`, `io/rfid`), whose key in `live.io` is `mod_<data.id>`). Synthesised from `GET /pins` polls while the link is `full` or `connecting` |
| `event` | `{ id, topic, data }` | watched devices only: `telemetry` (every 15 s), `net`, `ota/progress`, `identity/rename` and unknown future topics. `mqtt/reconfigure` is dropped (it carries the MQTT password) |

Browser to server (unknown `t` values are ignored):

| `t` | Payload | Effect |
|---|---|---|
| `watch` | `{ ids: string[] }` | replaces this socket's watch set (`[]` = none). Ids not in the registry are ignored |
| `cmd` | `{ id, corr?, body: { cmd, ... } }` | one device command; answered with `cmdResult` (same `corr`). Goes over the device socket when the link is `open` (no 1536 B limit), otherwise over HTTP through the device queue; pin shadow / rename / expected-restart bookkeeping as for `POST /api/devices/:id/command` |

**Device link (spec 3.6).** The server keeps **at most one** WebSocket per device, opened only while at least one browser socket
watches that device, and closed 10 s after the last watcher leaves (or at once when the device is forgotten). On every open it
sends `{"cmd":"io.hydrate"}` so the device re-publishes its I/O. A dropped socket reconnects with backoff 1 s, 2 s, 4 s ... 30 s
(immediately when the health poller sees the device come back). A socket that is open but receives no event frame within 20 s
is `full`: the device already has 4 live viewers and ignores a 5th (it still answers commands); the server then polls
`GET /pins` every 5 s and keeps the socket for commands. While watched, `identity/rename` events update the stored name.

Details worth knowing: **health polling pauses while a device is live.** "Live" means a browser watches the device, the link is
`open` and an event frame arrived within the live window (the larger of 20 s and twice the telemetry interval the server has
seen). While live, the poller does not call `GET /status` for the device; every event frame keeps `lastSeen` fresh (written to
the registry at most every 5 s) and the health state `online`, and each `telemetry` frame refreshes the cached summary fields
(`uptime_s`, `rssi`, `memory`, `mqtt`, `ota`, attention flags, I/O counts; `safe_reason` and the compile time keep their last
`/status` values). The moment the link closes, becomes `connecting` or `full`, the frames stop for longer than the window, or
the last watcher leaves, the device is polled **at once** and the normal interval resumes. A restart window the Manager opened
(`rebooting`), an active firmware job (`updating`) and an explicit refresh (`POST /api/devices/:id/refresh`) behave as before.
While `connecting` or `full`, the first poll result is sent as a `live` snapshot, later polls only as `io` for changed keys
(a poll that finds keys gone sends `live` again, since `io` cannot express removal). `system.reboot`, `system.factory_reset`,
`ota.rollback` and the slow `network.wifi.set` / `network.wifi.scan` always take the HTTP path, whatever the link state.

```bash
node -e 'const W=require("ws");const s=new W("ws://localhost:5180/api/ws");s.on("message",m=>{console.log(String(m));s.close()})'
```
