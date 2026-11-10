/**
 * IPv4 helpers and the device's static-IP rules (spec 2.9 `parse_ip4` / `validate_static`), so the edit sheet can show field
 * errors instantly. The server's `/check` stays authoritative; it adds the warnings (outside this PC's networks, address in use).
 */

export type IpField = "ip" | "netmask" | "gateway" | "dns";
export type IpFieldErrors = Partial<Record<IpField, string>>;

export interface StaticValues {
  ip: string;
  netmask: string;
  gateway: string;
  /** Optional: empty means "use the gateway". */
  dns: string;
}

/** Strict dotted quad (four decimal numbers 0-255, no leading zeros, no spaces) to an unsigned 32-bit number; null when invalid. */
export function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function formatIpv4(n: number): string {
  return [n / 16777216, n / 65536, n / 256, n].map((x) => Math.floor(x) % 256).join(".");
}

/** Prefix length of a contiguous netmask (1-32), or null when the mask has gaps or is 0.0.0.0. */
export function netmaskPrefix(mask: number): number | null {
  let ones = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    const set = Math.floor(mask / 2 ** bit) % 2 === 1;
    if (set) {
      if (seenZero) return null;
      ones++;
    } else seenZero = true;
  }
  return ones === 0 ? null : ones;
}

/** Netmask for a prefix length (0-32), as a number. */
export function prefixMask(prefix: number): number {
  return 2 ** 32 - 2 ** (32 - Math.min(32, Math.max(0, prefix)));
}

/** "255.255.255.0" to 24, null when it is not a netmask. */
export function netmaskToPrefix(text: string): number | null {
  const n = parseIpv4(text);
  return n === null ? null : netmaskPrefix(n);
}

/** Unicast host address: not 0.x.x.x, loopback, multicast/reserved (224+) or broadcast. */
export function isUnicast(n: number): boolean {
  const first = Math.floor(n / 16777216);
  return first >= 1 && first <= 223 && first !== 127;
}

const AND = (a: number, b: number) => (a & b) >>> 0;

/** The Setup AP network of the device (192.168.4.0/24); a static address must not overlap it. */
const AP_NET = parseIpv4("192.168.4.0") ?? 0;
const AP_END = AP_NET + 255;

/**
 * The device's rules for a static config. Empty fields give a "needed" message only when `required` is true
 * (so a half-typed form does not shout). Returns only the fields that have a problem.
 */
export function validateStatic(v: StaticValues, opts: { required?: boolean } = {}): IpFieldErrors {
  const errors: IpFieldErrors = {};
  const need = opts.required ?? false;
  const ip = v.ip.trim();
  const mask = v.netmask.trim();
  const gw = v.gateway.trim();
  const dns = v.dns.trim();

  const ipN = ip ? parseIpv4(ip) : null;
  const maskN = mask ? parseIpv4(mask) : null;
  const gwN = gw ? parseIpv4(gw) : null;

  if (!ip) {
    if (need) errors.ip = "Enter the address, for example 192.168.1.50.";
  } else if (ipN === null) errors.ip = "Use four numbers from 0 to 255 separated by dots, like 192.168.1.50 (no leading zeros).";
  else if (!isUnicast(ipN)) errors.ip = "This is not an address a device can use (it is empty, loopback, multicast or broadcast).";

  let prefix: number | null = null;
  if (!mask) {
    if (need) errors.netmask = "Enter the netmask, for example 255.255.255.0.";
  } else if (maskN === null) errors.netmask = "Use four numbers from 0 to 255 separated by dots, like 255.255.255.0.";
  else {
    prefix = netmaskPrefix(maskN);
    if (prefix === null || prefix > 30) errors.netmask = "Not a usable netmask. It must be a block of 1s then 0s, from 255.128.0.0 (/1) to 255.255.255.252 (/30).";
  }

  if (!gw) {
    if (need) errors.gateway = "Enter the gateway, usually your router, for example 192.168.1.1.";
  } else if (gwN === null) errors.gateway = "Use four numbers from 0 to 255 separated by dots, like 192.168.1.1 (no leading zeros).";
  else if (!isUnicast(gwN)) errors.gateway = "This is not an address a router can have (it is empty, loopback, multicast or broadcast).";

  if (dns) {
    const dnsN = parseIpv4(dns);
    if (dnsN === null) errors.dns = "Use four numbers from 0 to 255 separated by dots, like 192.168.1.1, or leave it empty to use the gateway.";
    else if (!isUnicast(dnsN)) errors.dns = "This is not an address a DNS server can have.";
  }

  // Relations between the fields only make sense when the pieces on their own are fine.
  if (ipN !== null && maskN !== null && prefix !== null && prefix <= 30 && !errors.ip && !errors.netmask) {
    const net = AND(ipN, maskN);
    const bcast = net + (2 ** (32 - prefix) - 1);
    if (ipN === net) errors.ip = "This is the network address of the subnet, not a device address. Pick another one.";
    else if (ipN === bcast) errors.ip = "This is the broadcast address of the subnet, not a device address. Pick another one.";
    else if (net <= AP_END && bcast >= AP_NET) errors.ip = "This subnet overlaps the device's own Setup AP network (192.168.4.x). Use a different range.";

    if (gwN !== null && !errors.gateway) {
      if (AND(gwN, maskN) !== net) errors.gateway = "The gateway must be in the same subnet as the address.";
      else if (gwN === net) errors.gateway = "This is the network address of the subnet, not a gateway. Pick another one.";
      else if (gwN === bcast) errors.gateway = "This is the broadcast address of the subnet, not a gateway. Pick another one.";
      else if (gwN === ipN && !errors.ip) errors.gateway = "The gateway must be a different address from the device's own.";
    }
  }
  return errors;
}

/** True when all required fields are filled and none has a problem. */
export function isValidStatic(v: StaticValues): boolean {
  return Object.keys(validateStatic(v, { required: true })).length === 0;
}

/** "255.255.255.0" as "/24" for display, or null. */
export function prefixLabel(netmask: string): string | null {
  const p = netmaskToPrefix(netmask);
  return p === null ? null : `/${p}`;
}
