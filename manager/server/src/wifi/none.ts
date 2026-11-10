import { WifiError, type WifiAdapter } from "./adapter";

export const NO_ADAPTER_REASON = "This PC has no Wi-Fi adapter the Manager can control";
export const WINDOWS_ONLY_REASON = "SoftAP setup is supported on Windows only for now";

/** Setup is unavailable: every operation fails with `unsupported`, `info()` says why in plain words. */
export function createNoneAdapter(reason: string = NO_ADAPTER_REASON): WifiAdapter {
  const unsupported = (): WifiError => new WifiError("unsupported", reason);
  return {
    kind: "none",
    info: () => Promise.resolve({ supported: false, reason, interfaceName: null }),
    current: () => Promise.resolve({ ssid: null, profile: null }),
    scan: () => Promise.resolve([]),
    addTempProfile: () => Promise.reject(unsupported()),
    connect: () => Promise.reject(unsupported()),
    deleteProfile: () => Promise.resolve(),
    localAddress: () => Promise.resolve(null),
    endpoint: () => Promise.reject(unsupported()),
    lanTargets: () => [],
  };
}
