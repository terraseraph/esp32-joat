import { createFakeWifiAdapter, type FakeApSpec, type FakeWifiOptions } from "./fake";
import { createNetshAdapter, type NetshAdapterOptions } from "./netsh";
import { createNoneAdapter, WINDOWS_ONLY_REASON } from "./none";
import type { WifiAdapter, WifiAdapterKind } from "./adapter";

export * from "./adapter";
export { createFakeWifiAdapter, parseFakeAp, type FakeApSpec, type FakeWifiAdapter, type FakeWifiFaults, type FakeWifiOptions } from "./fake";
export { buildProfileXml, createNetshAdapter, createNetshExec, parseInterfaces, parseNetworks, type ExecFn, type NetshAdapterOptions, type RawExecFn } from "./netsh";
export { createNoneAdapter, NO_ADAPTER_REASON, WINDOWS_ONLY_REASON } from "./none";

export interface CreateWifiAdapterOptions {
  fakeAps?: FakeApSpec[];
  fake?: Omit<FakeWifiOptions, "aps">;
  netsh?: NetshAdapterOptions;
  platform?: NodeJS.Platform;
}

/** `system` = netsh on Windows, "unavailable" elsewhere; `fake` = the simulator; `none` = setup off. */
export function createWifiAdapter(kind: WifiAdapterKind, opts: CreateWifiAdapterOptions = {}): WifiAdapter {
  if (kind === "fake") return createFakeWifiAdapter({ ...(opts.fake ?? {}), aps: opts.fakeAps ?? [] });
  if (kind === "none") return createNoneAdapter("SoftAP setup is turned off on this Manager (started with --wifi-adapter none)");
  if ((opts.platform ?? process.platform) !== "win32") return createNoneAdapter(WINDOWS_ONLY_REASON);
  return createNetshAdapter(opts.netsh);
}
