import type { DiscoveryService } from "./discovery";
import type { DevicePool } from "./device/client";
import type { HealthService } from "./device/health";
import type { LinkService } from "./device/link";
import type { Summaries } from "./device/summary";
import type { BackupsFeature } from "./backups";
import type { FirmwareFeature } from "./firmware";
import type { IpChangeFeature } from "./ipchange";
import type { JobService } from "./jobs";
import type { SetupFeature, WifiAdapterKind } from "./setup";
import type { WifiMoveFeature } from "./wifimove";
import type { AccessController } from "./http/access";
import type { Route } from "./http/router";
import type { RegistryStore } from "./store/registry";
import type { SettingsService } from "./store/settings";
import type { BrowserHub } from "./ws/browserHub";

/**
 * What route handlers can reach (`ctx.app`). Later milestones add services here
 * (discovery, firmware ...) and `start()` wires them up.
 */
export interface AppContext {
  version: string;
  /** LAN mode is on right now (live: can change at runtime through `access`). */
  readonly lan: boolean;
  /** Address the server is bound to right now (live). */
  readonly host: string;
  dataDir: string;
  startedAt: number;
  /** Access token (LAN mode only; live, changes when it is regenerated). */
  readonly token: string | null;
  /** Runtime LAN access: switch, rotate the token, who may see it (http/access.ts). */
  access: AccessController;
  /** The ONE route table (router + OpenAPI). */
  routes: readonly Route[];
  hub: BrowserHub;
  settings: SettingsService;
  registry: RegistryStore;
  /** One HTTP client + queue per device. */
  pool: DevicePool;
  health: HealthService;
  summaries: Summaries;
  /** Device WebSocket links + live fan-out to watching browsers (M5). */
  links: LinkService;
  /** Scans, results, adopt/ignore, `waitForDevice` (M3). */
  discovery: DiscoveryService;
  /** Jobs: the one place long operations run (batch 3). See API.md "Jobs". */
  jobs: JobService;
  /** SoftAP setup feature (batch 3, setup track). */
  setup: SetupFeature;
  /** IP address change feature (batch 3, IP track). */
  ipChange: IpChangeFeature;
  /** Firmware / OTA feature (batch 3, firmware track). */
  firmware: FirmwareFeature;
  /** Backups feature (batch 3, backups track). */
  backups: BackupsFeature;
  /** Move a device to another Wi-Fi network (L1, batch 4). */
  wifiMove: WifiMoveFeature;
  /** Which Wi-Fi adapter the setup feature uses (--wifi-adapter). */
  wifiAdapterKind: WifiAdapterKind;
  /** Timeout of the probe in `POST /api/devices` (2 s; test override via `StartOptions.pollTimeoutMs`). */
  probeTimeoutMs: number;
  /** Actual listening port (differs from the option when 0 was requested). */
  getPort(): number;
  log(msg: string): void;
}
