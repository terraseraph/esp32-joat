# Working in manager/ (conventions for agents and contributors)

Per-feature docs: `docs/<name>.md` (sisters of `../docs/features/<name>.md`). Prototypes in `proto/` are read-only design references.

## Layout

```
server/src/  main.ts (CLI)  cli.ts  app.ts (start())  appContext.ts  net.ts  publicDir.ts  version.ts
             http/  router.ts openapi.ts security.ts static.ts errors.ts
             api/   index.ts (THE route table) + one file per area (server.ts settings.ts devices.ts discovery.ts proxy.ts, helpers deviceCall.ts)
             discovery/ index.ts (service) mdns.ts sweep.ts
             device/ client.ts (HTTP client + per-device pool) queue.ts hostAddr.ts health.ts (poller) summary.ts
             ws/    browserHub.ts      store/ atomicWrite.ts settings.ts registry.ts dataDir.ts
             types/ api.ts (Manager API schemas+types)  shared-lib.d.ts (types for node-red-contrib-de-esp32/lib/*)
server/fake/  fake device (npm run fake)
web/         index.html vite.config.ts   src/ main.tsx App.tsx styles/
scripts/     dev.mjs bundle.mjs          API.md  README.md
```

Files are `camelCase.ts` (`browserHub.ts`); React components `PascalCase.tsx`.

## Adding a route

1. Put it in `server/src/api/<area>.ts` (new file = `export const fooRoutes = [defineRoute(...), ...]`) and spread that array into `api/index.ts`. The router and `/api/openapi.json` both read that one table.
2. Shape (TypeBox schemas, all but `method/path/summary/tags/response/handler` optional):

   ```ts
   defineRoute({
     method: "GET", path: "/api/devices/:id", summary: "Get a device", tags: ["devices"],
     params: Type.Object({ id: Type.String() }),
     query: Type.Object({ fresh: Type.Optional(Type.Boolean()) }),   // strings are coerced per schema
     body: SomeSchema,                                               // JSON body, validated; 415 if not JSON
     response: DeviceSummarySchema,                                  // the 200 body
     responses: { 404: { description: "Unknown device" } },
     handler: async ({ params, query, body, app, req, res }) => ({ status: 200, body: { ... } }),
   })
   ```

   Paths: `:name` params, trailing `*` gives `params.wildcard` (undecoded). Literal segments beat `:params`. `rawBody: true` skips body parsing and gives the handler the request stream (uploads/proxy); write to `res` yourself and return nothing.
3. Schemas and `Static` types for anything the web app needs go in `server/src/types/api.ts` (the web app does `import type { X } from "@shared/api"`; never import values from it in web code).
4. Fail by throwing `new HttpError(status, "snake_case_code", "Human message", details?)`. Unhandled errors become 500 `internal_error`. Success returns the resource directly; no `{ ok: true }` wrappers.
5. Add a `### METHOD /path` section with a working curl example to `API.md`.

Naming: routes are plural kebab-case nouns (`/api/firmware`, `/api/devices/:id/refresh`); JSON fields are camelCase for Manager-owned objects, but device payloads are passed through with the device's snake_case unchanged.

Error codes in use: `invalid_body|invalid_params|invalid_query|invalid_json|bad_request` (400), `unauthorized` (401), `forbidden_host|forbidden_origin` (403), `not_found` (404), `method_not_allowed` (405), `payload_too_large` (413), `unsupported_media_type` (415), `upgrade_required` (426), `internal_error` (500). Add domain codes (`device_unreachable`, ...) as needed and list them in `API.md`.

## `start()`

`start(opts: StartOptions)` in `app.ts` is the only way the server is launched (CLI, Electron). New collaborators (pollers, discovery, fake-device targets, intervals) become optional fields of `StartOptions`, are created inside `start()`, hang off `AppContext` (`ctx.app`) and are stopped in `close()`. Server code must not use `import.meta` (it is bundled to CJS; lint enforces it): pass paths in via options. `publicDir` is resolved in `main.ts` by `publicDir.ts` (bundled `dist/public`, else `web/dist`).

Shared Node-RED lib: import without `.js`, e.g. `import { isOurs } from "node-red-contrib-de-esp32/lib/fingerprint"`. Types are declared in `types/shared-lib.d.ts`; esbuild keeps `mqtt` external (never used).

## Talking to devices

