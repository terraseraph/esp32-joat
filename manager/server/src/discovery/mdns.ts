import makeMdns from "multicast-dns";
import { looksLikeOursTxt, parseTxt } from "node-red-contrib-de-esp32/lib/discover";

/**
 * mDNS browse (spec 3.3 step 1). Sends PTR queries for `_de-esp32._tcp.local` and `_http._tcp.local`, collects
 * PTR / SRV / TXT / A records from the answers and additionals of every response during the browse window, and
 * links them: PTR names an instance, SRV gives its port and target host name, A gives the target's IPv4 address,
 * TXT carries `id`, `name`, `fw`, `board`, `api`.
 *
 * The socket is injectable (`MdnsFactory`) so tests feed crafted packets and never touch the network.
 * Nothing here throws: socket errors (port 5353 in use, firewall, no multicast interface) end the browse with
 * what was collected so far plus a warning.
 */

/** The subset of the `multicast-dns` instance the browse uses. */
export interface MdnsLike {
  on(event: "response", fn: (packet: MdnsPacket) => void): unknown;
  on(event: "error" | "warning", fn: (err: Error) => void): unknown;
  query(packet: { questions: { name: string; type: string }[] }, cb?: (err: Error | null) => void): unknown;
  destroy(cb?: () => void): unknown;
}
export type MdnsFactory = () => MdnsLike;

export interface MdnsRecord {
  name?: string;
  type?: string;
  data?: unknown;
}
export interface MdnsPacket {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
}

export interface MdnsCandidate {
  ip: string;
  port: number;
  /** TXT record of the instance (parsed), when one was seen. */
  txt?: Record<string, string>;
  /** Instance name, e.g. `esp32-b3c4d5._de-esp32._tcp.local`. */
  instance?: string;
  /** PTR says `_de-esp32._tcp`, or the TXT looks like ours (`looksLikeOursTxt`). */
  ours: boolean;
}

export interface MdnsBrowseResult {
  candidates: MdnsCandidate[];
  warnings: string[];
}

export interface MdnsBrowseOptions {
  /** Browse window (default 2500 ms). */
  windowMs?: number;
  /** Ends the browse early (cancel). */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export const DEFAULT_MDNS_WINDOW_MS = 2500;
export const DE_SERVICE = "_de-esp32._tcp";
const HTTP_SERVICE = "_http._tcp";

export const realMdnsFactory: MdnsFactory = () => makeMdns() as unknown as MdnsLike;

const lc = (s: unknown): string => String(s ?? "").toLowerCase().replace(/\.$/, "");

interface SrvData {
  port?: number;
  target?: string;
}

/** Collects records and turns them into candidates. Exported for tests that feed packets directly. */
export class MdnsCollector {
  /** instance (lower case) -> display name */
  private readonly instances = new Map<string, string>();
  private readonly ptrOurs = new Set<string>();
  private readonly srv = new Map<string, SrvData>();
  private readonly txt = new Map<string, Record<string, string>>();
  /** host name (lower case) -> IPv4 addresses */
  private readonly a = new Map<string, Set<string>>();

  add(packet: MdnsPacket): void {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    for (const r of records) {
      if (!r || typeof r.type !== "string") continue;
      const name = lc(r.name);
      switch (r.type) {
        case "PTR": {
          if (!name.includes(DE_SERVICE) && !name.includes(HTTP_SERVICE)) break;
          const inst = typeof r.data === "string" ? r.data : "";
          if (!inst) break;
          const key = lc(inst);
          this.instances.set(key, inst);
          if (name.includes(DE_SERVICE) || key.includes(`.${DE_SERVICE}`)) this.ptrOurs.add(key);
          break;
        }
        case "SRV": {
          const d = r.data as SrvData | undefined;
          if (!d || typeof d !== "object") break;
          this.instances.set(name, this.instances.get(name) ?? String(r.name));
          this.srv.set(name, { port: typeof d.port === "number" ? d.port : undefined, target: typeof d.target === "string" ? lc(d.target) : undefined });
          if (name.includes(`.${DE_SERVICE}`)) this.ptrOurs.add(name);
          break;
        }
        case "TXT": {
          let parsed: Record<string, string>;
          try {
            parsed = parseTxt(r.data);
          } catch {
            break;
          }
          this.instances.set(name, this.instances.get(name) ?? String(r.name));
          this.txt.set(name, { ...(this.txt.get(name) ?? {}), ...parsed });
          break;
        }
        case "A": {
          if (typeof r.data !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(r.data)) break;
          const set = this.a.get(name) ?? new Set<string>();
          set.add(r.data);
          this.a.set(name, set);
          break;
        }
        default:
          break;
      }
    }
  }

