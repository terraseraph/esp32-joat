import type { Route } from "../http/router";
import { backupRoutes } from "./backups";
import { deviceRoutes } from "./devices";
import { discoveryRoutes } from "./discovery";
import { firmwareRoutes } from "./firmware";
import { ipRoutes } from "./ip";
import { jobRoutes } from "./jobs";
import { proxyRoutes } from "./proxy";
import { serverRoutes } from "./server";
import { settingsRoutes } from "./settings";
import { setupRoutes } from "./setup";
import { wifiMoveRoutes } from "./wifimove";

/** THE route table: the router and the OpenAPI document are both built from this. */
export const routes: Route[] = [
  ...serverRoutes,
  ...settingsRoutes,
  ...deviceRoutes,
  ...discoveryRoutes,
  ...jobRoutes,
  ...setupRoutes,
  ...ipRoutes,
  ...firmwareRoutes,
  ...backupRoutes,
  ...wifiMoveRoutes,
  ...proxyRoutes,
];
