import { SETUP_SSID_RE, WifiError, sleepAbortable, type WifiAdapter, type WifiConnection, type WifiNetwork } from "./adapter";

/**
 * Simulated Wi-Fi for development (`--wifi-adapter fake --fake-ap ...`) and tests. It never touches this PC's network:
 * "joining" an access point only changes what `endpoint()` returns, so the setup job talks to a fake device on loopback.
 */

export interface FakeApSpec {
  /** `esp32-<last 6 hex of the device id>`. */
  ssid: string;
  /** Needs a password to join (default: `password !== undefined`). */
  secured?: boolean;
  password?: string;
  /** Where "192.168.4.1" really is while this PC is on this AP, `host:port` (a fake device, e.g. `127.0.0.1:8211`). */
  host: string;
  /** Where the device shows up on the user's network after setup (`host:port`); without it the device never appears. */
  lanHost?: string;
  /** 0-100 (default 70). */
  signal?: number;
}

export interface FakeWifiFaults {
  /** `info()` says setup is unavailable, with this reason. */
  unsupported?: string;
  /** Joining an access point fails (the network is visible but the connection does not come up). */
  connectFails?: boolean;
  /** Access points are not visible any more: not in `scan()`, `connect` says `not_found`. */
  apDisappears?: boolean;
  /** Connecting back to a network that is not an access point fails. */
  rejoinFails?: boolean;
  /** `addTempProfile` fails. */
  addProfileFails?: boolean;
  /** `scan()` fails. */
  scanFails?: boolean;
}

export interface FakeWifiOptions {
  aps?: FakeApSpec[];
  /** The network this PC is "on" at the start (default "HomeNet"; null = not connected). */
  currentSsid?: string | null;
  /** Other networks that are visible (default: the current one). */
  otherNetworks?: WifiNetwork[];
  /** Time a `connect` takes (default 0). */
  connectDelayMs?: number;
  /** What `localAddress()` answers (default null). */
  localAddress?: string | null;
  interfaceName?: string;
  faults?: FakeWifiFaults;
}

export type FakeWifiCall =
  | { op: "scan" }
  | { op: "addTempProfile"; ssid: string; name: string; secured: boolean }
  | { op: "connect"; profile: string; ssid: string }
  | { op: "deleteProfile"; name: string };

export interface FakeWifiAdapter extends WifiAdapter {
  readonly kind: "fake";
  /** Every scan / profile / connect call in order. Passwords are never recorded. */
  readonly calls: FakeWifiCall[];
  /** Names of the profiles that exist right now (the original one included). */
  profileNames(): string[];
  /** The simulated connection right now. */
  readonly connection: WifiConnection;
  /** Change at any time. */
  readonly faults: FakeWifiFaults;
  readonly aps: FakeApSpec[];
}

const DEFAULT_SSID = "HomeNet";

