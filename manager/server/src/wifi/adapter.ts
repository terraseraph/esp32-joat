/**
 * The seam between SoftAP setup and this PC's Wi-Fi. `setup/` only talks to this interface; the implementations are
 * `fake.ts` (simulated, for development and tests), `netsh.ts` (Windows) and `none.ts` (setup unavailable).
 */

export type WifiAdapterKind = "fake" | "system" | "none";

export interface WifiNetwork {
  ssid: string;
  /** false = open network. */
  secured: boolean;
  /** 0-100, null when unknown. */
  signal: number | null;
}

export interface WifiConnection {
  /** The network the adapter is connected to right now, null when it is not connected. */
  ssid: string | null;
  /** Name of the saved profile that connection uses (what `connect` needs to come back), null when unknown. */
  profile: string | null;
}

export interface WifiAdapterInfo {
  supported: boolean;
  /** Plain words, null when supported. */
  reason: string | null;
  interfaceName: string | null;
}

export type WifiErrorKind =
  /** Setup is not available on this PC (no adapter, wrong OS). */
  | "unsupported"
  /** The network is not visible. */
  | "not_found"
  /** The network refused the password. */
  | "auth"
  /** The connection did not come up in time. */
  | "timeout"
  /** The operation was aborted by the caller. */
  | "aborted"
  /** Anything else (a command failed). */
  | "failed";

export class WifiError extends Error {
  constructor(
    readonly kind: WifiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WifiError";
  }
}

export interface WifiConnectOptions {
  /** How long to wait for the connection to come up (default 20 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WifiEndpoint {
  /** `host` or `host:port` to hand to the device client. */
  host: string;
  /** Bind the connection to this local address (the Wi-Fi adapter), when known. */
  localAddress?: string;
}

export interface WifiAdapter {
  readonly kind: WifiAdapterKind;
  /** Whether setup can work on this PC. Cheap enough to call before every job. */
  info(): Promise<WifiAdapterInfo>;
  /** The current connection (ssid and profile), `{ ssid: null, profile: null }` when not connected. */
  current(): Promise<WifiConnection>;
  /** Networks visible right now. */
  scan(): Promise<WifiNetwork[]>;
  /**
   * Create a temporary profile called `profileName` for `ssid` (open when `password` is empty) and return the name. The caller
   * picks the name so a crash marker can list it BEFORE the profile exists.
   */
  addTempProfile(ssid: string, password: string | undefined, profileName: string): Promise<string>;
  /** Connect to a saved profile and wait until the connection is up. Throws `WifiError`. */
  connect(profile: string, ssid: string, opts?: WifiConnectOptions): Promise<void>;
  /** Delete a saved profile. A profile that does not exist is not an error. */
  deleteProfile(name: string): Promise<void>;
  /** This PC's IPv4 address on the Wi-Fi interface, null when it has none. */
  localAddress(): Promise<string | null>;
  /** Where the device's setup address (192.168.4.1) really is, reached through this adapter. */
  endpoint(apAddress: string): Promise<WifiEndpoint>;
  /** Extra addresses where the device may show up on the user's network after setup (the simulator knows them). */
  lanTargets(apSsid: string): string[];
  close?(): Promise<void>;
}

/** Prefix of every profile the Manager creates, so leftovers are recognisable. */
export const TEMP_PROFILE_PREFIX = "de-esp32-setup-";

/** Only SSIDs of this shape are devices in setup mode. */
export const SETUP_SSID_RE = /^esp32-[0-9a-f]{6}$/i;

export const sleepAbortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WifiError("aborted", "Cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new WifiError("aborted", "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
