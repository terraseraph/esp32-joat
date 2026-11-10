import { ApiError } from "../../api/client";

/** Plain-language message for a failed `POST /api/devices` (unknown codes show the server's message verbatim). */
export function addDeviceErrorMessage(err: ApiError, host: string): string {
  switch (err.code) {
    case "probe_timeout":
      return `No answer from ${host} within 2 seconds. Check the address, and that the board is powered and on this network.`;
    case "device_unreachable":
      return `${host} could not be reached. Check the address and port, and that this PC is on the same network as the board.`;
    case "captive_redirect":
      return "That address redirects to 192.168.4.1: a device in setup mode or another captive portal.";
    case "not_de_esp32":
      return `${host} answered, but it isn't a de-esp32 device.`;
    default:
      // invalid_host (the server names the exact problem) and everything else
      return err.message;
  }
}

export interface ScanIssues {
  subnets: string[];
  targets: string[];
  other: string[];
}

/** Sort the server's `400 invalid_body` details (`[{ path: "/subnets/0", message }]`) by the field they belong to. */
export function scanIssues(err: ApiError): ScanIssues {
  const out: ScanIssues = { subnets: [], targets: [], other: [] };
  const details: unknown[] = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    if (typeof d !== "object" || d === null) continue;
    const { path, message } = d as { path?: unknown; message?: unknown };
    if (typeof message !== "string") continue;
    const p = typeof path === "string" ? path : "";
    if (p.startsWith("/subnets")) out.subnets.push(message);
    else if (p.startsWith("/targets")) out.targets.push(message);
    else out.other.push(message);
  }
  if (!out.subnets.length && !out.targets.length && !out.other.length) out.other.push(err.message);
  return out;
}
