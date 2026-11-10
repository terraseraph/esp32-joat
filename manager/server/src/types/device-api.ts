/**
 * de-esp32 device API types (`@shared/device-api`), the single source for the server, the web app and the fake device.
 *
 * Plain types only (no runtime code); web code must `import type` from here.
 * Field names are the device's snake_case, exactly as sent. Section numbers refer to `docs/manager-app.md`.
 *
 * Fields marked OPTIONAL were added by newer firmware (see the "Moving target" note at the top of §2); older
 * devices do not send them, so consumers must tolerate their absence.
 */

// ---------------------------------------------------------------------------------------------------------------
// Command envelope (§2.1)
// ---------------------------------------------------------------------------------------------------------------

/** Successful command reply. `result` is omitted for commands with nothing to return (`system.*`, `ota.rollback`). */
export interface DeviceOk<T = undefined> {
  v: 1;
  ok: true;
  /** Echo of the request's `corr`, when one was sent. */
  corr?: string;
  result?: T;
}

/** Failed command reply. `error` is a short string (<= 95 chars); there are no error codes. */
export interface DeviceErr {
  v: 1;
  ok: false;
  corr?: string;
  error: string;
}

export type DeviceEnvelope<T = undefined> = DeviceOk<T> | DeviceErr;

// ---------------------------------------------------------------------------------------------------------------
// Telemetry / status (§2.3)
// ---------------------------------------------------------------------------------------------------------------

export type MemoryPressure = "ok" | "warn" | "critical";

/** `memory` block of the telemetry snapshot (§2.3, `memory_budget.cpp:176`). */
export interface MemoryInfo {
  pressure: MemoryPressure;
  alloc_failed: boolean;
  alloc_failed_size: number;
  reserve: number;
  internal: { total: number; min: number; used: number; free: number; largest: number };
  dma: { free: number; largest: number };
  /** `null` on boards without PSRAM; shape when present is not verified. */
  psram: { total?: number; free?: number; largest?: number; [k: string]: unknown } | null;
  /** At most 8 entries. */
  boot: Array<{ stage: string; free: number; largest: number }>;
  /** At most 24 entries, refreshed at most every 5 s. */
  tasks: Array<{ name: string; stack_min: number }>;
  tasks_truncated: boolean;
}

export type BootState =
  | "boot"
  | "diagnostics"
  | "identity"
  | "config"
  | "capability"
  | "safe_pins"
  | "network"
  | "provisioning"
  | "management"
  | "mqtt"
  | "components"
  | "healthy"
  | "safe_mode"
  | "unknown";

/** `idle | ap_only | sta_connecting | sta_connected | apsta_recovery` (§2.3, `network_manager.cpp:212-226`). */
export type NetState = "idle" | "ap_only" | "sta_connecting" | "sta_connected" | "apsta_recovery";

/** Network status (§2.3, `network_manager.cpp:348-360`). The saved SSID is never exposed. */
export interface NetworkStatus {
  state: NetState;
  /** Empty string when not connected. */
  sta_ip: string;
  ap_ip: string;
  ap_ssid: string;
  ap_open: boolean;
  hostname: string;
  /** Sampled at connect time, not live. */
  rssi: number;
  provisioned: boolean;
  sta_connected: boolean;
  /**
   * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): outcome of the last `network.wifi.set`.
   * Absent on current firmware; feature-detect (§2.9).
   */
  wifi_change?: WifiChange;
  /** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): `dhcp` or `static`. Absent on current firmware. */
  ip_mode?: IpMode;
  /** PENDING firmware: live STA netmask, `""` while not connected. */
  netmask?: string;
  /** PENDING firmware: live STA gateway, `""` while not connected. */
  gateway?: string;
  /** PENDING firmware: live STA DNS server, `""` while not connected. */
  dns?: string;
  /** PENDING firmware: number of clients on the device's SoftAP. */
  ap_clients?: number;
  /** PENDING firmware: state of the last `network.ip.set` (RAM only, lost on reboot). */
  ip_change?: IpChange;
}

/** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): `wifi_change.result` (§2.9). */
export type WifiChangeResult = "none" | "testing" | "ok" | "failed";

/**
 * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): `wifi_change.reason`, present when failed.
 * `auth` wrong password, `no_ap` SSID not found, `no_ip` associated but no DHCP lease, `timeout`, `connect_failed`,
 * `save_failed` (connected but the NVS write failed; a reboot returns to the old network).
 */
