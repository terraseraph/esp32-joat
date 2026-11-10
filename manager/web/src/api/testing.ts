import { configVersionStore } from "./commands";
import { resetDevices } from "./devices";
import { resetJobs } from "./jobs";
import { resetLive } from "./live";
import { resetServerStatus } from "./serverStatus";
import { resetWatch } from "./watch";
import { resetBrowserWs } from "./ws";

/** Tests only: reset module-level singletons between tests. */
export function resetApiForTests(): void {
  resetServerStatus();
  resetWatch();
  resetLive();
  resetDevices();
  resetJobs();
  configVersionStore.set({});
  resetBrowserWs();
}
