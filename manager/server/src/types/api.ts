/**
 * Manager API types, shared by the server and the web app (`@shared/api`).
 *
 * Each response is a TypeBox schema (used by routes for validation + OpenAPI)
 * plus a `Static` type of the same name. The web app must only `import type`
 * from here so TypeBox never ends up in the browser bundle.
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Job } from "./api-jobs";
import type { IoState, TelemetrySnapshot } from "./device-api";

// Batch 3: each feature track owns one of these files; the generic job contract is shared.
export * from "./api-backups";
export * from "./api-firmware";
export * from "./api-ip";
export * from "./api-jobs";
export * from "./api-setup";
export * from "./api-wifimove";

export const ErrorResponseSchema = Type.Object({
  error: Type.String({ description: "Human readable message" }),
  code: Type.String({ description: "snake_case machine code" }),
  details: Type.Optional(Type.Unknown({ description: "Extra context, e.g. schema errors for invalid_body" })),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const HealthResponseSchema = Type.Object({
  version: Type.String(),
  lan: Type.Boolean(),
  dataDir: Type.String(),
  uptime: Type.Number({ description: "Seconds since the server started" }),
  startedAt: Type.Number({ description: "When the server started: epoch milliseconds" }),
  wifiAdapter: Type.Union([Type.Literal("fake"), Type.Literal("system"), Type.Literal("none")], {
    description: "How SoftAP setup reaches a board's Wi-Fi: fake (simulated, for development), system (this PC's Wi-Fi adapter) or none (setup disabled)",
  }),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const AccessResponseSchema = Type.Object({
  lan: Type.Boolean({ description: "LAN access is on right now (live: follows PUT /api/access)" }),
  host: Type.String({ description: "Address the server is bound to right now" }),
  port: Type.Integer(),
  localUrl: Type.String(),
  lanUrls: Type.Array(Type.String(), { description: "One URL per LAN IPv4 address (LAN mode only)" }),
  token: Type.Union([Type.String(), Type.Null()], { description: "Access token (LAN mode only; only callers that already passed the security check can read it)" }),
  tokenMasked: Type.Union([Type.String(), Type.Null()], { description: "The token with all but the last 4 characters hidden, for display" }),
  tokenUrls: Type.Array(Type.String(), { description: "lanUrls with ?token= appended" }),
  openUrl: Type.Union([Type.String(), Type.Null()], { description: "The first of tokenUrls: a ready-to-open link for a phone or another PC" }),
  remote: Type.Boolean({ description: "This request came from another device (not from this PC): switching LAN access off will cut it off" }),
  toggleAvailable: Type.Boolean({ description: "false when LAN access cannot be switched from the UI (desktop app, or --host set to a specific address)" }),
  toggleUnavailableReason: Type.Union([Type.String(), Type.Null()], { description: "Plain-language reason when toggleAvailable is false" }),
});
export type AccessResponse = Static<typeof AccessResponseSchema>;

export const AccessUpdateSchema = Type.Object({ enabled: Type.Boolean({ description: "true = reachable from the network (token required), false = this PC only" }) }, { additionalProperties: false });
export type AccessUpdate = Static<typeof AccessUpdateSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Devices (M2)
// ---------------------------------------------------------------------------------------------------------------

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

/**
 * `unknown` = not polled yet since the server started (deviation from the spec's five states);
 * `updating` is reserved for OTA jobs (M9).
 */
export const DeviceHealthSchema = Type.Union(
  [
    Type.Literal("unknown"),
    Type.Literal("online"),
    Type.Literal("unreachable"),
    Type.Literal("offline"),
    Type.Literal("rebooting"),
    Type.Literal("updating"),
  ],
  { description: "Health state. unknown = not polled yet since the server started." },
);
export type DeviceHealth = Static<typeof DeviceHealthSchema>;