export type WifiChangeReason = "auth" | "no_ap" | "no_ip" | "timeout" | "connect_failed" | "save_failed";

/**
 * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): outcome of the last Wi-Fi change attempt.
 * RAM only, lost on reboot. Only `result` is present while it is `none`. Compare `seq` before and after an attempt
 * to tell it from an older one.
 */
export interface WifiChange {
  result: WifiChangeResult;
  /** SSID that was tried (never the password). */
  ssid?: string;
  /** Present when `result` is `failed`. */
  reason?: WifiChangeReason;
  /** Last raw `wifi_err_reason_t`, 0 if none. */
  disconnect_reason?: number;
  /** True when the STA was pointed back at the saved network (the reconnect may still be pending). */
  restored_previous?: boolean;
  /** When the result was recorded (device uptime). */
  uptime_s?: number;
  /** Unix seconds; 0 until SNTP has set the clock. */
  time?: number;
  /** Attempts since boot. */
  seq?: number;
}

/** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): how the STA gets its address. */
export type IpMode = "dhcp" | "static";

/** PENDING firmware: `ip_change.result`. `reset` = a static config was dropped by a Wi-Fi credential change. */
export type IpChangeResult = "none" | "pending" | "ok" | "reverted" | "reset" | "failed";

/**
 * PENDING firmware: `ip_change.reason`. `confirmed` (client confirmed), `dhcp_lease` (switch to DHCP got a lease),
 * `offline` (DHCP saved while the STA was offline), `not_confirmed` (90 s elapsed), `no_dhcp_lease`,
 * `wifi_change` (a Wi-Fi change cancelled or replaced it), `save_failed`.
 */
export type IpChangeReason = "confirmed" | "dhcp_lease" | "offline" | "not_confirmed" | "no_dhcp_lease" | "wifi_change" | "save_failed";

/**
 * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): last `network.ip.set` attempt, RAM only.
 * Every field except `result` is optional (the README does not say which accompany `none`).
 */
export interface IpChange {
  result: IpChangeResult;
  reason?: IpChangeReason;
  /** The config that was tried. */
  mode?: IpMode;
  /** Address fields are present for static only. */
  ip?: string;
  netmask?: string;
  gateway?: string;
  dns?: string;
  /** True while the change is live and waiting for a confirm. */
  applied?: boolean;
  /** Seconds left to confirm (only while `applied`). */
  confirm_left_s?: number;
  uptime_s?: number;
  /** Unix seconds; 0 until SNTP has set the clock. */
  time?: number;
  seq?: number;
}

/** MQTT status (§2.3, `mqtt_manager.cpp:333-358`). User and password are never readable. */
export interface MqttStatus {
  connected: boolean;
  /** In-RAM value, empty when MQTT never started. */
  uri: string;
  reconnects: number;
  published: number;
  publish_fail: number;
  received: number;
  last_error: string;
  root: string;
  prefix: string;
  topic_id: string;
  sub: string[];
  pub: string[];
  /** OPTIONAL (newer firmware, MQTT backpressure): queued messages. */
  backlog?: number;
  /** OPTIONAL: per-class backlog; keys are not verified. */
  backlogs?: { [k: string]: number };
  /** OPTIONAL: I/O events dropped by backpressure. */
  io_dropped?: number;
  /** OPTIONAL: messages in the MQTT client outbox. */
  outbox?: number;
}

/** `new | pending_verify | valid | invalid | aborted | undefined` (§2.3). */
export type ImageState = "new" | "pending_verify" | "valid" | "invalid" | "aborted" | "undefined";
/** `idle | writing | fetching | rebooting | error` (§2.3). */
export type OtaSession = "idle" | "writing" | "fetching" | "rebooting" | "error";

/** OTA status (§2.3, `ota_manager.cpp:427-483`). */
export interface OtaStatus {
  fw: string;
  idf: string;
  app_version: string;
  /** Project name; the device rejects images whose `project_name` differs (`de_esp32_runtime`). */
  project: string;
  /** `__DATE__` format, e.g. `Nov 10 2026`. */
  compile_date: string;
  /** `__TIME__` format, e.g. `09:12:44`. */
  compile_time: string;
  running_partition: string;
  running_offset: number;
  running_size: number;
  image_state: ImageState;
  next_partition: string;
  next_size: number;
  rollback_possible: boolean;
  busy: boolean;
  session: OtaSession;
  bytes: number;
  total: number;
  percent: number;
  /** Present only when set. */
  last_error?: string;
  incoming_version?: string;
  incoming_project?: string;
}

