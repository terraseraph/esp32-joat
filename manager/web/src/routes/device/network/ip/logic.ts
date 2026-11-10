import type { IpChange } from "@shared/device-api";
import type { Job } from "@shared/api";
import { ipChangeOf } from "../../../../api/ip";
import type { IpJobResult, IpSettings } from "@shared/api";
import { prefixLabel } from "../../../../lib/ipv4";

export type Tone = "ok" | "warn" | "bad" | "off" | "acc";

/** "DHCP" / "Static" / null (nothing to say when the mode is unknown). */
export function modeLabel(mode: IpSettings["ipMode"] | string | undefined): string | null {
  return mode === "dhcp" ? "DHCP" : mode === "static" ? "Static" : null;
}

/** Netmask with its prefix, e.g. "255.255.255.0 (/24)". */
export function netmaskText(netmask: string): string {
  const p = prefixLabel(netmask);
  return p ? `${netmask} (${p})` : netmask;
}

function describe(c: IpChange): string {
  if (c.mode === "static") return c.ip ? `the fixed address ${c.ip}` : "a fixed address";
  if (c.mode === "dhcp") return "an address from your router (DHCP)";
  return "the new setting";
}

const NOT_CONFIRMED = "The device went back to its previous setting by itself.";

/**
 * The device's own `ip_change` in words, for the card. `pending` = applied and waiting for the confirm (seconds left shown);
 * null when there is nothing worth saying (never changed, or the device does not report it).
 */
export function ipChangeWords(c: IpChange | null | undefined): { tone: Tone; text: string; pending: boolean } | null {
  if (!c || c.result === "none") return null;
  // A finished result with no detail at all is the idle value of a device that never changed anything in this boot.
  if (c.result !== "pending" && c.result !== "reset" && c.reason === undefined && c.mode === undefined && !c.seq && !c.time && !c.uptime_s) return null;
  switch (c.result) {
    case "pending": {
      const left = typeof c.confirm_left_s === "number" ? ` ${Math.max(0, Math.round(c.confirm_left_s))} s left to confirm.` : "";
      return {
        tone: "acc",
        pending: true,
        text: `${c.applied ? "The device is using" : "The device is about to use"} ${describe(c)}, but it is not confirmed yet.${left} Without a confirmation it goes back to its previous setting.`,
      };
    }
    case "ok":
      return { tone: "ok", pending: false, text: c.reason === "dhcp_lease" ? "The last change worked: the device got an address from your router." : `The last change worked: the device now uses ${describe(c)}.` };
    case "reverted":
      return {
        tone: "warn",
        pending: false,
        text:
          c.reason === "no_dhcp_lease"
            ? "The last change did not work: the router gave the device no address. It went back to its previous setting."
            : c.reason === "wifi_change"
              ? "The last change was cancelled because the Wi-Fi network was changed."
              : `The last change was not confirmed in time. ${NOT_CONFIRMED}`,
      };
    case "reset":
      return { tone: "warn", pending: false, text: "The fixed address was dropped because the Wi-Fi network changed. The device uses DHCP on the new network." };
    case "failed":
      return {
        tone: "bad",
        pending: false,
        text: c.reason === "save_failed" ? "The last change could not be saved on the device. A restart returns it to its previous setting." : "The last change failed. The device kept its previous setting.",
      };
    default:
      return null;
  }
}

/** Why the card cannot edit, in a sentence (nothing when it can). */
export function cannotChangeReason(s: IpSettings, down: boolean): string | null {
  if (!s.supported) return null;
  if (down) return "The device isn't answering right now.";
  if (s.activeJobId) return "An address change is already running.";
  if (ipChangeOf(s)?.result === "pending") return "The previous change is still waiting for confirmation.";
  return null;
}

/** The finished job in plain words (the card shows this under the steps). */
export function ipJobOutcome(job: Job, result: IpJobResult | null): { tone: "ok" | "warn" | "bad" | "info"; title: string; body: string } | null {
  if (job.state === "queued" || job.state === "running" || job.state === "paused" || job.state === "cancelling") return null;
  const code = job.error?.code;
  const where = result?.host ? ` at ${result.host}` : "";
  if (job.state === "succeeded" && (!result || result.outcome === "ok")) {
    return result?.ipMode === "dhcp"
      ? { tone: "ok", title: "The device is back on DHCP.", body: `The Manager found it${where} and kept the change.` }
      : { tone: "ok", title: "The new address is in use.", body: `The Manager reached the device${where} and confirmed the change, so it stays.` };
  }
  if (code === "not_reachable") {
    return {
      tone: "bad",
      title: "The Manager could not find the device.",
      body: job.error?.message ?? "It did not answer at the new address or at its old one. It may be on another network. Run a scan to look for it; if it does not show up, connect to its own setup Wi-Fi to recover it. Nothing was changed in the Manager.",
    };
  }
  if (code === "not_reachable_new_address" || code === "reverted" || result?.outcome === "reverted") {
    return {
      tone: "warn",
      title: "The device went back to its previous setting.",
      body:
        code === "reverted" && job.error?.message
          ? job.error.message
          : "The Manager could not reach it at the new address, so the change was not confirmed. The device returns to its previous setting by itself. Nothing was lost; check the address and your network, and try again.",
    };
  }
  if (code === "no_dhcp_lease" || result?.outcome === "no_dhcp_lease") {
    return { tone: "warn", title: "The router did not give the device an address.", body: "The device went back to its previous setting. Check that your router hands out addresses (DHCP) and try again." };
  }
  if (code === "cancelled" || job.state === "cancelled") {
    return {
      tone: "info",
      title: "Cancelled.",
      body:
        (job.message && job.message.length > 20 ? job.message : null) ??
        "If the device had already switched, it was not confirmed, so it returns to its previous setting by itself within about 90 seconds.",
    };
  }
  if (code === "lost_device" || result?.outcome === "unknown") {
    return {
      tone: "warn",
      title: "The Manager lost track of the device.",
      body: "It may be at the new address or back at the old one. The Manager keeps the old address until a scan finds the device again; try Discover with a scan.",
    };
  }
  return { tone: "bad", title: job.error?.message ?? "The change did not work.", body: "The device kept its previous setting." };
}