- Services hang off `ctx.app`: `registry` (store/registry.ts), `settings`, `pool` (one `DeviceClient` + FIFO queue per device id), `health` (poller), `summaries` (`get(id)`/`list()` build the `DeviceSummary`), `hub`.
- **Never call a device with `fetch`/`http` directly.** Use `callDevice(app, dev, method, rel, opts)` from `api/deviceCall.ts` (queue, per-call timeouts, 1536 B limit, expected-restart mapping, pin-shadow/rename bookkeeping) or `app.pool.forDevice(id, host)`. Transport failures throw `DeviceError { kind }`; turn them into HTTP 502 with `transportFailure(err)` (body `{ok:false, error, code, transport:true}`).
- `createDeviceClient({ host, localAddress? })` works without the registry (probes, and the later SoftAP setup, which must bind a specific adapter: pass `localAddress` per client or per call).
- Registry entries are changed only through `RegistryStore` (`upsert`, `update`, `remove`, `ignore`, `setPinShadow`); it saves debounced and emits `onChange`. The hub, poller and summaries react to those events, so never write the file yourself. Discovery calls `registry.upsert({id, host, hostname, name, addedVia})`, `registry.update(id, { host })` for IP changes and `health.pollNow(id)`.
- Health states and attention flags live in `device/health.ts` / `device/summary.ts`; a summary change is pushed to browsers automatically (`hub.deviceChanged(id)` for anything else that should refresh a card).

## Device link and live data

