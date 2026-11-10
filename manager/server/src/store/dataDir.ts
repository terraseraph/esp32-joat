import os from "node:os";
import path from "node:path";

const APP_DIR = "de-esp32-manager";

/** Per-OS default data dir (spec 3.1). Inputs are injectable for tests. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_DIR);
}