/** Event sinks that are currently active. OPTIONAL (newer firmware); value types are not verified. */
export interface DeviceSinks {
  ws?: number | boolean;
  mqtt?: number | boolean;
  serial?: number | boolean;
  rules?: number | boolean;
}

/** Telemetry snapshot (§2.3; `GET /telemetry`, base of `GET /status`, WS topic `telemetry`). */
export interface TelemetrySnapshot {
  v: 1;
  /** MAC hex, 12 lowercase chars; the stable device key. */
  id: string;
  /** `RUNTIME_VERSION`, a hard-coded constant. */
  fw: string;
  uptime_s: number;
  boot_count: number;
  /** Numeric `esp_reset_reason_t` (1 power-on, 3 software). */
  reset_reason: number;
  heap_free: number;
  heap_min: number;
  memory: MemoryInfo;
  boot_state: BootState;
  safe_mode: boolean;
  network: NetworkStatus;
  mqtt: MqttStatus;
  ota: OtaStatus;
  io: IoMap;
}

export interface ChipInfo {
  model: string;
  revision: number;
  cores: number;
  features: string[];
}

/** `GET /status` (§2.2): the telemetry snapshot plus the status-only fields. */
export interface DeviceStatus extends TelemetrySnapshot {
  /** Falls back to the hostname when unset. */
  name: string;
  topic_id: string;
  /** `esp32-xxxxxx` (last 3 MAC bytes). */
  hostname: string;
  /** `aa:bb:cc:dd:ee:ff`. */
  mac: string;
  /** e.g. `ESP32 rev3`. */
  chip: string;
  chip_info: ChipInfo;
  /** Equals the hostname. */
  ap_ssid: string;
  /** Config schema version (4). */
  schema: number;
  generation: number;
  safe_reason: string;
  /** OPTIONAL (newer firmware). */
  sinks?: DeviceSinks;
}

// ---------------------------------------------------------------------------------------------------------------
// Hardware (§2.3)
// ---------------------------------------------------------------------------------------------------------------

export type HeaderPadKind = "gpio" | "power" | "gnd" | "en";

export interface HeaderPad {
  /** Index within the header column. May be absent on offline snapshots. */
  i?: number;
  silk: string;
  /** `null` for power/gnd/en pads. */
  gpio: number | null;
  kind: HeaderPadKind;
}

export interface HardwareBus {
  id: string;
  kind: "spi" | "i2c" | "uart";
  label: string;
  hint?: string;
  /** Role to GPIO, e.g. `{sck:18, miso:19, mosi:23, ss:5}`. */
  pins: { [role: string]: number };
}

/** One entry of `/hardware.pins` (§2.3): capability flags + the live `owner`. */
export interface HardwarePin {
  gpio: number;
  /** Capability bit field; informational. */
  flags?: number;
  input: boolean;
  output: boolean;
  pull: boolean;
  pwm: boolean;
  adc1: boolean;
  adc2: boolean;
  touch: boolean;
  dac: boolean;
  strap: boolean;
  flash: boolean;
  input_only: boolean;
  status_led: boolean;
  boot_btn: boolean;
  adc_channel: number;
  touch_channel: number;
  role: string;
  notes: string;
  /** `""`, `gpio_N`, `adc_N`, `pwm_N`, `servo_N`, `mod_<id>`, `bus_...`. */
  owner: string;
}

/** `GET /hardware` (§2.2/§2.3). */
export interface Hardware {
  board_id: string;
  board_name: string;
  status_led_gpio: number;
  status_led_active_high: boolean;
  boot_gpio: number;
  header: { usb: string; left: HeaderPad[]; right: HeaderPad[] };
  buses: HardwareBus[];
  chip: string;
  chip_info: ChipInfo;
  pins: HardwarePin[];
}

// ---------------------------------------------------------------------------------------------------------------
// Live I/O map (§2.4)
// ---------------------------------------------------------------------------------------------------------------

