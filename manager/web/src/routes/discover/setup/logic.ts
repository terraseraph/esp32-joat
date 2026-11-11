import type { DeviceSummary, Job, SetupAp } from "@shared/api";
import type { SetupChooseResult, SetupJobResult } from "../../../api/setup";

/** What the flow was opened for. `deviceId` set = recover mode (the device must report that id). */
export interface SetupTarget {
  ssid: string;
  /** undefined = not known (recover mode): the password field is then optional. */
  secured?: boolean;
  deviceId?: string;
  /** Name for the title, when known. */
  name?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when this page is not served from the machine that runs the Manager (it would lose the server during the job). */
export function isRemoteBrowser(lan: boolean, hostname: string): boolean {
  if (!lan) return false;
  const h = hostname.toLowerCase();
  return !(LOOPBACK.has(h) || h.endsWith(".localhost"));
}

/** `esp32-<last 6 of the id>`: the Setup AP a device raises. */
export function setupApSsid(deviceId: string): string {
  return `esp32-${deviceId.slice(-6).toLowerCase()}`;
}

/** 0-100 signal to four bars. */
export function signalBars(signal: number | null): 0 | 1 | 2 | 3 | 4 {
  if (signal === null) return 0;
  if (signal >= 75) return 4;
  if (signal >= 50) return 3;
  if (signal >= 25) return 2;
  return signal > 0 ? 1 : 0;
}

/** Strongest first, then by name. */
export function sortNetworks<T extends { ssid: string; rssi: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid));
}

/** The device's Wi-Fi list from `job.result`, when the job waits in the `choose` step. */
export function chooseResult(job: Job): SetupChooseResult | null {
  const step = job.steps.find((s) => s.id === "choose");
  if (!step || step.status !== "running" || job.state !== "running") return null;
  const r = job.result as Partial<SetupChooseResult> | undefined;
  if (!r || !Array.isArray(r.networks)) return null;
  const networks = r.networks.filter((n) => typeof n?.ssid === "string" && n.ssid !== "");
  return { networks, device: r.device ?? { id: "", name: "", fw: "", app_version: "" } };
}

/** `job.result` of a succeeded setup job. */
export function doneResult(job: Job): SetupJobResult | null {
  if (job.state !== "succeeded") return null;
  const r = job.result as Partial<SetupJobResult> | undefined;
  return r && typeof r.deviceId === "string" ? { deviceId: r.deviceId, host: r.host ?? "", name: r.name ?? "", added: r.added === true } : null;
}

/** Plain next-step sentence for a failed setup job. */
export function failureHint(code: string | undefined): string | null {
  switch (code) {
    case "restore_failed":
      return "This PC may still be on the device's Wi-Fi. Use Restore network to reconnect it.";
    case "wifi_auth":
      return "Check the Wi-Fi password and try again.";
    case "ap_password_wrong":
      return "Check the setup Wi-Fi password printed on the device or in its documentation.";
    case "ap_not_found":
      return "Move closer to the device, make sure it is powered on, and try again.";
    case "device_not_on_lan":
      return "The device may still have joined. Run a scan on Discover in a minute.";
    default:
      return null;
  }
}

/**
 * Split the visible setup Wi-Fi networks into boards that need setting up (new, or in the fleet but not answering) and
 * boards that are already set up: in the fleet and online, with their setup Wi-Fi merely still on. The setup Wi-Fi name
 * is esp32-<last 6 hex of the device id>, which is how the server links it (`knownDeviceId`). The live device list wins
 * over the server's `knownDeviceOnline`, so a board added or coming online moves without another Wi-Fi scan.
 */
export function splitSetupAps(
  aps: SetupAp[],
  devices: Pick<DeviceSummary, "id" | "name" | "host" | "health">[],
): { needSetup: SetupAp[]; alreadySetUp: { ap: SetupAp; device: Pick<DeviceSummary, "id" | "name" | "host" | "health"> | null }[] } {
  const needSetup: SetupAp[] = [];
  const alreadySetUp: { ap: SetupAp; device: Pick<DeviceSummary, "id" | "name" | "host" | "health"> | null }[] = [];
  for (const ap of aps) {
    const suffix = ap.idSuffix.toLowerCase();
    const device = devices.find((d) => (ap.knownDeviceId ? d.id === ap.knownDeviceId : d.id.toLowerCase().endsWith(suffix))) ?? null;
    const online = device ? device.health === "online" : ap.knownDeviceOnline;
    if (online && (device || ap.knownDeviceId)) alreadySetUp.push({ ap: device && !ap.knownDeviceId ? { ...ap, knownDeviceId: device.id } : ap, device });
    else needSetup.push(device && !ap.knownDeviceId ? { ...ap, knownDeviceId: device.id } : ap);
  }
  return { needSetup, alreadySetUp };
}
