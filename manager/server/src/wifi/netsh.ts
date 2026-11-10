import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNetshExec, execNative, type ExecFn, type RawExecFn } from "./netshExec";
import { NO_ADAPTER_REASON } from "./none";
import { TEMP_PROFILE_PREFIX, WifiError, sleepAbortable, type WifiAdapter, type WifiConnection, type WifiNetwork } from "./adapter";

/**
 * Windows implementation of `WifiAdapter`, built on `netsh wlan`. All commands go through the injected `exec(file, args)`,
 * so tests never run netsh; parsers and the profile XML are pure functions covered by fixtures in `test/fixtures/netsh/`.
 *
 * Commands used: `show interfaces`, `show networks mode=bssid`, `add profile`, `connect`, `delete profile`. Never `disconnect`.
 */

export { buildUtf8Command, createNetshExec, createOemCodePageLookup, execNative, execNativeRaw, type ExecFn, type ExecResult, type RawExecFn, type RawExecResult } from "./netshExec";

// ---- parsing ------------------------------------------------------------------------------------------------------------

export interface NetshInterface {
  name: string;
  /** Raw (localised) value of the State line, "" when absent. */
  state: string;
  /** null when the interface is not connected. */
  ssid: string | null;
  profile: string | null;
  signal: number | null;
  connected: boolean;
}

/** `Key : value` with leading indentation. The key ends at the FIRST colon (values such as MAC addresses contain more). */
function keyValue(line: string): [string, string] | null {
  if (!/^\s+\S/.test(line)) return null;
  const i = line.indexOf(":");
  if (i < 0) return null;
  const key = line.slice(0, i).trim();
  if (key === "") return null;
  return [key, line.slice(i + 1).trim()];
}

const NOT_CONNECTED_STATES =
  /^(disconnected|disconnecting|associating|authenticating|discovering|not ready|ad hoc network formed|getrennt|wird getrennt|nicht verbunden|d[eé]connect[eé]e?|desconectad[oa]|disconnesso|verbinding verbroken|roz[łl][aą]czono|niepo[łl][aą]czony)$/i;
const PROFILE_KEYS = /^(profile|profil|perfil|profilo|profiel)$/i;
const STATE_KEYS = /^(state|status|zustand|[eé]tat|estado|stato|toestand|stan)$/i;
const PERCENT = /^(\d{1,3})\s*%$/;

/**
 * Parse `netsh wlan show interfaces`. Blocks start where the first key (the interface name) repeats. Keys are matched in
 * English and the common translations (the primary path); for a key that is not recognised the structure decides: the State
 * is the line right before `SSID`, the signal is the one value that reads `NN%`, and the Profile is the line after the
 * signal. "Connected" never depends on a label: a connected interface is the one that prints an SSID (and whose state is not
 * a known "not connected" word).
 */
export function parseInterfaces(text: string): NetshInterface[] {
  const out: NetshInterface[] = [];
  let firstKey: string | null = null;
  let cur: { name: string; state: string; ssid: string | null; profile: string | null; signal: number | null } | null = null;
  let prevValue = "";
  let afterSignal = false;
  let profileByKey = false;
  const flush = (): void => {
    if (!cur) return;
    const ssid = cur.ssid !== null && cur.ssid !== "" ? cur.ssid : null;
    out.push({ ...cur, ssid, connected: ssid !== null && !NOT_CONNECTED_STATES.test(cur.state) });
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (firstKey === null) firstKey = key;
    if (key === firstKey) {
      flush();
      cur = { name: value, state: "", ssid: null, profile: null, signal: null };
      prevValue = "";
      afterSignal = false;
      profileByKey = false;
      continue;
    }
    if (!cur) continue;
    const followsSignal = afterSignal;
    afterSignal = false;
    if (/^ssid$/i.test(key)) {
      cur.ssid = value;
      if (cur.state === "") cur.state = prevValue;
    } else if (PROFILE_KEYS.test(key)) {
      cur.profile = value === "" ? null : value;
      profileByKey = true;
    } else if (STATE_KEYS.test(key) && cur.state === "") {
      cur.state = value;
    } else if (cur.signal === null && PERCENT.test(value) && !/bssid/i.test(key)) {
      cur.signal = Math.min(100, Number(PERCENT.exec(value)?.[1]));
      afterSignal = true;
    } else if (followsSignal && !profileByKey && cur.ssid !== null) {
      cur.profile = value === "" ? null : value;
    }
    prevValue = value;
  }
  flush();
  return out;
}

const OPEN_AUTH = /^(open|offen|ouvert[e]?|abiert[ao]|aperta|aperto|openbaar|aberto)$/i;

/** Words in an Authentication / Encryption value that only a protected network prints (language independent). */
const SECURITY_TOKENS = /wpa|wep|rsn|sae|owe|ccmp|tkip|gcmp|aes|psk|eap|802.1x/i;