export const AttentionFlagSchema = Type.Union(
  [
    Type.Literal("safe_mode"),
    Type.Literal("boot_unhealthy"),
    Type.Literal("memory_pressure"),
    Type.Literal("alloc_failed"),
    Type.Literal("ota_pending_verify"),
    Type.Literal("ota_error"),
    Type.Literal("mqtt_disconnected"),
    Type.Literal("wifi_recovery"),
    Type.Literal("host_mismatch"),
  ],
  { description: "Why this device needs a look (spec 3.4). host_mismatch: the stored address answers as a different device." },
);
export type AttentionFlag = Static<typeof AttentionFlagSchema>;

/** What the SPA renders for a device (spec 3.10, plus notes/addedVia/addedAt/queue). Device-derived fields are null until first seen. */
export const DeviceSummarySchema = Type.Object({
  id: Type.String({ description: "MAC hex (12 lowercase chars), the primary key" }),
  name: Type.String({ description: "Last seen status.name" }),
  label: Type.String({ description: "Manager-only display override (empty = none)" }),
  notes: Type.String(),
  hostname: Type.String(),
  host: Type.String({ description: "Address the Manager talks to: ip or ip:port (port omitted when 80)" }),
  addedAt: Type.String(),
  addedVia: Type.Union([Type.Literal("mdns"), Type.Literal("sweep"), Type.Literal("manual")]),
  health: DeviceHealthSchema,
  attention: Type.Array(AttentionFlagSchema),
  lastSeen: Nullable(Type.String()),
  fw: Nullable(Type.String()),
  app_version: Nullable(Type.String()),
  compile_date: Nullable(Type.String()),
  fwMatchesTarget: Nullable(Type.Boolean({ description: "null until a firmware target exists (M9)" })),
  uptime_s: Nullable(Type.Number()),
  boot_state: Nullable(Type.String()),
  safe_mode: Nullable(Type.Boolean()),
  safe_reason: Nullable(Type.String()),
  rssi: Nullable(Type.Number()),
  net_state: Nullable(Type.String()),
  mqtt: Type.Object({ configured: Nullable(Type.Boolean()), connected: Nullable(Type.Boolean()) }),
  memory: Type.Object({ pressure: Nullable(Type.String()), free: Nullable(Type.Number()), total: Nullable(Type.Number()) }),
  ota: Type.Object({
    running_partition: Nullable(Type.String()),
    image_state: Nullable(Type.String()),
    rollback_possible: Nullable(Type.Boolean()),
    busy: Nullable(Type.Boolean()),
  }),
  io_count: Nullable(Type.Integer({ description: "status.io keys excluding mod_*" })),
  module_count: Nullable(Type.Integer({ description: "status.io keys starting with mod_" })),
  link: Type.Union([Type.Literal("open"), Type.Literal("connecting"), Type.Literal("closed"), Type.Literal("full")], {
    description: "Device WebSocket link state: closed when no browser watches the device",
  }),
  queue: Type.Integer({ description: "Requests pending or running for this device (device busy indicator)" }),
  ip_mode: Type.Optional(Nullable(Type.Union([Type.Literal("dhcp"), Type.Literal("static")], { description: "How the device gets its address; null on firmware that does not report it" }))),
});
export type DeviceSummary = Static<typeof DeviceSummarySchema>;

export const AddDeviceBodySchema = Type.Object(
  { host: Type.String({ minLength: 1, maxLength: 300, description: "IPv4, host:port, name.local or hostname; an optional leading http:// is accepted" }) },
  { additionalProperties: false },
);
export type AddDeviceBody = Static<typeof AddDeviceBodySchema>;

