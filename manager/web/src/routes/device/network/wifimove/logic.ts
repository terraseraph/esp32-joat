import type { AccessPoint } from "@shared/device-api";
import type { Job, WifiMoveJobResult } from "@shared/api";
import { formatRssi } from "../../../../lib/format";

export type OutcomeTone = "ok" | "warn" | "bad" | "info";

/** Same rules as the device and the server: name 1-32 bytes, password empty or 8-63 characters. */
export function validateWifiForm(ssid: string, password: string): { ssid?: string; password?: string } {
  const out: { ssid?: string; password?: string } = {};
  const bytes = new TextEncoder().encode(ssid).length;
  if (ssid.length === 0) out.ssid = "Enter the name of the Wi-Fi network.";
  else if (bytes > 32) out.ssid = `A Wi-Fi name can be at most 32 bytes; this one is ${bytes}.`;
  if (password !== "" && (password.length < 8 || password.length > 63)) out.password = "A Wi-Fi password has 8 to 63 characters. Leave it empty for an open network.";
  return out;
}

export interface NetworkChoice {
  ssid: string;
  rssi: number;
  secured: boolean;
  label: string;
  bars: number;
}

/** The device's scan, cleaned up: hidden names dropped, one row per name (strongest signal), strongest first. */
export function networkChoices(aps: readonly AccessPoint[]): NetworkChoice[] {
  const best = new Map<string, AccessPoint>();
  for (const ap of aps) {
    if (!ap.ssid) continue;
    const prev = best.get(ap.ssid);
    if (!prev || ap.rssi > prev.rssi) best.set(ap.ssid, ap);
  }
  return [...best.values()]
    .sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid))
    .map((ap) => {
      const s = formatRssi(ap.rssi);
      return { ssid: ap.ssid, rssi: ap.rssi, secured: ap.auth !== 0, label: s.label, bars: s.bars };
    });
}

/** Why the control is unavailable, in a sentence (nothing when it can start). */
export function cannotMoveReason(down: boolean, activeJob: boolean): string | null {
  if (down) return "The device isn't answering right now.";
  if (activeJob) return "Finish or dismiss the move shown above first.";
  return null;
}

/** The finished job in plain words: the three endings (moved, went back, not found) and the less common ones. */
export function wifiMoveOutcome(job: Job, result: WifiMoveJobResult | null): { tone: OutcomeTone; title: string; body: string } | null {
  if (job.state === "queued" || job.state === "running" || job.state === "paused" || job.state === "cancelling") return null;
  const net = result?.ssid ? `"${result.ssid}"` : "the new network";
  if (job.state === "succeeded" && (!result || result.outcome === "ok")) {
    const at = result?.newHost ? ` at ${result.newHost}` : "";
    const moved = result?.addressChanged ? ` Its address changed, and the Manager now uses${at}.` : ` Its address did not change${at}.`;
    const dhcp = result?.staticIpReset ? " The fixed address was dropped: on the new network the device uses an address from the router (DHCP)." : "";
    return { tone: "ok", title: `The device is on ${net} now.`, body: `The Manager found it again by its ID.${moved}${dhcp}` };
  }
  if (job.state === "cancelled" || result?.outcome === "unknown") {
    return {
      tone: "info",
      title: "Stopped waiting.",
      body: "The device may already have moved to the new network. If it does not show up on this page, scan again from a PC that can reach that network, or recover it over its setup Wi-Fi.",
    };
  }
  const code = job.error?.code;
  if (code === "not_found" || result?.outcome === "not_found") {
    return {
      tone: "bad",
      title: "The Manager did not see the device again.",
      body: `It may be on ${net} but out of this PC's reach. Connect this PC to that network and scan from Discover. If the device could not join, it opens its own setup Wi-Fi after about a minute without a network: use "Recover over its setup Wi-Fi".`,
    };
  }
  if (result?.outcome === "failed" || code) {
    const back = result?.restoredPrevious === false ? "" : " The device went back to its previous network, so nothing changed.";
    const text = job.error?.message ?? "The device could not join the new network.";
    return { tone: result?.restoredPrevious === false ? "bad" : "warn", title: "The device could not join the new network.", body: result?.restoredPrevious === false || text.includes("previous network") ? text : `${text}${back}` };
  }
  return { tone: "bad", title: job.error?.message ?? "The move did not work.", body: "Check the device before trying again." };
}
