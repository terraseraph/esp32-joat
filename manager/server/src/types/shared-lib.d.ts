/**
 * Types for the pure modules of the Node-RED package (installed as a real copy
 * in node_modules via `install-links=true`). Import them WITHOUT a `.js`
 * extension, e.g. `import { isOurs } from "node-red-contrib-de-esp32/lib/fingerprint"`;
 * that works under tsx, the node:test runner and the esbuild bundle.
 * Source: nodered/node-red-contrib-de-esp32/lib/*.js
 */

declare module "node-red-contrib-de-esp32/lib/fingerprint" {
  export interface DeviceSummary {
    ip: string;
    id: string;
    name: string;
    hostname: string;
    fw: string;
    topic_id: string;
    mqtt_prefix: string;
    mqtt_root: string;
    board: string;
    boot_state: string;
    partition: string;
    via: string;
  }
  /** True when a `/status` payload looks like a de-esp32 device. */
  export function isOurs(status: unknown): boolean;
  export function summarize(ip: string | null | undefined, status: unknown, via?: string): DeviceSummary;
}

declare module "node-red-contrib-de-esp32/lib/discover" {
  import type { DeviceSummary } from "node-red-contrib-de-esp32/lib/fingerprint";

  export type DiscoveredDevice = Partial<DeviceSummary> & { availability?: "online" | "offline" };
  export interface ScanOptions {
    timeoutMs?: number;
    host?: string;
    broker?: { broker?: string; host?: string; port?: number | string; usetls?: boolean; credentials?: Record<string, string> };
    mqttRoot?: string;
  }
  /** Parse mDNS TXT data (Buffer/string or array of them) into `{key: value}`. */
  export function parseTxt(data: unknown): Record<string, string>;
  export function looksLikeOursTxt(txt: Record<string, string | undefined>): boolean;
  /** Merge a device into a map keyed by id (or `topic:<id>` / `ip:<ip>` before the id is known). */
  export function mergeDevice(map: Map<string, DiscoveredDevice>, dev: DiscoveredDevice | null | undefined): void;
  /** mDNS (+ optional host probe / MQTT) scan. The Manager uses its own scanner; kept for completeness. */
  export function scan(opts?: ScanOptions): Promise<DiscoveredDevice[]>;
}

declare module "node-red-contrib-de-esp32/lib/pins" {
  export interface HardwarePin {
    gpio: number;
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
    /** Live owner from GET /hardware, e.g. `gpio_out`, `mod_rfid0`, `bus_i2c`, `servo_1`. */
    owner?: string;
  }
  export interface HeaderPad {
    silk: string;
    gpio: number | null;
    kind: "gpio" | "power" | "gnd" | "en" | string;
  }
  export interface Hardware {
    board_id?: string;
    board_name?: string;
    chip?: string;
    pins?: HardwarePin[];
    header?: { usb?: string; left?: HeaderPad[]; right?: HeaderPad[] };
    [key: string]: unknown;
  }
  export type PinMode = "in" | "out" | "pwm" | "servo" | "adc";
  export interface CapBadge {
    cls: string;
    text: string;
  }
  export function pinByGpio(hardware: Hardware | null | undefined, gpio: number | string): HardwarePin | null;
  export function padAllowed(pin: HardwarePin | null | undefined, mode: string): boolean;
  export function pinClaimed(owner: string | null | undefined): boolean;
  export function ownerBlocks(owner: string | null | undefined, mode: string): boolean;
  export function ownerLabel(owner: string | null | undefined): string;
  export function headerPads(hardware: Hardware | null | undefined): { left: HeaderPad[]; right: HeaderPad[] };
  export function capBadges(pin: HardwarePin | null | undefined): CapBadge[];
  export function allowedModes(pin: HardwarePin | null | undefined, family?: "in" | "out" | string): PinMode[];
}

declare module "node-red-contrib-de-esp32/lib/devkitc-hardware" {
  import type { Hardware } from "node-red-contrib-de-esp32/lib/pins";

  /** Offline ESP32-WROOM-32 DevKitC pinout (same flags as the firmware's /hardware). */
  export function snapshot(): Hardware & { status_led_gpio: number; status_led_active_high: boolean; boot_gpio: number };
  export function withFallbackMeta(err?: unknown): Hardware & { via: string; warning: string };
}
