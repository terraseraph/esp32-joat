/**
 * Client-side check of the address a user types into "Add by IP". Mirrors the server's `parseHostInput`
 * (server/src/device/hostAddr.ts) so most mistakes are caught before a request is sent; the server stays the
 * authority (it also resolves names and probes the device).
 */

export type HostCheck = { ok: true; host: string } | { ok: false; message: string };

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export const EMPTY_HOST_MESSAGE = "Enter the device's IP address or name, for example 192.168.1.42 or esp32-b3c4d5.local";

export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => IPV4_OCTET.test(p));
}

function isIPv6(s: string): boolean {
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

function portError(input: string): string {
  return `"${input}": the port must be a number between 1 and 65535`;
}

function validPort(text: string): boolean {
  if (!/^\d{1,5}$/.test(text)) return false;
  const n = Number(text);
  return n >= 1 && n <= 65535;
}

/** Validate what the user typed. `host` in the result is the trimmed input (what is sent to the server). */
export function validateHost(raw: string): HostCheck {
  const input = raw.trim();
  const fail = (message: string): HostCheck => ({ ok: false, message });
  if (!input) return fail(EMPTY_HOST_MESSAGE);

  let s = input;
  if (/^http:\/\//i.test(s)) s = s.slice(7);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return fail(`"${input}": only plain http addresses are supported (no https://, ws:// ...)`);
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (!s) return fail(EMPTY_HOST_MESSAGE);
  if (/[\s/?#@\\]/.test(s)) return fail(`"${input}": enter just the address (host or host:port), without a path, query or credentials`);

  if (s.startsWith("[")) {
    const m = /^\[([0-9a-fA-F:.]+)\](?::(.*))?$/.exec(s);
    if (!m || !isIPv6(m[1] as string)) return fail(`"${input}" is not a valid IPv6 address`);
    if (m[2] !== undefined && !validPort(m[2])) return fail(portError(input));
    return { ok: true, host: input };
  }

  const colons = s.split(":").length - 1;
  let host = s;
  if (colons > 1) {
    if (!isIPv6(s)) return fail(`"${input}" is not a valid address (write IPv6 with a port as [addr]:port)`);
    return { ok: true, host: input };
  }
  if (colons === 1) {
    const [h, p] = s.split(":") as [string, string];
    host = h;
    if (!validPort(p)) return fail(portError(input));
  }
  if (!host) return fail(`"${input}": the host part is empty`);
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (/^[\d.]+$/.test(host) && !isIPv4(host)) return fail(`"${input}" is not a valid IPv4 address`);
  if (!isIPv4(host) && (host.length > 253 || !HOSTNAME_RE.test(host))) return fail(`"${input}" is not a valid host name or IP address`);
  return { ok: true, host: input };
}

/** Split a comma / space / newline separated list into its non-empty entries. */
export function splitList(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}