export const PatchDeviceBodySchema = Type.Object(
  {
    label: Type.Optional(Type.String({ maxLength: 64 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    host: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);
export type PatchDeviceBody = Static<typeof PatchDeviceBodySchema>;

/** Body of POST /api/devices/:id/command: any device command; the device validates the arguments. */
export const DeviceCommandBodySchema = Type.Object({ cmd: Type.String({ minLength: 1 }) }, { additionalProperties: true });
export type DeviceCommandBody = Static<typeof DeviceCommandBodySchema>;

/** The device's command envelope, passed through unchanged. */
export const DeviceEnvelopeSchema = Type.Object(
  {
    v: Type.Number(),
    ok: Type.Boolean(),
    corr: Type.Optional(Type.String()),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type DeviceEnvelopeBody = Static<typeof DeviceEnvelopeSchema>;

/** HTTP 502 body when the device could not be reached (or answered nonsense). */
export const DeviceTransportErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  code: Type.String({ description: "device_unreachable | device_timeout | device_reset | device_captive_redirect | device_bad_response | device_http_status" }),
  transport: Type.Literal(true),
  details: Type.Optional(Type.Unknown()),
});
export type DeviceTransportError = Static<typeof DeviceTransportErrorSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export const BackgroundScanSchema = Type.Object({
  enabled: Type.Boolean({ description: "Scan on a timer (default false)" }),
  periodMin: Type.Integer({ minimum: 1, maximum: 60, description: "Minutes between background scans (1-60, default 5)" }),
});
export type BackgroundScan = Static<typeof BackgroundScanSchema>;

export const SettingsResponseSchema = Type.Object({
  pollIntervalS: Type.Integer({ minimum: 10, maximum: 300, description: "Seconds between health polls of each device (10-300, default 30)" }),
  discoveryTargets: Type.Array(Type.String(), { description: "Extra host[:port] addresses probed exactly as given on every scan" }),
  extraSubnets: Type.Array(Type.String(), { description: "Extra CIDR ranges swept on every scan (wider than /24 is clamped to the /24 of the given address)" }),
  backgroundScan: BackgroundScanSchema,
  firmwareBaseUrl: Type.String({ description: "The \"Pages URL\" `Get latest firmware` fetches from (`<url>/firmware/de_esp32_runtime.bin`); default https://terraseraph.github.io/esp32-joat/" }),
  defaultParallelUpdates: Type.Integer({ minimum: 1, maximum: 4, description: "Initial \"Parallel updates\" value of the Firmware screen (1-4, default 2)" }),
});
export type SettingsResponse = Static<typeof SettingsResponseSchema>;

export const SettingsUpdateSchema = Type.Object(
  {
    pollIntervalS: Type.Optional(Type.Integer({ minimum: 10, maximum: 300 })),
    discoveryTargets: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 64 })),
    extraSubnets: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
    backgroundScan: Type.Optional(
      Type.Object(
        { enabled: Type.Optional(Type.Boolean()), periodMin: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })) },
        { additionalProperties: false },
      ),
    ),
    firmwareBaseUrl: Type.Optional(Type.String({ maxLength: 300 })),
    defaultParallelUpdates: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  },
  { additionalProperties: false },
);
export type SettingsUpdate = Static<typeof SettingsUpdateSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Discovery (M3)
// ---------------------------------------------------------------------------------------------------------------

export const ScanPhaseSchema = Type.Union(
  [Type.Literal("idle"), Type.Literal("mdns"), Type.Literal("sweep"), Type.Literal("done"), Type.Literal("cancelled"), Type.Literal("error")],
  {
    description:
      "idle = never scanned since the server started. mdns = the quick phase (addresses of registered devices, extra targets, mDNS browse). sweep = /24 sweep. Then done, cancelled or error.",
  },
);
export type ScanPhase = Static<typeof ScanPhaseSchema>;

export const DiscoveryClassificationSchema = Type.Union([Type.Literal("known"), Type.Literal("new"), Type.Literal("ignored")]);
export type DiscoveryClassification = Static<typeof DiscoveryClassificationSchema>;

