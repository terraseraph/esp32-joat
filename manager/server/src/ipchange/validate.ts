import type { IfaceAddr } from "../discovery/sweep";
import type { IpChangeBody, IpFieldError, IpWarning } from "../types/api-ip";

/**
 * Static IP rules, mirroring the firmware's `parse_ip4` / `validate_static` (network_manager_README.md, "Static IP"):
 * strict dotted quads without leading zeros, a contiguous netmask /1../30, ip and gateway distinct unicast hosts in the same
 * subnet (not the network or broadcast address), no overlap with the SoftAP network 192.168.4.0/24, dns unicast (default: gateway).
 * Messages are plain words for a person.
 */

/** Strict dotted quad to an unsigned 32-bit number, or `null`. */
export function parseIp4(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i] as string;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

export function formatIp4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Prefix length of a contiguous netmask in /1../30, else `null`. */
function prefixOf(mask: number): number | null {
  for (let p = 1; p <= 30; p++) if (maskOf(p) === mask) return p;
  return null;
}

/** Unicast host address: not 0.x.x.x, not loopback, not multicast/reserved. */
function isUnicast(a: number): boolean {
  const first = Math.floor(a / 0x1000000);
  return first !== 0 && first !== 127 && first < 224;
}

const SOFTAP_NET = 0xc0a80400; // 192.168.4.0/24

const FORMAT_HELP = "four numbers from 0 to 255 separated by dots, like 192.168.1.50 (no leading zeros)";
const LABEL = { ip: "The address", netmask: "The netmask", gateway: "The gateway", dns: "The DNS server" } as const;

export interface StaticConfig {
  ip: string;
  netmask: string;
  gateway: string;
  dns: string;
}

export interface Validation {
  errors: IpFieldError[];
  /** Present when there are no errors and the mode is static. */
  config?: StaticConfig;
}

/** Validate a request body. DHCP has nothing to validate. Reports every field that is wrong, not just the first. */
export function validateIpChange(body: IpChangeBody): Validation {
  if (body.mode === "dhcp") return { errors: [] };
  const errors: IpFieldError[] = [];
  const ip = parseIp4(body.ip);
  const mask = parseIp4(body.netmask);
  const gw = parseIp4(body.gateway);
  if (ip === null) errors.push({ field: "ip", message: `${LABEL.ip} must be ${FORMAT_HELP}.` });
  if (mask === null) errors.push({ field: "netmask", message: `${LABEL.netmask} must be ${FORMAT_HELP}.` });
  if (gw === null) errors.push({ field: "gateway", message: `${LABEL.gateway} must be ${FORMAT_HELP}.` });
  const prefix = mask === null ? null : prefixOf(mask);
  if (mask !== null && prefix === null) errors.push({ field: "netmask", message: "The netmask must be a normal one between /1 and /30, like 255.255.255.0." });
  if (ip !== null && !isUnicast(ip)) errors.push({ field: "ip", message: "The address must be a normal device address (not 0.x.x.x, 127.x.x.x or a multicast address)." });
  if (gw !== null && !isUnicast(gw)) errors.push({ field: "gateway", message: "The gateway must be a normal device address (not 0.x.x.x, 127.x.x.x or a multicast address)." });

  if (ip !== null && gw !== null && mask !== null && prefix !== null && isUnicast(ip) && isUnicast(gw)) {
    if (((ip & mask) >>> 0) !== ((gw & mask) >>> 0)) {
      errors.push({ field: "gateway", message: "The gateway must be in the same network as the address (the netmask decides which addresses that is)." });
    } else if (ip === gw) {
      errors.push({ field: "ip", message: "The address and the gateway must be different." });
    }
    const bcast = (~mask) >>> 0;
    const host = (a: number): number => (a & ~mask) >>> 0;
    if (host(ip) === 0 || host(ip) === bcast) errors.push({ field: "ip", message: "The address must not be the network address or the broadcast address of its network." });
    if (host(gw) === 0 || host(gw) === bcast) errors.push({ field: "gateway", message: "The gateway must not be the network address or the broadcast address of its network." });
    const wide = maskOf(Math.min(prefix, 24));
    if (((ip & wide) >>> 0) === ((SOFTAP_NET & wide) >>> 0)) {
      errors.push({ field: "ip", message: "This network overlaps the device's own setup network (192.168.4.0/24). Choose an address outside it." });
    }
  }

  const dnsText = body.dns === undefined || body.dns === "" ? body.gateway : body.dns;
  if (body.dns !== undefined && body.dns !== "") {
    const dns = parseIp4(body.dns);
    if (dns === null) errors.push({ field: "dns", message: `${LABEL.dns} must be ${FORMAT_HELP}.` });
    else if (!isUnicast(dns)) errors.push({ field: "dns", message: "The DNS server must be a normal device address (not 0.x.x.x, 127.x.x.x or a multicast address)." });
  }
  if (errors.length > 0) return { errors };
  return { errors, config: { ip: body.ip, netmask: body.netmask, gateway: body.gateway, dns: dnsText } };
}

/** True when `ip` lies inside the subnet of any of the given interfaces. */
export function insideAnySubnet(ip: string, interfaces: readonly IfaceAddr[]): boolean {
  const a = parseIp4(ip);
  if (a === null) return false;
  return interfaces.some((i) => {
    const addr = parseIp4(i.address);
    const mask = parseIp4(i.netmask);
    return addr !== null && mask !== null && ((a & mask) >>> 0) === ((addr & mask) >>> 0);
  });
}

export interface WarningInput {
  body: IpChangeBody;
  /** The Manager PC's IPv4 interfaces; an empty list means "unknown" and gives no warning. */
  interfaces: readonly IfaceAddr[];
  /** Hosts (`ip` or `ip:port`) of the other registered devices, with their names. */
  others: readonly { name: string; host: string }[];
  /** The device's current settings when they are known. */
  current?: { mode: string; ip: string; netmask: string; gateway: string; dns: string };
}

const hostOnly = (host: string): string => host.replace(/:\d+$/, "");

/** Warnings that never block a change. Call only with a body that passed `validateIpChange`. */
export function ipWarnings(input: WarningInput): IpWarning[] {
  const out: IpWarning[] = [];
  const { body, current } = input;
  if (body.mode === "dhcp") {
    if (current?.mode === "dhcp") out.push({ code: "same_as_current", message: "The device already gets its address automatically." });
    return out;
  }
  if (current?.mode === "static" && current.ip === body.ip && current.netmask === body.netmask && current.gateway === body.gateway && current.dns === (body.dns || body.gateway)) {
    out.push({ code: "same_as_current", message: "These are the settings the device already uses." });
  }
  if (input.interfaces.length > 0 && !insideAnySubnet(body.ip, input.interfaces)) {
    out.push({
      code: "outside_pc_subnets",
      message: "This address is not in any network this computer is on, so the Manager may not be able to reach the device afterwards.",
    });
  }
  const other = input.others.find((o) => hostOnly(o.host) === body.ip);
  if (other) out.push({ code: "address_in_use", message: `${other.name || "Another device"} is already using this address.` });
  return out;
}
