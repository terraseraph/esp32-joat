import http from "node:http";
import os from "node:os";
import { formatHostAddr, HostAddrError, parseHostInput, resolveHostAddr, type HostAddr } from "../device/hostAddr";
import type { DeviceStatus } from "../types/device-api";

/**
 * The /24 sweep (spec 3.3 step 2), ported from `tools/discover.py` (`local_ipv4s`, `subnet_hosts`, `find_devices`),
 * plus the lightweight, NON-queued status probe used by every discovery path.
 *
 * Probes deliberately bypass the per-device queue (`device/client.ts`): a sweep hits up to 254 addresses that are
 * not registered devices, and creating queue entries for them would be wrong. A probe of an address that IS a
 * registered device is therefore a second, parallel `GET /status` next to the health poller's; it is one small
 * request with `Connection: close`, which the firmware's httpd serves in turn, so it is tolerated.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 800;
export const DEFAULT_SWEEP_CONCURRENCY = 48;
const MAX_PROBE_BYTES = 64 * 1024;

export interface IfaceAddr {
  address: string;
  netmask: string;
}

export class SubnetError extends Error {
  readonly code = "invalid_subnet";
  constructor(message: string) {
    super(message);
    this.name = "SubnetError";
  }
}

// ---- addresses ---------------------------------------------------------------------------------------------

function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Prefix length of a contiguous dotted netmask, or null. */
function prefixOf(netmask: string): number | null {
  const n = ipToInt(netmask);
  if (n === null) return null;
  let bits = 0;
  let i = 31;
  while (i >= 0 && ((n >>> i) & 1) === 1) {
    bits++;
    i--;
  }
  // everything after the first 0 bit must be 0
  return (n << bits) >>> 0 === 0 || bits === 32 ? bits : null;
}

const isLinkLocal = (ip: string): boolean => ip.startsWith("169.254.");
const isLoopback = (ip: string): boolean => ip.startsWith("127.");

/** Shape of `os.networkInterfaces()` (also accepted by tests). */
export type OsInterfaces = NodeJS.Dict<{ address: string; netmask: string; family: string | number; internal: boolean }[]>;

/** IPv4 interfaces worth sweeping: skips internal/loopback and 169.254/16 (link-local). */
export function interfacesFromOs(raw: OsInterfaces): IfaceAddr[] {
  const out: IfaceAddr[] = [];
  for (const list of Object.values(raw)) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" && ni.family !== 4) continue;
      if (ni.internal || isLoopback(ni.address) || isLinkLocal(ni.address)) continue;
      out.push({ address: ni.address, netmask: ni.netmask });
    }
  }
  return out;
}

/** The machine's sweepable IPv4 interfaces (default for `StartOptions.discovery.interfaces`). */
export function localInterfaces(): IfaceAddr[] {
  return interfacesFromOs(os.networkInterfaces() as unknown as OsInterfaces);
}

// ---- sweep plan --------------------------------------------------------------------------------------------

export interface Range {
  /** Network address as an integer. */
  network: number;
  prefix: number;
}

const cidrOf = (r: Range): string => `${intToIp(r.network)}/${r.prefix}`;

/**
 * The range to sweep for an address and prefix: anything wider than /24 is clamped to the /24 containing the
 * address; /24 to /30 are used as they are. Returns null for /31 and /32 (nothing to sweep).
 */
function rangeFor(address: string, prefix: number): Range | null {
  const ip = ipToInt(address);
  if (ip === null || prefix > 30) return null;
  const p = Math.max(prefix, 24);
  const mask = (0xffffffff << (32 - p)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix: p };
}

/**
 * Parse an explicit subnet: `a.b.c.d/N` with N from 8 to 30. Wider than /24 is clamped to the /24 containing the
 * given address (`10.1.2.3/16` sweeps `10.1.2.0/24`). Throws `SubnetError` for anything else (no prefix, bad
 * address, loopback/link-local/multicast ranges).
 */
export function parseSubnet(input: string): Range {
  const s = String(input ?? "").trim();
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (!m) throw new SubnetError(`"${s}" is not a CIDR range like 192.168.1.0/24`);
  const addr = m[1] as string;
  const prefix = Number(m[2]);
  const ip = ipToInt(addr);
  if (ip === null) throw new SubnetError(`"${s}": ${addr} is not a valid IPv4 address`);
  if (prefix < 8 || prefix > 30) throw new SubnetError(`"${s}": the prefix length must be between 8 and 30`);
  if (isLoopback(addr) || isLinkLocal(addr) || (ip >>> 24) >= 224 || ip >>> 24 === 0) {
    throw new SubnetError(`"${s}": loopback, link-local, multicast and reserved ranges cannot be swept`);
  }
  const r = rangeFor(addr, prefix);
  if (!r) throw new SubnetError(`"${s}" is too small to sweep`);
  return r;
}

