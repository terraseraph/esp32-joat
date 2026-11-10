import dns from "node:dns";
import net from "node:net";

/**
 * Host input handling. Users type IPs, `ip:port`, `name.local` or plain hostnames; the registry stores
 * `ip` or `ip:port` (port only when it is not 80; IPv6 as `[addr]:port`).
 */

export class HostAddrError extends Error {
  readonly code = "invalid_host";
  constructor(message: string) {
    super(message);
    this.name = "HostAddrError";
  }
}

export interface HostAddr {
  /** IPv4/IPv6 literal or a hostname (lower case, no brackets, no trailing dot). */
  host: string;
  port: number;
  isIp: boolean;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parsePort(text: string, input: string): number {
  if (!/^\d{1,5}$/.test(text)) throw new HostAddrError(`"${input}": the port must be a number between 1 and 65535`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new HostAddrError(`"${input}": the port must be a number between 1 and 65535`);
  return port;
}

/**
 * Parse what a user typed. Accepts an optional leading `http://` and one trailing `/`; rejects other schemes,
 * paths, queries, credentials and empty input. Port defaults to 80.
 */
export function parseHostInput(input: string): HostAddr {
  let s = String(input ?? "").trim();
  if (!s) throw new HostAddrError("Enter the device's IP address or name, for example 192.168.1.42 or esp32-b3c4d5.local");
  if (/^http:\/\//i.test(s)) s = s.slice(7);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new HostAddrError(`"${input.trim()}": only plain http addresses are supported (no https://, ws:// ...)`);
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (!s) throw new HostAddrError("Enter the device's IP address or name, for example 192.168.1.42 or esp32-b3c4d5.local");
  if (/[\s/?#@\\]/.test(s)) throw new HostAddrError(`"${input.trim()}": enter just the address (host or host:port), without a path, query or credentials`);

  let host: string;
  let port = 80;
  if (s.startsWith("[")) {
    const m = /^\[([0-9a-fA-F:.]+)\](?::(.*))?$/.exec(s);
    if (!m || !net.isIPv6(m[1] as string)) throw new HostAddrError(`"${input.trim()}" is not a valid IPv6 address`);
    host = (m[1] as string).toLowerCase();
    if (m[2] !== undefined) port = parsePort(m[2], input.trim());
  } else {
    const colons = s.split(":").length - 1;
    if (colons > 1) {
      if (!net.isIPv6(s)) throw new HostAddrError(`"${input.trim()}" is not a valid address (write IPv6 with a port as [addr]:port)`);
      host = s.toLowerCase();
    } else if (colons === 1) {
      const [h, p] = s.split(":") as [string, string];
      host = h;
      port = parsePort(p, input.trim());
    } else {
      host = s;
    }
    if (!host) throw new HostAddrError(`"${input.trim()}": the host part is empty`);
    host = host.toLowerCase();
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (/^[\d.]+$/.test(host) && !net.isIPv4(host)) throw new HostAddrError(`"${input.trim()}" is not a valid IPv4 address`);
    if (!net.isIP(host) && (host.length > 253 || !HOSTNAME_RE.test(host))) throw new HostAddrError(`"${input.trim()}" is not a valid host name or IP address`);
  }
  return { host, port, isIp: net.isIP(host) !== 0 };
}

/** The registry form: `ip` (port 80) or `ip:port`; IPv6 as `[addr]` / `[addr]:port` only when a port is needed. */
export function formatHostAddr(addr: HostAddr): string {
  const v6 = net.isIPv6(addr.host);
  if (addr.port === 80) return addr.host;
  return v6 ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/** Inverse of `formatHostAddr` for values read from the registry (never throws on well-formed values). */
export function splitStoredHost(stored: string): { hostname: string; port: number } {
  const a = parseHostInput(stored);
  return { hostname: a.host, port: a.port };
}

export type Lookup4 = (hostname: string) => Promise<string>;

export const lookupIpv4: Lookup4 = async (hostname) => (await dns.promises.lookup(hostname, { family: 4 })).address;

/** IP literals pass through; names are resolved to IPv4 ("IP preferred over .local"). Throws the underlying DNS error. */
export async function resolveHostAddr(addr: HostAddr, lookup: Lookup4 = lookupIpv4): Promise<HostAddr> {
  if (addr.isIp) return addr;
  return { host: await lookup(addr.host), port: addr.port, isIp: true };
}