- `ctx.app.links` (`device/link.ts`): `setWatch(ws, ids)`, `stateOf(id)`, `command(id, body)` (device socket when the link is `open`, else HTTP), `configChanged(id)`. Browser `watch`/`cmd` messages are routed to it in `app.ts`; `hub.onClose` unwatches. At most one device WebSocket per device, only while watched.
- Post-command bookkeeping (restart mapping, pin shadow, rename, live refresh after `pin.configure`/`module.*`) lives in `applyCommandEffects` (`api/deviceCall.ts`); every command path goes through it.
- Extra `StartOptions` (all optional, ms): `linkIdleCloseMs` (10000), `fullDetectMs` (20000), `livePollMs` (5000), `linkBackoffMinMs` (1000), `linkBackoffMaxMs` (30000), `hydrateSettleMs` (300), `hydrateMaxMs` (1500), `linkCmdTimeoutMs` (10000).
- The `io` cache key of an add-on module is `mod_<data.id>` (the firmware's state `id` carries no prefix).

## Discovery

- `ctx.app.discovery` (`discovery/index.ts`): `startScan` (throws `ScanRunningError` -> 409 `scan_running`, `DiscoveryInputError` -> 400), `cancelScan`, `getState`, `ignore`/`unignore`, `adopt`, and the library call for setup jobs:
  `waitForDevice(id, { timeoutMs, signal?, intervalMs?, mdns?, sweep?, targets? }): Promise<{ host, status } | null>`. Each round probes the registry address, the settings' targets and mDNS, then sweeps; it never touches the UI scan state, the registry or the WebSocket, so the caller (M4b/M8b) adds or re-points the device itself.
- Probing is `discovery/sweep.ts#probeStatus`: one non-queued `GET /api/v1/status`, no redirects, no keep-alive, never rejects. Do not use `DeviceClient` for 254 random addresses. mDNS is `discovery/mdns.ts` (`browseMdns(factory, opts)`, never throws, socket errors become warnings).
- Classification is computed on read from the registry (`known`/`new`/`ignored`), so adopting/forgetting/ignoring reclassifies the last results at once. Known devices are updated (host, name, hostname, lastSeen, `health.pollNow`) when a scan finishes or is cancelled.
- Route option `optionalBody: true` (router): an empty body is treated as `{}`; every key of `body` must be optional.
- Settings added: `discoveryTargets`, `extraSubnets`, `backgroundScan {enabled (default false), periodMin 1-60 (default 5)}`; entries are validated in `api/settings.ts` (canonical targets, CIDR subnets).

## Fake device (`server/fake/`)

A faithful fake of the firmware's `/api/v1` (spec §2), for running the Manager without a board. Types for all payloads live in `server/src/types/device-api.ts` (`@shared/device-api`).

```ts
import { startFakeDevice, makeFakeImage } from "./fake/fakeDevice";

const dev = await startFakeDevice({ seed: "demo", id: "a4cf12b3c4d5" });   // port 0 = ephemeral
```

- Options: `id name host port appVersion fw telemetryIntervalMs rebootMs scanDelayMs wifiSetDelayMs latencyMs wsLimit safeMode seed("empty"|"demo") pins modules rules mqtt log verifyMs otaRebootDelayMs otaApplyMs factoryResetReturns wifiSetFails wifiSetDropsResponse legacy faults{otaFailAtBytes,otaRollback}`. Defaults are the firmware's real timings (scan 1.5 s, Wi-Fi set 2 s, reboot 3 s). `dev.options` and `dev.options.faults` can be changed at runtime.
- Handle: `id host port url state close() goOffline("refuse"|"hang") goOnline() reboot() emit(topic,data) setInput(gpio,value) wsClientCount registeredWsCount requestLog availability`. `dev.state` is the mutable truth (edit `state.memory`, `state.io`, `state.network`, `state.mqtt` ... and the next request sees it). The device keeps its id and port across reboot/offline cycles.
- Quirks it reproduces on purpose: one request at a time (a slow `network/scan` delays `/status`), 1536-byte JSON limit (400 text `json`), unknown GET/POST answered with a 302 to `http://192.168.4.1/`, reboot/factory-reset/`ota.rollback` kill the socket without a reply and go offline for `rebootMs`, 4 registered WS clients (a 5th is accepted but gets no events; its commands are still answered), and the `mqtt/reconfigure` frame that leaks the password.
- OTA: `makeFakeImage({version, project, date, time, size})` builds an image the fake accepts; `POST /ota` flips slot after the reboot, `pending_verify` becomes `valid` after `verifyMs`.
- Run it by hand: `npm run fake -- --count 3 --base-port 8101 [--seed demo|empty]`.

## Jobs and features

- Long operations are jobs: `ctx.app.jobs.create({ kind, title, steps?, devices?, params?, supports? }, async (ctl) => { ... })` (`jobs/index.ts`; contract in `types/api-jobs.ts`, docs in `API.md` "Jobs"). The body reports through `ctl.step/device/progress/message/result/fail`, waits with `ctl.signal` (cancel and shutdown) and `ctl.waitWhilePaused()`, and ends by returning (`succeeded`, or `partial`/`failed` from the device rows), throwing `JobFailure(code, plainMessage, step?)`, or by a cancel. Never put secrets in `params`/`result`/`message` (keys matching `/pass|psk|secret|token|key$/i` are stripped from `params` only). Your start route returns the job (`202`); everything else (cancel, pause, retry, WebSocket `{t:"job"}`) is generic.
- Features (setup, IP change, firmware, backups) each have `api/<name>.ts` (spread into `api/index.ts`), `types/api-<name>.ts` (re-exported from `types/api.ts`), and a folder `setup/`, `ipchange/`, `firmware/`, `backups/` whose `index.ts` exports `createXFeature(app, config?)`, assigned in `start()` to `app.setup|ipChange|firmware|backups` and `close()`d before the job service. Their options come in through `StartOptions.setup? / ipChange? / firmware? / backups?`.
- `app.wifiAdapterKind` (`fake|system|none`, `--wifi-adapter`). Network scanning is always on; there is no switch to turn it off. `npm run dev` is the real Manager (real scan, real Wi-Fi adapter). Manual runs that must not touch the LAN add `--wifi-adapter fake` and use fake boards.

## Before you report done (run from `manager/`)

```
npm run typecheck && npm run build
```

## Dependencies and processes

- Do not commit unless asked.
- Ports: manager 5180, Vite 5173; 5199 belongs to something else. Stop every server you start.
- `npm run dev` stores data in `.data/dev` (gitignored).

## Web app (`web/src`)

- `App.tsx` needs a Router above it (`BrowserRouter` in `main.tsx`). Routes live in `routes/AppRoutes.tsx`; add a screen = new `routes/<Name>Page.tsx` + a `<Route>` there (and a `NAV` entry in `components/shell/SideNav.tsx` for top-level screens).
- Data layer, `api/`: `apiFetch<T>(path, init?)` (throws `ApiError {status, code, message, details}`), `useApi<T>(path)` for simple GETs, `getBrowserWs()` (one WS: `subscribe(t, fn)`, `send(msg)`, `store`), `createStore`/`useStore` (useSyncExternalStore; selectors must return stable values), `useServerStatus()`. Never talk to a device directly.
- Page transitions: `RouteTransition` keeps the outgoing page mounted, so inside a transitioned page read the route from `useParams()`, not `useLocation()`.
- Styling: plain CSS. `styles/tokens.css` mirrors `proto/tokens.css`; app-only additions go in `styles/app.css`. Use `components/ui/*` (Button, Card, Chip, Dot, EmptyState, PageHeader, Tooltip) before writing markup; Radix for menus/tooltips/dialogs/tabs. Every transition must be safe under `prefers-reduced-motion` (global rule in the CSS; `MotionConfig reducedMotion="user"` in `App`).
- Device screens share `components/device/DeviceHeader` (title truncates, chips wrap, actions collapse into a "More" menu by container width) and `DeviceTabs`.