export const DiscoveryResultSchema = Type.Object({
  id: Type.String({ description: "MAC hex (12 lowercase chars)" }),
  host: Type.String({ description: "Address to use: ip or ip:port (port omitted when 80)" }),
  name: Type.String(),
  hostname: Type.String(),
  fw: Type.String(),
  app_version: Type.Optional(Type.String()),
  board: Type.Optional(Type.String()),
  via: Type.String({ description: "How it was found: any of mdns, sweep, target, registry joined with + (e.g. mdns+sweep)" }),
  classification: DiscoveryClassificationSchema,
  setup: Type.Boolean({ description: "Needs setting up: network.state is ap_only, or apsta_recovery without a Wi-Fi (STA) connection" }),
  setupApOpen: Type.Boolean({ description: "The board's own setup Wi-Fi is up (ap_only or apsta_recovery), even when it is connected to this network" }),
  netState: Type.String({ description: "network.state as reported ('' when unknown)" }),
  ipChanged: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() }, { description: "A known device answered at a different address; the registry was updated" })),
  txt: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "mDNS TXT record (when found via mDNS)" })),
  lastSeen: Type.String({ description: "ISO time of the last answer during this scan" }),
});
export type DiscoveryResult = Static<typeof DiscoveryResultSchema>;

export const DiscoveryStateSchema = Type.Object({
  running: Type.Boolean(),
  phase: ScanPhaseSchema,
  probed: Type.Integer({ description: "Hosts probed so far (all phases)" }),
  total: Type.Integer({ description: "Hosts to probe (grows when mDNS finds more)" }),
  startedAt: Type.Union([Type.String(), Type.Null()]),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
  warnings: Type.Array(Type.String()),
  subnets: Type.Array(Type.String(), { description: "The ranges the sweep covers (a /24 each unless a smaller one was given), as CIDR" }),
  results: Type.Array(DiscoveryResultSchema),
  ignored: Type.Array(Type.String(), { description: "Ignored device ids (the registry's ignore list)" }),
});
export type DiscoveryState = Static<typeof DiscoveryStateSchema>;

export const ScanRequestSchema = Type.Object(
  {
    mdns: Type.Optional(Type.Boolean({ description: "Browse mDNS (default true)" })),
    sweep: Type.Optional(Type.Boolean({ description: "Sweep the local /24 networks (default true)" })),
    subnets: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32, description: "Extra CIDR ranges to sweep (wider than /24 is clamped to the /24 of the given address)" })),
    targets: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 64, description: "Extra host[:port] addresses, probed exactly as given" })),
  },
  { additionalProperties: false },
);
export type ScanRequest = Static<typeof ScanRequestSchema>;

export const IgnoreBodySchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export type IgnoreBody = Static<typeof IgnoreBodySchema>;

export const AdoptBodySchema = Type.Object({ ids: Type.Array(Type.String({ maxLength: 64 }), { minItems: 1, maxItems: 500 }) }, { additionalProperties: false });
export type AdoptBody = Static<typeof AdoptBodySchema>;

export const AdoptResponseSchema = Type.Object({
  added: Type.Array(DeviceSummarySchema),
  skipped: Type.Array(Type.Object({ id: Type.String(), reason: Type.Union([Type.Literal("unknown_id"), Type.Literal("already_known")]) })),
});
export type AdoptResponse = Static<typeof AdoptResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Browser WebSocket
// ---------------------------------------------------------------------------------------------------------------

/**
 * Device WebSocket link state (M5, spec 3.6), also `DeviceSummary.link`.
 * - `closed`: no browser watches the device, so there is no device socket.
 * - `connecting`: watched, socket opening or waiting for the next reconnect (backoff 1 s -> 30 s). The server polls meanwhile.
 * - `open`: socket open and events arrive.
 * - `full`: socket open but no event frame within 20 s (the device already has 4 live viewers). The server polls `GET /pins` meanwhile.
 */
export type LinkState = "open" | "connecting" | "closed" | "full";

/** Live I/O map keyed by state key (`gpio_4`, `adc_34`, `pwm_18`, `servo_13`, `mod_env0`; device payload, snake_case; shapes in `@shared/device-api` `IoMap`). */
export type LiveIoMap = Record<string, IoState>;

