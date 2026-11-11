/**
 * Fake device: options, mutable state, defaults and the pure serializers that turn the state into the
 * payloads of spec §2.3 (types from `server/src/types/device-api.ts`).
 */
import { randomBytes } from "node:crypto";
import { snapshot as devkitcSnapshot } from "node-red-contrib-de-esp32/lib/devkitc-hardware";
import { createPending, decorateNetwork, initialNetworkFields, realClock, type FakeClock, type FakePending } from "./pending";
import type {
  AccessPoint,
  BootState,
  ChipInfo,
  DeviceSinks,
  DeviceStatus,
  Hardware,
  HardwarePin,
  HeaderPad,
  ImageState,
  IoMap,
  IoState,
  MemoryInfo,
  ModuleAddFields,
  ModuleInstance,
  MqttStatus,
  NetworkStatus,
  OtaSession,
  OtaStatus,
  PinConfig,
  Rule,
  RuleInput,
  RuleList,
  TelemetrySnapshot,
  DeviceWsTopic,
} from "../src/types/device-api";

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

/** Fault hooks (settable at start or later through `fake.options.faults`). */
export interface FakeFaults {
  /** Destroy the socket mid-upload once this many bytes were received. */
  otaFailAtBytes?: number;
  /** After an OTA the device comes back on the OLD slot/version (bootloader rolled back). */
  otaRollback?: boolean;
}

export interface FakeDeviceOptions {
  /** 12 lowercase hex chars. Default: random. */
  id?: string;
  /** Default: the hostname. */
  name?: string;
  host?: string;
  /** Default 0 (ephemeral). */
  port?: number;
  appVersion?: string;
  fw?: string;
  telemetryIntervalMs?: number;
  /** Time spent offline (connection refused) after a reboot. Default 3000. */
  rebootMs?: number;
  /** Blocking delay of `network/scan`. Default 1500. */
  scanDelayMs?: number;
  /** Blocking delay of `network.wifi.set`. Default 2000. */
  wifiSetDelayMs?: number;
  /** Added to every request while the device is "busy" (inside the serial section). Default 0. */
  latencyMs?: number;
  /** Registered WebSocket slots. Default 4. */
  wsLimit?: number;
  safeMode?: boolean;
  seed?: "empty" | "demo";
  /** Extra pins applied after the seed (through `pin.configure`). */
  pins?: PinConfig[];
  /** Extra modules applied after the seed (through `module.add`). */
  modules?: ModuleAddFields[];
  /** Extra rules applied after the seed (through `rule.set`). */
  rules?: RuleInput[];
  /** Initial MQTT config (merged over the seed). */
  mqtt?: { uri?: string; root?: string; user?: string; password?: string; connected?: boolean };
  /** One line per request / ws command / lifecycle event. */
  log?: (line: string) => void;
  /** Time until `pending_verify` becomes `valid` after an OTA boot. Default 1000. */
  verifyMs?: number;
  /** Delay between the OTA upload reply and the reboot. Default 800 (firmware value). */
  otaRebootDelayMs?: number;
  /** Duration of the simulated `ota.apply` fetch. Default 300. */
  otaApplyMs?: number;
  /** Factory reset brings the device back online (default: it stays offline, "left the LAN as a SoftAP"). */
  factoryResetReturns?: boolean;
  /** `network.wifi.set` always fails with "wifi test failed; credentials not saved". */
  wifiSetFails?: boolean;
  /** `network.wifi.set` kills the connection without a reply (spec §2.7 #1). */
  wifiSetDropsResponse?: boolean;
  /** Emulate older firmware: no `sinks`, no MQTT `backlog`/`backlogs`/`io_dropped`/`outbox`. */
  legacy?: boolean;
  /**
   * OPT-IN emulation of the PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): `wifi_change`,
   * static IP (`network.ip.set` / `network.ip.confirm`) and the extra network status fields. Default false:
   * payloads are then identical to current `main` firmware. See `pending.ts`.
   */
  pendingFirmware?: boolean;
  /**
   * Start in SoftAP setup mode (an unprovisioned board): `net_state` `ap_only`, no saved Wi-Fi, no STA address. A
   * successful `network.wifi.set` then moves it to `sta_connected` (on the same port). CLI `--ap-mode`.
   */
  apMode?: boolean;
  /**
   * Pending firmware: a SUCCESSFUL `network.wifi.set` to one of these SSIDs moves the device to another address, the way a real
   * device joining a network on another subnet does. Value `host:port` (or just a port on the same host); port 0 = ephemeral
   * (read `dev.port` afterwards). The old address stops answering, the id and the state stay. CLI `--wifi-move ssid=host:port`.
   */
  wifiMoves?: Record<string, string>;
  /** Delay between the `network.ip.set` reply and the device applying it (firmware: about 1500). Pending firmware only. */
  ipApplyDelayMs?: number;
  /** Window to confirm an applied static config before it reverts (firmware: 90000). Pending firmware only. */
  ipConfirmWindowMs?: number;
  /** Time source for the two delays above; default real timers. Tests inject a manual clock. */
  clock?: FakeClock;
  faults?: FakeFaults;
}