/**
 * Parse `netsh wlan show networks mode=bssid` (one entry per SSID, strongest BSSID wins). Hidden networks are skipped. A
 * network is secured unless its authentication reads "Open" (or a translation). When the Authentication label is not
 * recognised the values decide: the block starts with Network type, Authentication, Encryption, and a network is open only
 * when neither of the last two names a security protocol (WPA, CCMP ...). The signal is the `NN%` value of a BSSID entry,
 * whatever its label. Works across several interfaces.
 */
export function parseNetworks(text: string): WifiNetwork[] {
  const byName = new Map<string, WifiNetwork>();
  let current: { ssid: string; secured: boolean | null; signal: number | null; inBssid: boolean; headValues: string[] } | null = null;
  const flush = (): void => {
    if (!current || current.ssid === "") {
      current = null;
      return;
    }
    const [, auth, enc] = current.headValues;
    const secured = current.secured ?? (auth === undefined || enc === undefined ? true : !(OPEN_AUTH.test(auth) || !(SECURITY_TOKENS.test(auth) || SECURITY_TOKENS.test(enc))));
    const prev = byName.get(current.ssid);
    if (prev) {
      if (current.signal !== null) prev.signal = Math.max(prev.signal ?? 0, current.signal);
    } else {
      byName.set(current.ssid, { ssid: current.ssid, secured, signal: current.signal });
    }
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const head = /^SSID\s+\d+\s*:\s?(.*)$/.exec(line);
    if (head) {
      flush();
      current = { ssid: (head[1] ?? "").trim(), secured: null, signal: null, inBssid: false, headValues: [] };
      continue;
    }
    if (!current) continue;
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (/^bssid\s+\d+$/i.test(key)) {
      current.inBssid = true;
      continue;
    }
    if (current.inBssid) {
      const m = /^(\d{1,3})\s*%$/.exec(value);
      if (m) current.signal = Math.max(current.signal ?? 0, Math.min(100, Number(m[1])));
      continue;
    }
    if (/^authenti|^authentif|^autentic|^autentif|^verificatie/i.test(key)) current.secured = !OPEN_AUTH.test(value);
    if (current.headValues.length < 3) current.headValues.push(value); // Network type, Authentication, Encryption
  }
  flush();
  return [...byName.values()];
}

// ---- profile XML ----------------------------------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;"));
}

/**
 * WLAN profile for a temporary connection: WPA2-Personal (AES) with `password`, or an open network. `connectionMode` is
 * `manual` so Windows never joins it by itself later.
 */
export function buildProfileXml(ssid: string, password: string | undefined, profileName: string): string {
  const secured = password !== undefined && password !== "";
  if (secured && (password.length < 8 || password.length > 63)) throw new WifiError("auth", "A Wi-Fi password has 8 to 63 characters.");
  // eslint-disable-next-line no-control-regex
  if (secured && /[\x00-\x1f\x7f]/.test(password)) throw new WifiError("auth", "The Wi-Fi password contains characters that cannot be used.");
  const security = secured
    ? `<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>` +
      `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(password)}</keyMaterial></sharedKey>`
    : `<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>`;
  return (
    `<?xml version="1.0"?>\n` +
    `<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">\n` +
    `  <name>${xmlEscape(profileName)}</name>\n` +
    `  <SSIDConfig><SSID><name>${xmlEscape(ssid)}</name></SSID></SSIDConfig>\n` +
    `  <connectionType>ESS</connectionType>\n` +
    `  <connectionMode>manual</connectionMode>\n` +
    `  <MSM><security>${security}</security></MSM>\n` +
    `</WLANProfile>\n`
  );
}

// ---- adapter ----------------------------------------------------------------------------------------------------------

export interface NetshAdapterOptions {
  exec?: ExecFn;
  /** Instead of `exec`: the raw-bytes seam; output is decoded as UTF-8 or the OEM code page (see `oemCodePage`). */
  rawExec?: RawExecFn;
  /** The OEM code page used to decode non-UTF-8 netsh output (default: looked up without netsh, see `createOemCodePageLookup`). */
  oemCodePage?: () => Promise<number | null>;
  /** Directory for the private temp folder that holds a profile file for a moment (default: the OS temp dir). */
  tmpRoot?: string;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** How often `connect` checks whether the connection is up (default 500). */
  pollMs?: number;
  /** Time `connect` waits when the caller gives none (default 20000). */
  connectTimeoutMs?: number;
}