export function createFakeWifiAdapter(opts: FakeWifiOptions = {}): FakeWifiAdapter {
  const aps = (opts.aps ?? []).map((a) => ({ ...a }));
  const faults: FakeWifiFaults = { ...(opts.faults ?? {}) };
  const originalSsid = opts.currentSsid === undefined ? DEFAULT_SSID : opts.currentSsid;
  const profiles = new Map<string, { ssid: string; password: string | undefined }>();
  const connection: WifiConnection = { ssid: null, profile: null };
  if (originalSsid !== null) {
    profiles.set(originalSsid, { ssid: originalSsid, password: "fake-home-password" });
    connection.ssid = originalSsid;
    connection.profile = originalSsid;
  }
  const others: WifiNetwork[] = opts.otherNetworks ?? (originalSsid !== null ? [{ ssid: originalSsid, secured: true, signal: 80 }] : []);
  const calls: FakeWifiCall[] = [];
  const apOf = (ssid: string | null): FakeApSpec | undefined => (ssid === null ? undefined : aps.find((a) => a.ssid.toLowerCase() === ssid.toLowerCase()));
  const securedOf = (a: FakeApSpec): boolean => a.secured ?? a.password !== undefined;

  return {
    kind: "fake",
    calls,
    aps,
    faults,
    connection,
    profileNames: () => [...profiles.keys()],
    info: () =>
      Promise.resolve(
        faults.unsupported !== undefined
          ? { supported: false, reason: faults.unsupported, interfaceName: null }
          : { supported: true, reason: null, interfaceName: opts.interfaceName ?? "Simulated Wi-Fi" },
      ),
    current: () => Promise.resolve({ ...connection }),
    async scan() {
      calls.push({ op: "scan" });
      if (faults.scanFails) throw new WifiError("failed", "The simulated Wi-Fi scan failed");
      const visible: WifiNetwork[] = faults.apDisappears ? [] : aps.map((a) => ({ ssid: a.ssid, secured: securedOf(a), signal: a.signal ?? 70 }));
      return [...visible, ...others];
    },
    async addTempProfile(ssid, password, profileName) {
      if (faults.addProfileFails) throw new WifiError("failed", "The simulated Wi-Fi refused to save the temporary network");
      calls.push({ op: "addTempProfile", ssid, name: profileName, secured: password !== undefined && password !== "" });
      profiles.set(profileName, { ssid, password: password === "" ? undefined : password });
      return profileName;
    },
    async connect(profile, ssid, o = {}) {
      calls.push({ op: "connect", profile, ssid });
      if (opts.connectDelayMs) await sleepAbortable(opts.connectDelayMs, o.signal);
      if (o.signal?.aborted) throw new WifiError("aborted", "Cancelled");
      const p = profiles.get(profile);
      if (!p) throw new WifiError("failed", `There is no saved network profile called "${profile}"`);
      const ap = apOf(p.ssid);
      if (ap) {
        if (faults.apDisappears) throw new WifiError("not_found", `"${ap.ssid}" is not visible`);
        if (faults.connectFails) throw new WifiError("timeout", `Could not connect to "${ap.ssid}"`);
        if (securedOf(ap) && p.password !== ap.password) throw new WifiError("auth", `"${ap.ssid}" did not accept the password`);
      } else if (faults.rejoinFails) {
        throw new WifiError("timeout", `Could not connect to "${p.ssid}"`);
      }
      connection.ssid = p.ssid;
      connection.profile = profile;
    },
    async deleteProfile(name) {
      calls.push({ op: "deleteProfile", name });
      profiles.delete(name);
      if (connection.profile === name) {
        connection.ssid = null;
        connection.profile = null;
      }
    },
    localAddress: () => Promise.resolve(opts.localAddress ?? null),
    endpoint(_apAddress) {
      const ap = apOf(connection.ssid);
      // Not on an access point: point at a closed local port so nothing real is ever contacted.
      if (!ap) return Promise.resolve({ host: "127.0.0.1:1" });
      return Promise.resolve({ host: ap.host });
    },
    lanTargets(apSsid) {
      const ap = apOf(apSsid);
      return ap?.lanHost ? [ap.lanHost] : [];
    },
  };
}

const HOST_PORT_RE = /^[^\s,=]+:\d{1,5}$/;

/**
 * Parse one `--fake-ap` value: `<ssid>=<host:port>[,secured=<password>][,lan=<host:port>]`.
 * Throws an Error in plain words.
 */
export function parseFakeAp(value: string): FakeApSpec {
  const parts = value.split(",");
  const head = parts[0] ?? "";
  const eq = head.indexOf("=");
  if (eq <= 0) throw new Error(`Invalid --fake-ap "${value}": use <ssid>=<host:port>[,secured=<password>][,lan=<host:port>]`);
  const ssid = head.slice(0, eq);
  const host = head.slice(eq + 1);
  if (!SETUP_SSID_RE.test(ssid)) throw new Error(`Invalid --fake-ap "${value}": the name must look like esp32-<6 hex characters>`);
  if (!HOST_PORT_RE.test(host)) throw new Error(`Invalid --fake-ap "${value}": "${host}" is not host:port`);
  const spec: FakeApSpec = { ssid, host };
  for (const part of parts.slice(1)) {
    const i = part.indexOf("=");
    const key = i < 0 ? part : part.slice(0, i);
    const val = i < 0 ? "" : part.slice(i + 1);
    if (key === "secured") {
      if (val.length < 8 || val.length > 63) throw new Error(`Invalid --fake-ap "${ssid}": secured=<password> needs 8 to 63 characters`);
      spec.password = val;
      spec.secured = true;
    } else if (key === "lan") {
      if (!HOST_PORT_RE.test(val)) throw new Error(`Invalid --fake-ap "${ssid}": lan=${val} is not host:port`);
      spec.lanHost = val;
    } else {
      throw new Error(`Invalid --fake-ap "${ssid}": unknown option "${key}" (use secured=<password> or lan=<host:port>)`);
    }
  }
  return spec;
}