/** `gpio_N` (`io_gpio.cpp:38-52`). `debounce_ms` only for `in`. */
export interface GpioState {
  id: string;
  mode: "in" | "out";
  gpio: number;
  level: 0 | 1;
  debounce_ms?: number;
}

/** `adc_N` (`io_adc.cpp:65-81`). */
export interface AdcState {
  id: string;
  mode: "adc";
  gpio: number;
  mv: number;
  raw: number;
  sample_ms: number;
  hysteresis_mv: number;
  smooth: number;
}

/** `pwm_N` (`io_pwm.cpp:42-54`); `duty` 0-1000. */
export interface PwmState {
  id: string;
  mode: "pwm";
  gpio: number;
  hz: number;
  duty: number;
}

/** `servo_N` (`io_servo.cpp:94-110`). */
export interface ServoState {
  id: string;
  mode: "servo";
  gpio: number;
  angle: number;
  pulse_us: number;
  min_us: number;
  max_us: number;
  hz: number;
}

/** `mod_<id>` BME280 (`mod_bme280.cpp:317-334`); readings only when `ok`. */
export interface Bme280State {
  id: string;
  type: "bme280";
  ok: boolean;
  addr: number;
  t_c?: number;
  p_hpa?: number;
  rh?: number;
}

/** `mod_<id>` MFRC522 (`mod_mfrc522.cpp:385-392`); `uid` is uppercase hex, `""` when absent. */
export interface Mfrc522State {
  id: string;
  type: "mfrc522";
  present: boolean;
  uid: string;
  /** Chip version register (0x92 = v2.0). */
  version: number;
  /** Antenna TX control register value (not verified beyond "number"). */
  tx: number;
}

export type IoState = GpioState | AdcState | PwmState | ServoState | Bme280State | Mfrc522State;
/** `status.io`, `GET /pins`, up to 48 keys. Keys: `gpio_N`, `adc_N`, `pwm_N`, `servo_N`, `mod_<id>`. */
export type IoMap = { [key: string]: IoState };

// ---------------------------------------------------------------------------------------------------------------
// Pins (§2.5 pin.configure)
// ---------------------------------------------------------------------------------------------------------------

export type PinMode = "disabled" | "out" | "in" | "pwm" | "servo" | "adc";
export type DeliveryMode = "reliable" | "latest";

/**
 * A pin object as sent to `pin.configure` and persisted verbatim by the device (any extra keys too, hence the
 * index signature). Send minimal objects (§2.7 #6).
 */