/** Only profiles the Manager created may be added or deleted here. */
function requireTempName(name: string): void {
  if (!name.startsWith(TEMP_PROFILE_PREFIX)) throw new WifiError("failed", `"${name}" is not a temporary Manager Wi-Fi profile, so it was left alone.`);
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();

export function createNetshAdapter(opts: NetshAdapterOptions = {}): WifiAdapter {
  const exec = opts.exec ?? (opts.rawExec ? createNetshExec(opts.rawExec, opts.oemCodePage) : execNative);
  const interfaces = opts.networkInterfaces ?? os.networkInterfaces;
  const pollMs = opts.pollMs ?? 500;
  let selected: string | null = null;

  async function listInterfaces(): Promise<NetshInterface[]> {
    const res = await exec("netsh", ["wlan", "show", "interfaces"]);
    if (res.code !== 0) return [];
    return parseInterfaces(res.stdout);
  }

  /** The Wi-Fi interface to use: the one chosen before if it is still there, else a connected one, else the first. */
  async function pick(): Promise<NetshInterface | null> {
    const all = await listInterfaces();
    const keep = selected !== null ? all.find((i) => i.name === selected) : undefined;
    const chosen = keep ?? all.find((i) => i.connected) ?? all[0] ?? null;
    selected = chosen?.name ?? null;
    return chosen;
  }

  async function need(): Promise<NetshInterface> {
    const i = await pick();
    if (!i) throw new WifiError("unsupported", NO_ADAPTER_REASON);
    return i;
  }

  const adapter: WifiAdapter = {
    kind: "system",

    async info() {
      const i = await pick();
      return i ? { supported: true, reason: null, interfaceName: i.name } : { supported: false, reason: NO_ADAPTER_REASON, interfaceName: null };
    },

    async current() {
      const i = await pick();
      if (!i || !i.connected) return { ssid: null, profile: null } satisfies WifiConnection;
      return { ssid: i.ssid, profile: i.profile };
    },

    async scan() {
      const i = await need();
      const res = await exec("netsh", ["wlan", "show", "networks", "mode=bssid", `interface=${i.name}`]);
      if (res.code !== 0) throw new WifiError("failed", `Listing Wi-Fi networks failed: ${firstLine(res.stdout || res.stderr) || "no answer from Windows"}`);
      return parseNetworks(res.stdout);
    },

    async addTempProfile(ssid, password, profileName) {
      requireTempName(profileName);
      const i = await need();
      const xml = buildProfileXml(ssid, password, profileName);
      // The file holds the password for a moment: private folder, removed right after the command whatever happens.
      const dir = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), "de-esp32-wifi-"));
      const file = path.join(dir, "profile.xml");
      try {
        await fs.writeFile(file, xml, { encoding: "utf8", mode: 0o600 });
        const res = await exec("netsh", ["wlan", "add", "profile", `filename=${file}`, `interface=${i.name}`, "user=current"]);
        if (res.code !== 0) throw new WifiError("failed", `Windows would not save the temporary Wi-Fi network: ${firstLine(res.stdout || res.stderr) || "no answer from Windows"}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      return profileName;
    },

    async connect(profile, ssid, o = {}) {
      const i = await need();
      const res = await exec("netsh", ["wlan", "connect", `name=${profile}`, `ssid=${ssid}`, `interface=${i.name}`]);
      if (res.code !== 0) throw new WifiError("failed", `Windows could not start joining "${ssid}": ${firstLine(res.stdout || res.stderr) || "no answer from Windows"}`);
      const deadline = Date.now() + (o.timeoutMs ?? opts.connectTimeoutMs ?? 20_000);
      for (;;) {
        const now = await adapter.current();
        if (now.ssid === ssid) return;
        if (Date.now() >= deadline) throw new WifiError("timeout", `This PC did not join "${ssid}" in time`);
        await sleepAbortable(pollMs, o.signal);
      }
    },

    async deleteProfile(name) {
      requireTempName(name); // never touch the user's own profiles, whatever a recovery file says
      const i = await pick();
      const res = await exec("netsh", ["wlan", "delete", "profile", `name=${name}`, ...(i ? [`interface=${i.name}`] : [])]);
      // A profile that is already gone is fine; anything else is reported by the caller's verification.
      if (res.code !== 0 && !/not found|cannot find|nicht gefunden|introuvable/i.test(`${res.stdout} ${res.stderr}`)) {
        throw new WifiError("failed", `Windows would not delete the temporary Wi-Fi network "${name}": ${firstLine(res.stdout || res.stderr) || "no answer from Windows"}`);
      }
    },

    async localAddress() {
      const i = await pick();
      if (!i) return null;
      const list = interfaces()[i.name] ?? [];
      const v4 = list.filter((a) => (a.family === "IPv4" || (a.family as unknown) === 4) && !a.internal && !a.address.startsWith("169.254."));
      return v4[0]?.address ?? null;
    },

    async endpoint(apAddress) {
      const local = await adapter.localAddress();
      return { host: apAddress, ...(local ? { localAddress: local } : {}) };
    },

    lanTargets: () => [],
  };
  return adapter;
}