export interface SweepPlan {
  /** Ranges as CIDR strings (deduplicated), e.g. `192.168.1.0/24`. */
  subnets: string[];
  /** Host addresses to probe, deduplicated, own addresses removed. */
  hosts: string[];
}

/**
 * Host list for a sweep: for every interface its /24 (or the smaller real subnet), `.1-.254` style (network and
 * broadcast address excluded), plus every explicit range, minus this machine's own addresses.
 */
export function buildSweepPlan(interfaces: IfaceAddr[], extraSubnets: string[] = []): SweepPlan {
  const ranges = new Map<string, Range>();
  const own = new Set<string>();
  for (const i of interfaces) {
    own.add(i.address);
    const prefix = prefixOf(i.netmask);
    if (prefix === null) continue;
    const r = rangeFor(i.address, prefix);
    if (r) ranges.set(cidrOf(r), r);
  }
  for (const s of extraSubnets) {
    const r = parseSubnet(s);
    ranges.set(cidrOf(r), r);
  }
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const r of ranges.values()) {
    const size = 2 ** (32 - r.prefix);
    for (let off = 1; off < size - 1; off++) {
      const ip = intToIp(r.network + off);
      if (own.has(ip) || seen.has(ip)) continue;
      seen.add(ip);
      hosts.push(ip);
    }
  }
  return { subnets: [...ranges.keys()], hosts };
}

// ---- targets -----------------------------------------------------------------------------------------------

export class TargetError extends Error {
  readonly code = "invalid_target";
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

/** Parse a `host[:port]` target (same grammar as the add-device form). Throws `TargetError`. */
export function parseTarget(input: string): HostAddr {
  try {
    return parseHostInput(input);
  } catch (err) {
    if (err instanceof HostAddrError) throw new TargetError(err.message);
    throw err;
  }
}

/** Canonical stored form of a target (`ip`, `ip:port`, or `name[:port]`). */
export function canonicalTarget(input: string): string {
  return formatHostAddr(parseTarget(input));
}

/** IP literals pass through, names are resolved to IPv4. Returns null when resolution fails. */
export async function resolveTarget(addr: HostAddr): Promise<HostAddr | null> {
  try {
    return await resolveHostAddr(addr);
  } catch {
    return null;
  }
}

// ---- probe -------------------------------------------------------------------------------------------------

const agent = new http.Agent({ keepAlive: false });

/**
 * `GET /api/v1/status` without queue, redirects, keep-alive or retries. Resolves with the parsed JSON object of a
 * 2xx answer, or null for anything else (refused, timeout, redirect, not JSON, aborted). Never rejects.
 */
export function probeStatus(host: string, port: number, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DeviceStatus | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve(null);
    let settled = false;
    let req: http.ClientRequest | null = null;
    const finish = (value: DeviceStatus | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      req?.destroy();
      resolve(value);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      req = http.request(
        {
          host,
          port,
          method: "GET",
          path: "/api/v1/status",
          agent,
          headers: { Accept: "application/json", Connection: "close" },
        },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            res.resume();
            return finish(null);
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_PROBE_BYTES) return finish(null);
            chunks.push(c);
          });
          res.on("error", () => finish(null));
          res.on("aborted", () => finish(null));
          res.on("end", () => {
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              finish(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as DeviceStatus) : null);
            } catch {
              finish(null);
            }
          });
        },
      );
      req.on("error", () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

// ---- pool --------------------------------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `concurrency` in flight. Stops starting new items when `signal` aborts or
 * `fn` returns `true` (the pool then aborts nothing itself; callers pass `signal` to the probes). Never rejects
 * because of `fn`.
 */
export async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<boolean | void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let stop = false;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!stop && !signal?.aborted) {
      const i = next++;
      if (i >= items.length) return;
      try {
        if ((await fn(items[i] as T)) === true) stop = true;
      } catch {
        /* a failing probe never stops the pool */
      }
    }
  });
  await Promise.all(workers);
}
