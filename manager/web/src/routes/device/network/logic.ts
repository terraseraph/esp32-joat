import type { NetState, WifiChange } from "@shared/device-api";

export type StateTone = "ok" | "warn" | "bad" | "off" | "acc";

const NET_STATE: Record<NetState, { label: string; tone: StateTone }> = {
  sta_connected: { label: "Connected", tone: "ok" },
  sta_connecting: { label: "Connecting", tone: "acc" },
  ap_only: { label: "Setup AP only (not on Wi-Fi)", tone: "warn" },
  apsta_recovery: { label: "Recovery: Setup AP is on", tone: "warn" },
  idle: { label: "Idle", tone: "off" },
};

/** Wi-Fi state in words; unknown values are shown as sent. */
export function netStateWords(state: string): { label: string; tone: StateTone } {
  return NET_STATE[state as NetState] ?? { label: state || "unknown", tone: "off" };
}

const WIFI_REASON: Record<string, string> = {
  auth: "wrong password",
  no_ap: "network not found",
  no_ip: "no address from the router",
  timeout: "timed out",
  connect_failed: "could not connect",
  save_failed: "connected but could not save the change (a restart returns to the old network)",
};

/** One sentence for `wifi_change` (feature-detected: undefined or result "none" gives null). */
export function wifiChangeSentence(change: WifiChange | undefined | null): string | null {
  if (!change || change.result === "none") return null;
  const net = change.ssid ? ` "${change.ssid}"` : "";
  if (change.result === "testing") return `Testing a new network${net}...`;
  if (change.result === "ok") return `Last change: joined${net || " the new network"}.`;
  if (change.result === "failed") {
    const reason = (change.reason && WIFI_REASON[change.reason]) || "unknown";
    return `Last change failed: ${reason}${change.restored_previous ? "; kept the old network" : ""}.`;
  }
  return null;
}

export const MQTT_URI_REQUIRED = "uri required (mqtt://host:1883)";
export const DEFAULT_ROOT = "devices";

/** `mqtt://` or `mqtts://` host[:port]. Returns an error message or null. */
export function validateMqttUri(raw: string): string | null {
  const uri = raw.trim();
  if (!uri) return MQTT_URI_REQUIRED;
  const m = /^mqtts?:\/\/([^\s/:@]+)(?::(\d{1,5}))?$/i.exec(uri);
  if (!m) return "Use mqtt://host:1883 or mqtts://host:8883";
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return "The port must be between 1 and 65535";
  return null;
}

/** Root may be empty (the device then uses `devices`); otherwise letters, numbers, _ - and /. */
export function validateMqttRoot(raw: string): string | null {
  const root = raw.trim();
  if (!root) return null;
  return /^[A-Za-z0-9_\-/]+$/.test(root) ? null : "Use only letters, numbers, _ - and /";
}

/** `root/topic_id` as the device will build it. */
export function mqttPrefixPreview(root: string, topicId: string): string {
  const r = root.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_ROOT;
  return `${r}/${topicId || "<name>"}`;
}

export interface MqttForm {
  uri: string;
  root: string;
  changeCreds: boolean;
  user: string;
  password: string;
}

export interface MqttCurrent {
  uri: string;
  root: string;
}

export interface MqttConfigureBody {
  cmd: "mqtt.configure";
  uri?: string;
  root?: string;
  user?: string;
  password?: string;
}

/**
 * Only changed fields. Credentials are sent (both `user` and `password`) only when "Change credentials"
 * is on, because the firmware writes them only when `user` is a string. Returns null when nothing changed.
 */
export function buildMqttConfigure(form: MqttForm, current: MqttCurrent): MqttConfigureBody | null {
  const body: MqttConfigureBody = { cmd: "mqtt.configure" };
  const uri = form.uri.trim();
  if (uri !== current.uri.trim()) body.uri = uri;
  const root = form.root.trim() || DEFAULT_ROOT;
  if (root !== (current.root.trim() || DEFAULT_ROOT)) body.root = root;
  if (form.changeCreds) {
    body.user = form.user;
    body.password = form.password;
  }
  return Object.keys(body).length > 1 ? body : null;
}

/** All validation errors of the Configure form. */
export function validateMqttForm(form: MqttForm): { uri: string | null; root: string | null } {
  return { uri: validateMqttUri(form.uri), root: validateMqttRoot(form.root) };
}

/** Setup AP password: 8-63 characters. The empty string (open) is a separate action. */
export function validateApPassword(pw: string, confirm?: string): string | null {
  if (pw.length < 8) return "At least 8 characters";
  if (pw.length > 63) return "At most 63 characters";
  if (confirm !== undefined && pw !== confirm) return "The two passwords do not match";
  return null;
}