  candidates(): MdnsCandidate[] {
    const out: MdnsCandidate[] = [];
    const claimedHosts = new Set<string>();
    for (const [key, display] of this.instances) {
      const srv = this.srv.get(key);
      const txt = this.txt.get(key);
      if (!srv?.target) continue; // no way to find an address for this instance
      const ips = this.a.get(srv.target);
      if (!ips || ips.size === 0) continue;
      claimedHosts.add(srv.target);
      const ours = this.ptrOurs.has(key) || (txt !== undefined && looksLikeOursTxt(txt));
      for (const ip of ips) {
        out.push({ ip, port: srv.port && srv.port > 0 ? srv.port : 80, ...(txt ? { txt } : {}), instance: display, ours });
      }
    }
    // A records nobody described (an instance whose SRV was not heard): port 80, like the Node-RED scan does.
    for (const [host, ips] of this.a) {
      if (claimedHosts.has(host)) continue;
      for (const ip of ips) out.push({ ip, port: 80, ours: host.startsWith("esp32-") });
    }
    // ours first, then stable by address
    return out.sort((x, y) => Number(y.ours) - Number(x.ours) || x.ip.localeCompare(y.ip) || x.port - y.port);
  }
}

/** Browse for `opts.windowMs`; always resolves. */
export function browseMdns(factory: MdnsFactory, opts: MdnsBrowseOptions = {}): Promise<MdnsBrowseResult> {
  const windowMs = opts.windowMs ?? DEFAULT_MDNS_WINDOW_MS;
  const warnings: string[] = [];
  const collector = new MdnsCollector();
  return new Promise((resolve) => {
    let mdns: MdnsLike | null = null;
    let done = false;
    let window: NodeJS.Timeout | null = null;
    let resend: NodeJS.Timeout | null = null;

    const finish = (): void => {
      if (done) return;
      done = true;
      if (window) clearTimeout(window);
      if (resend) clearTimeout(resend);
      opts.signal?.removeEventListener("abort", finish);
      try {
        mdns?.destroy();
      } catch {
        /* already closed */
      }
      resolve({ candidates: collector.candidates(), warnings });
    };
    const fail = (what: string, err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const hint =
        code === "EADDRINUSE" || code === "EACCES"
          ? " Another program holds UDP port 5353 or a firewall blocks it; the sweep and the other addresses still work."
          : "";
      warnings.push(`mDNS ${what}: ${msg}.${hint}`.replace("..", "."));
      opts.log?.(`mdns ${what}: ${msg}`);
      finish();
    };

    if (opts.signal?.aborted) return finish();
    opts.signal?.addEventListener("abort", finish, { once: true });

    try {
      mdns = factory();
    } catch (err) {
      return fail("could not start", err);
    }
    try {
      mdns.on("response", (packet) => {
        if (!done) collector.add(packet);
      });
      mdns.on("error", (err) => fail("socket error", err));
      mdns.on("warning", (err) => opts.log?.(`mdns warning: ${err.message}`));
    } catch (err) {
      return fail("could not start", err);
    }

    const query = (): void => {
      if (done || !mdns) return;
      try {
        mdns.query(
          {
            questions: [
              { name: `${DE_SERVICE}.local`, type: "PTR" },
              { name: `${HTTP_SERVICE}.local`, type: "PTR" },
            ],
          },
          (err) => {
            if (err && !done) fail("query failed", err);
          },
        );
      } catch (err) {
        fail("query failed", err);
      }
    };
    query();
    // One repeat in case the first packet was lost (UDP, Wi-Fi power save).
    resend = setTimeout(query, Math.max(50, Math.floor(windowMs / 3)));
    window = setTimeout(finish, windowMs);
  });
}