export interface ResolvedOptions {
  id: string;
  name: string | undefined;
  host: string;
  port: number;
  appVersion: string;
  fw: string;
  telemetryIntervalMs: number;
  rebootMs: number;
  scanDelayMs: number;
  wifiSetDelayMs: number;
  latencyMs: number;
  wsLimit: number;
  safeMode: boolean;
  seed: "empty" | "demo";
  verifyMs: number;
  otaRebootDelayMs: number;
  otaApplyMs: number;
  factoryResetReturns: boolean;
  wifiSetFails: boolean;
  wifiSetDropsResponse: boolean;
  legacy: boolean;
  pendingFirmware: boolean;
  apMode: boolean;
  wifiMoves: Record<string, string>;
  ipApplyDelayMs: number;
  ipConfirmWindowMs: number;
  clock: FakeClock;
  faults: FakeFaults;
}

export function resolveOptions(o: FakeDeviceOptions): ResolvedOptions {
  const id = o.id ?? randomBytes(6).toString("hex");
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error(`fake device id must be 12 lowercase hex chars, got "${id}"`);
  return {
    id,
    name: o.name,
    host: o.host ?? "127.0.0.1",
    port: o.port ?? 0,
    appVersion: o.appVersion ?? "9dcba89",
    fw: o.fw ?? "0.1.0",
    telemetryIntervalMs: o.telemetryIntervalMs ?? 15000,
    rebootMs: o.rebootMs ?? 3000,
    scanDelayMs: o.scanDelayMs ?? 1500,
    wifiSetDelayMs: o.wifiSetDelayMs ?? 2000,
    latencyMs: o.latencyMs ?? 0,
    wsLimit: o.wsLimit ?? 4,
    safeMode: o.safeMode ?? false,
    seed: o.seed ?? "empty",
    verifyMs: o.verifyMs ?? 1000,
    otaRebootDelayMs: o.otaRebootDelayMs ?? 800,
    otaApplyMs: o.otaApplyMs ?? 300,
    factoryResetReturns: o.factoryResetReturns ?? false,
    wifiSetFails: o.wifiSetFails ?? false,
    wifiSetDropsResponse: o.wifiSetDropsResponse ?? false,
    legacy: o.legacy ?? false,
    pendingFirmware: o.pendingFirmware ?? false,
    apMode: o.apMode ?? false,
    wifiMoves: { ...(o.wifiMoves ?? {}) },
    ipApplyDelayMs: o.ipApplyDelayMs ?? 1500,
    ipConfirmWindowMs: o.ipConfirmWindowMs ?? 90000,
    clock: o.clock ?? realClock,
    faults: { ...(o.faults ?? {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

/** One OTA partition's content. */
export interface FakeSlot {
  app_version: string;
  compile_date: string;
  compile_time: string;
  idf: string;
  project: string;
  /** Marked invalid (rolled back from); not a rollback target. */
  invalid?: boolean;
}

export interface FakeOtaState {
  /** `ota_0`, `ota_1`; `null` = empty. */
  slots: [FakeSlot | null, FakeSlot | null];
  running: 0 | 1;
  image_state: ImageState;
  session: OtaSession;
  bytes: number;
  total: number;
  percent: number;
  last_error?: string;
  incoming_version?: string;
  incoming_project?: string;
}

/** Public MQTT status fields (topic_id/prefix are derived) plus what the device never reveals. */
export interface FakeMqttState extends Omit<MqttStatus, "topic_id" | "prefix"> {
  enabled: boolean;
  /** Never readable through the API; stored so tests can assert on them. */
  user: string;
  password: string;
}

export interface FakeModule {
  id: string;
  type: string;
  bus: string;
  enabled: boolean;
  pins: { [role: string]: number };
  settings: { [key: string]: number | string };
}

export interface FakeState {
  id: string;
  /** `aa:bb:cc:dd:ee:ff`, derived from the id. */
  mac: string;
  /** `esp32-<last 6 hex of id>`. */
  hostname: string;
  /** Equals the hostname when never renamed. */
  name: string;
  topic_id: string;
  fw: string;
  chip: string;
  chip_info: ChipInfo;
  /** Config schema (4). */
  schema: number;
  generation: number;
  /** `Date.now()` of the last boot; `uptime_s` is computed from it. */
  bootAt: number;
  boot_count: number;
  reset_reason: number;
  memory: MemoryInfo;
  boot_state: BootState;
  safe_mode: boolean;
  safe_reason: string;
  network: NetworkStatus;
  mqtt: FakeMqttState;
  ota: FakeOtaState;
  /** Live I/O map (what `status.io` and `GET /pins` return). */
  io: IoMap;
  /** The "outside world": external level (digital) or millivolts (ADC) per GPIO. Survives reboots. */
  inputs: { [gpio: number]: number };
  /** Persisted pin configs, verbatim as sent (re-applied at boot). */
  pins: PinConfig[];
  /** Persisted add-on configs. */
  modules: FakeModule[];
  rules: Rule[];
  /** RAM log ring (80 lines, each at most 159 chars, oldest first). */
  logs: string[];
  /** What `network/scan` returns. */
  scan: AccessPoint[];
  /** `""` = open. Never readable (only `network.ap_open`). */
  apPassword: string;
  sinks: DeviceSinks | undefined;
  serialSession: boolean;
  /** Pending-firmware emulation state; `undefined` unless `pendingFirmware` (see `pending.ts`). */
  pending?: FakePending;
}

/** What a reboot does on the way back up. */
export interface BootAction {
  factory?: boolean;
  /** `ota.rollback`: boot the other slot, mark the current one invalid. */
  rollback?: boolean;
  /** An OTA image that was just written to the other slot. */
  ota?: FakeSlot;
}

export const LOG_LINES = 80;
export const LOG_WIDTH = 159;

export function pushLog(state: FakeState, line: string): void {
  state.logs.push(line.length > LOG_WIDTH ? line.slice(0, LOG_WIDTH) : line);
  while (state.logs.length > LOG_LINES) state.logs.shift();
}

export function uptimeS(state: FakeState, now = Date.now()): number {
  return Math.max(0, Math.floor((now - state.bootAt) / 1000));
}

/** Name to topic id: spaces and dots become `_`, other chars outside `[A-Za-z0-9_-]` are dropped. */
export function topicIdFor(name: string, hostname: string): string {
  const t = name.replace(/[ .]/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
  return t || hostname;
}

export function macFromId(id: string): string {
  return (id.match(/../g) ?? []).join(":");
}

const SLOT_SIZE = 1835008;
const OTA0_OFFSET = 65536;

export const DEFAULT_COMPILE_DATE = "Nov 10 2026";
export const DEFAULT_COMPILE_TIME = "09:12:44";
export const FAKE_PROJECT = "de_esp32_runtime";
export const FAKE_IDF = "v5.4.2";

function defaultMemory(): MemoryInfo {
  return {
    pressure: "ok",
    alloc_failed: false,
    alloc_failed_size: 0,
    reserve: 24576,
    internal: { total: 327200, min: 118400, used: 176000, free: 151200, largest: 90112 },
    dma: { free: 140000, largest: 86016 },
    psram: null,
    boot: [
      { stage: "identity", free: 290000, largest: 110592 },
      { stage: "network", free: 210000, largest: 98304 },
      { stage: "components", free: 160000, largest: 90112 },
    ],
    tasks: [
      { name: "httpd", stack_min: 2412 },
      { name: "wifi", stack_min: 3120 },
      { name: "mqtt_task", stack_min: 2860 },
    ],
    tasks_truncated: false,
  };
}

export function createState(o: ResolvedOptions): FakeState {
  const id = o.id;
  const hostname = `esp32-${id.slice(6)}`;
  const name = o.name ?? hostname;
  const state: FakeState = {
    id,
    mac: macFromId(id),
    hostname,
    name,
    topic_id: topicIdFor(name, hostname),
    fw: o.fw,
    chip: "ESP32 rev3",
    chip_info: { model: "ESP32", revision: 3, cores: 2, features: ["wifi", "bt", "ble"] },
    schema: 4,
    generation: 1,
    bootAt: Date.now(),
    boot_count: 1,
    reset_reason: 1,
    memory: defaultMemory(),
    boot_state: o.safeMode ? "safe_mode" : "healthy",
    safe_mode: o.safeMode,
    safe_reason: o.safeMode ? "forced by fake device option" : "",
    network: {
      state: "sta_connected",
      sta_ip: "192.168.1.42",
      ap_ip: "192.168.4.1",
      ap_ssid: hostname,
      ap_open: true,
      hostname,
      rssi: -58,
      provisioned: true,
      sta_connected: true,
    },
    mqtt: {
      enabled: false,
      connected: false,
      uri: "",
      reconnects: 0,
      published: 0,
      publish_fail: 0,
      received: 0,
      last_error: "",
      root: "devices",
      sub: ["system/command", "config/set", "components/+/set"],
      pub: ["availability", "status", "telemetry", "io", "events", "api"],
      user: "",
      password: "",
    },
    ota: {
      slots: [
        { app_version: o.appVersion, compile_date: DEFAULT_COMPILE_DATE, compile_time: DEFAULT_COMPILE_TIME, idf: FAKE_IDF, project: FAKE_PROJECT },
        o.seed === "demo"
          ? { app_version: "5e3c76f", compile_date: "Nov 03 2026", compile_time: "17:40:02", idf: FAKE_IDF, project: FAKE_PROJECT }
          : null,
      ],
      running: 0,
      image_state: "valid",
      session: "idle",
      bytes: 0,
      total: 0,
      percent: 0,
    },
    io: {},
    inputs: {},
    pins: [],
    modules: [],
    rules: [],
    logs: [],
    scan: defaultScan(),
    apPassword: "",
    sinks: o.legacy ? undefined : { ws: 0, mqtt: false, serial: false, rules: 0 },
    serialSession: false,
  };
  if (o.pendingFirmware) {
    state.pending = createPending(o);
    Object.assign(state.network, initialNetworkFields(state.pending));
  }
  if (o.apMode) {
    // An unprovisioned board raising its setup Wi-Fi: nothing saved, no STA address.
    const net = state.network;
    net.state = "ap_only";
    net.sta_ip = "";
    net.sta_connected = false;
    net.provisioned = false;
    net.rssi = 0;
    if (net.netmask !== undefined) net.netmask = "";
    if (net.gateway !== undefined) net.gateway = "";
    if (net.dns !== undefined) net.dns = "";
  }
  if (!o.legacy) {
    state.mqtt.backlog = 0;
    state.mqtt.backlogs = {};
    state.mqtt.io_dropped = 0;
    state.mqtt.outbox = 0;
  }
  bootLogs(state);
  return state;
}

export function bootLogs(state: FakeState): void {
  state.logs = [];
  pushLog(state, `I (312) boot: ${FAKE_PROJECT} ${state.ota.slots[state.ota.running]?.app_version ?? "?"} fw ${state.fw}`);
  pushLog(state, `I (398) identity: id ${state.id} hostname ${state.hostname}`);
  pushLog(state, `I (1204) network: state ${state.network.state}`);
  pushLog(state, `I (2310) boot: state ${state.boot_state}`);
}

function defaultScan(): AccessPoint[] {
  return [
    { ssid: "workshop-wifi", rssi: -48, channel: 6, auth: 3 },
    { ssid: "guest", rssi: -61, channel: 1, auth: 0 },
    { ssid: "neighbour-5g", rssi: -77, channel: 11, auth: 3 },
    { ssid: "FRITZ!Box 7590", rssi: -82, channel: 3, auth: 4 },
    { ssid: "fail", rssi: -70, channel: 9, auth: 3 },
  ];
}

/** Applied through the normal commands after `createState` (see `fakeDevice.ts`). */
export const DEMO_SEED = {
  inputs: { 32: 1650, 27: 1 } as { [gpio: number]: number },
  pins: [
    { gpio: 4, mode: "out", boot: 0 },
    { gpio: 27, mode: "in", pull_up: true },
    { gpio: 18, mode: "pwm", hz: 1000, duty: 250 },
    { gpio: 19, mode: "servo", angle: 90 },
    { gpio: 32, mode: "adc" },
  ] as PinConfig[],
  modules: [
    {
      type: "bme280",
      id: "env0",
      bus: "i2c0",
      pins: { sda: 21, scl: 22 },
      settings: { addr: 118, sample_ms: 1000, osrs_t: 1, osrs_p: 1, osrs_h: 1, filter: 0, mode: "normal" },
    },
  ] as ModuleAddFields[],
  rules: [
    { id: "r32", on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } },
  ] as RuleInput[],
  mqtt: { uri: "mqtt://192.168.1.10:1883", root: "devices", user: "fake", password: "secret", connected: true },
};

// ---------------------------------------------------------------------------------------------------------------
// Hardware, owners
// ---------------------------------------------------------------------------------------------------------------

type BaseHardware = {
  board_id: string;
  board_name: string;
  status_led_gpio: number;
  status_led_active_high: boolean;
  boot_gpio: number;
  header: { usb: string; left: Array<{ silk: string; gpio: number | null; kind: HeaderPad["kind"] }>; right: Array<{ silk: string; gpio: number | null; kind: HeaderPad["kind"] }> };
  pins: Array<Omit<HardwarePin, "owner" | "flags">>;
};

const BASE = devkitcSnapshot() as unknown as BaseHardware;
const CAPS = new Map<number, Omit<HardwarePin, "owner" | "flags">>(BASE.pins.map((p) => [p.gpio, p]));

/** Capability flags of a GPIO from the DevKitC profile, or `undefined` when the pin does not exist. */
export function pinCaps(gpio: number): Omit<HardwarePin, "owner" | "flags"> | undefined {
  return CAPS.get(gpio);
}

const FLAG_ORDER = ["input", "output", "pull", "pwm", "adc1", "adc2", "touch", "dac", "strap", "flash", "input_only", "status_led", "boot_btn"] as const;

function flagBits(p: Omit<HardwarePin, "owner" | "flags">): number {
  let bits = 0;
  FLAG_ORDER.forEach((k, i) => {
    if (p[k]) bits |= 1 << i;
  });
  return bits;
}

export const BUSES = [
  { id: "vspi", kind: "spi", label: "VSPI", hint: "Default SPI bus (MFRC522)", pins: { sck: 18, miso: 19, mosi: 23, ss: 5 } },
  { id: "hspi", kind: "spi", label: "HSPI", hint: "Second SPI bus", pins: { sck: 14, miso: 12, mosi: 13, ss: 15 } },
  { id: "i2c0", kind: "i2c", label: "I2C 0", hint: "Default I2C bus (BME280)", pins: { sda: 21, scl: 22 } },
  { id: "uart0", kind: "uart", label: "UART0", hint: "USB serial console", pins: { tx: 1, rx: 3 } },
  { id: "uart2", kind: "uart", label: "UART2", hint: "Free UART", pins: { tx: 17, rx: 16 } },
] as const;

/** Live owner of a GPIO: `gpio_N`/`adc_N`/`pwm_N`/`servo_N` from the I/O map, `mod_<id>` from enabled add-ons. */
export function ownerOf(state: FakeState, gpio: number): string {
  for (const m of state.modules) {
    if (m.enabled && Object.values(m.pins).includes(gpio)) return `mod_${m.id}`;
  }
  for (const prefix of ["gpio", "adc", "pwm", "servo"]) {
    const s = state.io[`${prefix}_${gpio}`];
    if (s) return `${prefix}_${gpio}`;
  }
  return "";
}

export function hardwarePayload(state: FakeState): Hardware {
  const pads = (list: BaseHardware["header"]["left"]): HeaderPad[] => list.map((p, i) => ({ i, silk: p.silk, kind: p.kind, gpio: p.gpio }));
  return {
    board_id: BASE.board_id,
    board_name: BASE.board_name,
    status_led_gpio: BASE.status_led_gpio,
    status_led_active_high: BASE.status_led_active_high,
    boot_gpio: BASE.boot_gpio,
    header: { usb: BASE.header.usb, left: pads(BASE.header.left), right: pads(BASE.header.right) },
    buses: BUSES.map((b) => ({ ...b, pins: { ...b.pins } })),
    chip: state.chip,
    chip_info: { ...state.chip_info, features: [...state.chip_info.features] },
    pins: BASE.pins.map((p) => ({ ...p, flags: flagBits(p), owner: ownerOf(state, p.gpio) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Serializers (§2.3)
// ---------------------------------------------------------------------------------------------------------------

export function networkStatus(state: FakeState): NetworkStatus {
  return decorateNetwork(state, { ...state.network });
}

export function mqttStatus(state: FakeState): MqttStatus {
  const m = state.mqtt;
  const out: MqttStatus = {
    connected: m.connected,
    uri: m.uri,
    reconnects: m.reconnects,
    published: m.published,
    publish_fail: m.publish_fail,
    received: m.received,
    last_error: m.last_error,
    root: m.root,
    prefix: `${m.root}/${state.topic_id}`,
    topic_id: state.topic_id,
    sub: [...m.sub],
    pub: [...m.pub],
  };
  if (m.backlog !== undefined) out.backlog = m.backlog;
  if (m.backlogs !== undefined) out.backlogs = { ...m.backlogs };
  if (m.io_dropped !== undefined) out.io_dropped = m.io_dropped;
  if (m.outbox !== undefined) out.outbox = m.outbox;
  return out;
}

export function rollbackPossible(state: FakeState): boolean {
  const other = state.ota.slots[state.ota.running === 0 ? 1 : 0];
  return other !== null && !other.invalid;
}

export function otaStatus(state: FakeState): OtaStatus {
  const o = state.ota;
  const slot = o.slots[o.running] ?? o.slots[0];
  if (!slot) throw new Error("fake device has no running slot");
  const out: OtaStatus = {
    fw: state.fw,
    idf: slot.idf,
    app_version: slot.app_version,
    project: slot.project,
    compile_date: slot.compile_date,
    compile_time: slot.compile_time,
    running_partition: `ota_${o.running}`,
    running_offset: o.running === 0 ? OTA0_OFFSET : OTA0_OFFSET + SLOT_SIZE,
    running_size: SLOT_SIZE,
    image_state: o.image_state,
    next_partition: `ota_${o.running === 0 ? 1 : 0}`,
    next_size: SLOT_SIZE,
    rollback_possible: rollbackPossible(state),
    busy: o.session === "writing" || o.session === "fetching",
    session: o.session,
    bytes: o.bytes,
    total: o.total,
    percent: o.percent,
  };
  if (o.last_error) out.last_error = o.last_error;
  if (o.incoming_version) out.incoming_version = o.incoming_version;
  if (o.incoming_project) out.incoming_project = o.incoming_project;
  return out;
}

export function telemetrySnapshot(state: FakeState, now = Date.now()): TelemetrySnapshot {
  const mem = JSON.parse(JSON.stringify(state.memory)) as MemoryInfo;
  return {
    v: 1,
    id: state.id,
    fw: state.fw,
    uptime_s: uptimeS(state, now),
    boot_count: state.boot_count,
    reset_reason: state.reset_reason,
    heap_free: state.memory.internal.free,
    heap_min: state.memory.internal.min,
    memory: mem,
    boot_state: state.boot_state,
    safe_mode: state.safe_mode,
    network: networkStatus(state),
    mqtt: mqttStatus(state),
    ota: otaStatus(state),
    io: JSON.parse(JSON.stringify(state.io)) as IoMap,
  };
}

export function statusPayload(state: FakeState, wsRegistered: number): DeviceStatus {
  const out: DeviceStatus = {
    ...telemetrySnapshot(state),
    name: state.name,
    topic_id: state.topic_id,
    hostname: state.hostname,
    mac: state.mac,
    chip: state.chip,
    chip_info: { ...state.chip_info, features: [...state.chip_info.features] },
    ap_ssid: state.network.ap_ssid,
    schema: state.schema,
    generation: state.generation,
    safe_reason: state.safe_reason,
  };
  if (state.sinks) {
    out.sinks = {
      ws: wsRegistered,
      mqtt: state.mqtt.enabled && state.mqtt.connected,
      serial: state.serialSession,
      rules: state.rules.length,
    };
  }
  return out;
}

export function moduleInstances(state: FakeState): ModuleInstance[] {
  return state.modules.map((m) => {
    const inst: ModuleInstance = { id: m.id, type: m.type, bus: m.bus, enabled: m.enabled, pins: { ...m.pins }, settings: { ...m.settings } };
    const live = state.io[`mod_${m.id}`];
    if (live && (live.id === m.id) && "type" in live) inst.state = JSON.parse(JSON.stringify(live)) as ModuleInstance["state"];
    return inst;
  });
}

export function ruleList(state: FakeState): RuleList {
  return { v: 1, rules: JSON.parse(JSON.stringify(state.rules)) as Rule[] };
}

/** Event-bus topic for an I/O state value. */
export function ioTopic(s: IoState): DeviceWsTopic {
  if ("type" in s) return s.type === "bme280" ? "io/env" : "io/rfid";
  return `io/${s.mode === "in" || s.mode === "out" ? "gpio" : s.mode}` as DeviceWsTopic;
}