export interface PinConfig {
  gpio: number;
  mode: PinMode;
  pull_up?: boolean;
  pull_down?: boolean;
  invert?: boolean;
  /** Initial level (0/1) for `out`. */
  boot?: number;
  irq?: boolean;
  /** 0-500, default 50 (`in`). */
  debounce_ms?: number;
  /** 50-20000, default 1000 (`pwm`; shared by all PWM pins). */
  hz?: number;
  /** 0-1000 (`pwm`). */
  duty?: number;
  /** 0-180, default 90 (`servo`). */
  angle?: number;
  min_us?: number;
  max_us?: number;
  /** 20-1000, default 50 (`adc`). */
  sample_ms?: number;
  /** 5-500, default 20 (`adc`). */
  hysteresis_mv?: number;
  /** 0-90, default 70 (`adc`). */
  smooth?: number;
  /** OPTIONAL (newer firmware): MQTT backpressure class. */
  delivery?: DeliveryMode;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Modules / add-ons (§2.5)
// ---------------------------------------------------------------------------------------------------------------

export type ModuleType = "bme280" | "mfrc522";

export interface ModuleCatalogPin {
  role: string;
  required: boolean;
  share: "bus" | "instance";
  cap: "in" | "out";
}

export interface ModuleCatalogSetting {
  key: string;
  label: string;
  kind: "int" | "enum";
  def: number | string;
  min?: number;
  max?: number;
  choices?: Array<{ value: number | string; label: string }>;
}

export interface ModuleCatalogType {
  type: ModuleType | string;
  label: string;
  summary: string;
  bus: "spi" | "i2c";
  default_bus: string;
  id_prefix: string;
  max_instances: number;
  pins: ModuleCatalogPin[];
  settings: ModuleCatalogSetting[];
}

export interface ModuleCatalog {
  types: ModuleCatalogType[];
}

/** One add-on instance as listed by `module.list` (the persisted config plus live `state`). */
export interface ModuleInstance {
  id: string;
  type: ModuleType | string;
  /** `vspi | hspi` or `i2c0 | i2c1`. */
  bus: string;
  enabled: boolean;
  /** Role to GPIO. */
  pins: { [role: string]: number };
  settings?: { [key: string]: number | string };
  /** Live `mod_<id>` value. */
  state?: Bme280State | Mfrc522State;
}

/** Result of `module.list|add|configure|remove`. */
export interface ModuleList {
  v: 1;
  modules: ModuleInstance[];
}

// ---------------------------------------------------------------------------------------------------------------
// Rules (§2.5)
// ---------------------------------------------------------------------------------------------------------------

/** Words are what the device reports; symbols are accepted on input. */
export type RuleOp = "gt" | "ge" | "lt" | "le" | "eq" | "ne";
export type RuleOpInput = RuleOp | ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface RuleAction {
  gpio: number;
  value: number;
}

export interface Rule {
  /** At most 7 chars; default `r<source gpio>`. */
  id: string;
  enabled: boolean;
  on: { gpio: number; op: RuleOp; value: number };
  then: RuleAction;
  else?: RuleAction;
}

/** Rule as sent to `rule.set`. */
export interface RuleInput {
  id?: string;
  enabled?: boolean;
  on: { gpio: number; op: RuleOpInput; value: number };
  then: RuleAction;
  else?: RuleAction;
}

/** Result of `rule.set|remove|list` (max 8 rules). */
export interface RuleList {
  v: 1;
  rules: Rule[];
}

// ---------------------------------------------------------------------------------------------------------------
// Misc payloads
// ---------------------------------------------------------------------------------------------------------------

/** One entry of `GET /network/scan` (a bare array of up to 24). `auth` is the numeric `wifi_auth_mode_t` (0 = open). */
export interface AccessPoint {
  ssid: string;
  rssi: number;
  channel: number;
  auth: number;
}

/** `GET /logs`: RAM ring, 80 lines x 159 chars, oldest first. */
export interface LogsResponse {
  lines: string[];
}

/** `GET /openapi.json` (§2.2): OpenAPI 3.0.3 plus device extensions. Only the extension fields are typed. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; [k: string]: unknown };
  paths: { [path: string]: unknown };
  /** The command catalog (`kCmds`). */
  "x-commands": string[];
  "x-mqtt": { root: string; prefix: string; topics: string[] };
  "x-discovery": { mdns: string; service: string; de_service: string; board: string; port: number };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Command requests (§2.5) and results
// ---------------------------------------------------------------------------------------------------------------

export interface CommandBase {
  /** Optional protocol version. */
  v?: 1;
  /** Echoed in the reply. */
  corr?: string;
}

/** `pin.configure`: `pin: {...}`, or the pin fields at the top level (as `POST /pins` does). */
export interface PinConfigureCommand extends CommandBase {
  cmd: "pin.configure";
  pin?: PinConfig;
  gpio?: number;
  mode?: PinMode;
  delivery?: DeliveryMode;
  [pinField: string]: unknown;
}
/** `pin.set`: `mode` defaults to `out`. */
export interface PinSetCommand extends CommandBase {
  cmd: "pin.set";
  gpio: number;
  value: number;
  mode?: "out" | "pwm" | "servo";
}
export interface IoHydrateCommand extends CommandBase {
  cmd: "io.hydrate";
}
export interface ModuleCatalogCommand extends CommandBase {
  cmd: "module.catalog";
}
export interface ModuleListCommand extends CommandBase {
  cmd: "module.list";
}
export interface ModuleAddFields {
  type: ModuleType | string;
  id?: string;
  bus?: string;
  pins: { [role: string]: number };
  settings?: { [key: string]: number | string };
  enabled?: boolean;
  /** OPTIONAL (newer firmware). */
  delivery?: DeliveryMode;
}
/** `module.add`: fields at top level or nested under `module`. */
export interface ModuleAddCommand extends CommandBase, Partial<ModuleAddFields> {
  cmd: "module.add";
  module?: ModuleAddFields;
}
export interface ModuleConfigureFields {
  id: string;
  bus?: string;
  pins?: { [role: string]: number };
  settings?: { [key: string]: number | string };
  enabled?: boolean;
}
export interface ModuleConfigureCommand extends CommandBase, Partial<ModuleConfigureFields> {
  cmd: "module.configure";
  module?: ModuleConfigureFields;
}
export interface ModuleRemoveCommand extends CommandBase {
  cmd: "module.remove";
  id: string;
}
/** Both current module types answer "module has no commands". */
export interface ModuleCmdCommand extends CommandBase {
  cmd: "module.cmd";
  id: string;
  [k: string]: unknown;
}
export interface RuleSetCommand extends CommandBase {
  cmd: "rule.set";
  rule: RuleInput;
}
export interface RuleRemoveCommand extends CommandBase {
  cmd: "rule.remove";
  id?: string;
  gpio?: number;
}
export interface RuleListCommand extends CommandBase {
  cmd: "rule.list";
}
export interface NetworkWifiSetCommand extends CommandBase {
  cmd: "network.wifi.set";
  ssid: string;
  password: string;
}
export interface NetworkWifiScanCommand extends CommandBase {
  cmd: "network.wifi.scan";
}
export interface NetworkWifiClearCommand extends CommandBase {
  cmd: "network.wifi.clear";
}
export interface NetworkRecoveryApCommand extends CommandBase {
  cmd: "network.recovery_ap";
}
export interface NetworkApSetPasswordCommand extends CommandBase {
  cmd: "network.ap.set_password";
  /** `""` = open, else 8-63 chars. */
  password: string;
}
export interface MqttConfigureCommand extends CommandBase {
  cmd: "mqtt.configure";
  uri?: string;
  /** Credentials are only written when `user` is a string. */
  user?: string;
  password?: string;
  root?: string;
}
export interface IdentitySetNameCommand extends CommandBase {
  cmd: "identity.set_name";
  /** At most 31 chars. */
  name?: string;
}
export interface SystemRebootCommand extends CommandBase {
  cmd: "system.reboot";
}
export interface SystemFactoryResetCommand extends CommandBase {
  cmd: "system.factory_reset";
}
export interface OtaApplyCommand extends CommandBase {
  cmd: "ota.apply";
  /** `http://` or `https://`, shorter than 384 chars. */
  url: string;
}
export interface OtaRollbackCommand extends CommandBase {
  cmd: "ota.rollback";
}
/**
 * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): switch the STA to a static address.
 * `dns` is optional and defaults to the gateway. The device replies first and applies the change about 1.5 s later;
 * it must be confirmed at the new address within 90 s or it reverts.
 */
export interface NetworkIpSetStaticCommand extends CommandBase {
  cmd: "network.ip.set";
  mode: "static";
  ip: string;
  netmask: string;
  gateway: string;
  dns?: string;
}
/** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): return the STA to DHCP. */
export interface NetworkIpSetDhcpCommand extends CommandBase {
  cmd: "network.ip.set";
  mode: "dhcp";
}
/** PENDING firmware: `network.ip.set` in either variant. */
export type NetworkIpSetCommand = NetworkIpSetStaticCommand | NetworkIpSetDhcpCommand;
/**
 * PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged): confirm the applied static config, from
 * the new address. `seq` is optional; if given it must match `ip_change.seq`.
 */
export interface NetworkIpConfirmCommand extends CommandBase {
  cmd: "network.ip.confirm";
  seq?: number;
}
export interface SerialHelloCommand extends CommandBase {
  cmd: "serial.hello";
}
export interface SerialByeCommand extends CommandBase {
  cmd: "serial.bye";
}

/** Every command of the catalog (`kCmds`). */
export type DeviceCommand =
  | PinConfigureCommand
  | PinSetCommand
  | IoHydrateCommand
  | ModuleCatalogCommand
  | ModuleListCommand
  | ModuleAddCommand
  | ModuleConfigureCommand
  | ModuleRemoveCommand
  | ModuleCmdCommand
  | RuleSetCommand
  | RuleRemoveCommand
  | RuleListCommand
  | NetworkWifiSetCommand
  | NetworkWifiScanCommand
  | NetworkWifiClearCommand
  | NetworkRecoveryApCommand
  | NetworkApSetPasswordCommand
  | NetworkIpSetStaticCommand
  | NetworkIpSetDhcpCommand
  | NetworkIpConfirmCommand
  | MqttConfigureCommand
  | IdentitySetNameCommand
  | SystemRebootCommand
  | SystemFactoryResetCommand
  | OtaApplyCommand
  | OtaRollbackCommand
  | SerialHelloCommand
  | SerialByeCommand;

export type DeviceCommandName = DeviceCommand["cmd"];

/** `pin.configure` result: the pin as applied (defaults clamped in). `disabled` returns just `{gpio, mode}`. */
export type PinConfigureResult = PinConfig;
export interface PinSetResult {
  gpio: number;
  value: number;
}
/** `network.wifi.set` result: network status plus `mdns` (the mDNS value shape is not verified). */
export type WifiSetResult = NetworkStatus & { mdns?: unknown };
export interface MqttConfigureResult {
  uri: string;
  root: string;
}
export interface IdentitySetNameResult {
  name: string;
  topic_id: string;
  id: string;
}
/** `ota.apply` result: OTA status plus a `note`. */
export type OtaApplyResult = OtaStatus & { note: string };
/** `serial.hello` result (identity; exact shape not verified). */
export interface SerialHelloResult {
  id: string;
  name: string;
  topic_id: string;
  hostname: string;
  fw: string;
}

/** cmd to `result` type. Commands mapped to `undefined` omit `result` on success. */
export interface CommandResultMap {
  "pin.configure": PinConfigureResult;
  "pin.set": PinSetResult;
  "io.hydrate": { pins: number };
  "module.catalog": ModuleCatalog;
  "module.list": ModuleList;
  "module.add": ModuleList;
  "module.configure": ModuleList;
  "module.remove": ModuleList;
  /** Never succeeds on current firmware. */
  "module.cmd": unknown;
  "rule.set": RuleList;
  "rule.remove": RuleList;
  "rule.list": RuleList;
  "network.wifi.set": WifiSetResult;
  "network.wifi.scan": AccessPoint[];
  "network.wifi.clear": NetworkStatus;
  "network.recovery_ap": NetworkStatus;
  "network.ap.set_password": NetworkStatus;
  /** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged). */
  "network.ip.set": NetworkStatus;
  /** PENDING firmware (branch claude/wifi-change-fallback-ab5ac7, unmerged). */
  "network.ip.confirm": NetworkStatus;
  "mqtt.configure": MqttConfigureResult;
  "identity.set_name": IdentitySetNameResult;
  "system.reboot": undefined;
  "system.factory_reset": undefined;
  "ota.apply": OtaApplyResult;
  "ota.rollback": undefined;
  "serial.hello": SerialHelloResult;
  "serial.bye": { session: false };
}

/** Reply envelope type for one command. */
export type CommandReply<K extends DeviceCommandName> = DeviceEnvelope<CommandResultMap[K]>;

// ---------------------------------------------------------------------------------------------------------------
// WebSocket events (§2.6)
// ---------------------------------------------------------------------------------------------------------------

/** `ota/progress` data: every 64 KB and on state changes. */
export interface OtaProgress {
  session: OtaSession;
  bytes: number;
  total: number;
  percent: number;
  error?: string;
}

/**
 * `mqtt/reconfigure` data: the raw `mqtt.configure` request INCLUDING the password, plus `old_root`
 * (firmware leak, §12 #1). The Manager server must drop this frame before fan-out.
 */
export interface MqttReconfigureEvent {
  uri?: string;
  user?: string;
  password?: string;
  root?: string;
  old_root: string;
  [k: string]: unknown;
}

/** Device to client frame `{topic, data}`. */
export type DeviceWsEvent =
  | { topic: "io/gpio"; data: GpioState }
  | { topic: "io/adc"; data: AdcState }
  | { topic: "io/pwm"; data: PwmState }
  | { topic: "io/servo"; data: ServoState }
  | { topic: "io/env"; data: Bme280State }
  | { topic: "io/rfid"; data: Mfrc522State }
  | { topic: "telemetry"; data: TelemetrySnapshot }
  | { topic: "net"; data: { state: NetState; sta_ip: string } }
  | { topic: "ota/progress"; data: OtaProgress }
  | { topic: "identity/rename"; data: { old_topic_id: string; topic_id: string; name: string } }
  | { topic: "mqtt/reconfigure"; data: MqttReconfigureEvent };

export type DeviceWsTopic = DeviceWsEvent["topic"];