/** Messages the server pushes over the browser WebSocket `/api/ws`. */
export type BrowserWsMessage =
  | { t: "hello"; server: { version: string; lan: boolean } }
  /** LAN access was switched on or off (PUT /api/access). Never carries the token: clients re-read GET /api/health. */
  | { t: "access"; lan: boolean }
  | { t: "devices"; list: DeviceSummary[] }
  | { t: "device"; id: string; summary: DeviceSummary }
  | { t: "deviceRemoved"; id: string }
  | { t: "scan"; phase: ScanPhase; probed: number; total: number; found: DiscoveryResult[] }
  /** A job changed (every change, throttled per job; the final state is always sent at once). Carries the whole job. */
  | { t: "job"; job: Job }
  | { t: "cmdResult"; id: string; corr?: string; res: { v: 1; ok: boolean; error?: string; result?: unknown } }
  // ---- M5: only sent to sockets that watch `id` -------------------------------------------------------------
  /** Link state of a watched device: sent when a socket starts watching it and on every change. */
  | { t: "link"; id: string; ws: LinkState }
  /**
   * Snapshot of everything the server knows about a watched device's live state: sent to a socket when it starts
   * watching the device (if the server has anything cached yet) and after every (re)open of the device socket once the
   * `io.hydrate` burst has settled. `io` is the full map (replace, do not merge); `telemetry` is the last telemetry frame or null.
   */
  | { t: "live"; id: string; io: LiveIoMap; telemetry: TelemetrySnapshot | null }
  /**
   * One I/O change. `topic` is the device topic (`io/gpio`, `io/adc`, `io/pwm`, `io/servo`, `io/env`, `io/rfid`);
   * `data` is the state value (`data.id` is the state key, except add-on modules, `io/env` and `io/rfid`: their key in `live.io` is `mod_<data.id>`). While the link is `full` or `connecting` the server
   * synthesises these from polls of `GET /pins` (only for keys that changed), so the browser handles one path.
   */
  | { t: "io"; id: string; topic: string; data: IoState }
  /**
   * Any other device event: `telemetry` (TelemetrySnapshot, every 15 s), `net` ({state, sta_ip}), `ota/progress`,
   * `identity/rename` ({old_topic_id, topic_id, name}), plus unknown future topics passed through. `mqtt/reconfigure` is never forwarded.
   */
  | { t: "event"; id: string; topic: string; data: unknown };

/** Browser -> server: replace the set of devices this socket watches (an empty list stops watching). Unknown ids are ignored. */
export interface BrowserWsWatch {
  t: "watch";
  ids: string[];
}
/**
 * Browser -> server: send one device command. Sent over the device socket when the link is `open` (no 1536 B limit),
 * otherwise over HTTP through the device queue; the same bookkeeping as `POST /api/devices/:id/command` applies
 * (pin shadow, rename, expected restart). Answered with `cmdResult` (same `corr`); 10 s timeout -> `{ok:false,error}`.
 */
export interface BrowserWsCmd {
  t: "cmd";
  id: string;
  corr?: string;
  body: { cmd: string; [key: string]: unknown };
}

/** Messages the browser may send (`BrowserWsWatch`, `BrowserWsCmd`); unknown `t` values are ignored. */
export type BrowserWsClientMessage = { t: string; [key: string]: unknown };

// ---------------------------------------------------------------------------------------------------------------
// Pin configuration view (M7): GET /api/devices/:id/pin-config
// ---------------------------------------------------------------------------------------------------------------

export const PinConfigEntrySchema = Type.Object({
  gpio: Type.Integer(),
  mode: Type.String({ description: "out | in | pwm | servo | adc (configured pins only; add-on pins are not listed)" }),
  config: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Minimal pin.configure object for this pin ({gpio, mode, ...non-default options}). From the pin shadow (what the Manager last sent) when its mode matches the live mode, else derived from the live state (which lacks invert/pull/boot/irq).",
  }),
  source: Type.Union([Type.Literal("shadow"), Type.Literal("live")]),
  live: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], { description: "The live state value (device snake_case), null when absent" }),
});
export type PinConfigEntry = Static<typeof PinConfigEntrySchema>;

export const PinConfigResponseSchema = Type.Object({
  pins: Type.Array(PinConfigEntrySchema, { description: "Sorted by gpio" }),
});
export type PinConfigResponse = Static<typeof PinConfigResponseSchema>;
