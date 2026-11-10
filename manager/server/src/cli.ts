import path from "node:path";
import { parseArgs } from "node:util";
import type { WifiAdapterKind } from "./setup";
import { parseFakeAp, type FakeApSpec } from "./wifi";
import { formatHostAddr, HostAddrError, parseHostInput } from "./device/hostAddr";
import { parseIp4 } from "./ipchange/validate";
import { defaultDataDir } from "./store/dataDir";

export const WIFI_ADAPTER_KINDS: readonly WifiAdapterKind[] = ["fake", "system", "none"];

export interface CliOptions {
  port: number;
  host: string;
  lan: boolean;
  dataDir: string;
  open: boolean;
  allowOrigins: string[];
  /** false with --no-network-scan: no mDNS, no subnet sweeps anywhere. */
  networkScan: boolean;
  wifiAdapter: WifiAdapterKind;
  /** Simulated setup access points (`--fake-ap`, only with `--wifi-adapter fake`). */
  fakeAps: FakeApSpec[];
  /** Dev only (--ip-change-map): `new ip -> host[:port]` lookups for the IP change job. */
  ipChangeMap: Record<string, string>;
  help: boolean;
}

export const HELP = `de-esp32-manager [options]

  --port <n>            Port to listen on (default 5180; 0 = any free port)
  --host <addr>         Address to bind (default 127.0.0.1). A non-loopback address other than 0.0.0.0 implies --lan
                        and fixes the bind: LAN access then cannot be switched from Settings
  --lan                 LAN mode: bind 0.0.0.0 (unless --host is given) and require an access token. Always on at start
                        with this flag; without it LAN access starts as last saved from Settings (default off)
  --data-dir <path>     Where registry/settings/backups live (default: per-OS app data dir)
  --no-open             Do not open the browser
  --allow-origin <url>  Extra Origin accepted for POST/PUT/PATCH/DELETE and WebSocket (repeatable)
  --no-network-scan     Never browse mDNS or sweep subnets (UI scans, background scan, setup). Typed addresses,
                        settings targets and known devices are still probed
  --wifi-adapter <kind> How SoftAP setup reaches a board's Wi-Fi: system (this PC's adapter, default),
                        fake (simulated, for development) or none (setup disabled)
  --fake-ap <spec>      With --wifi-adapter fake, repeatable: a simulated device in setup mode,
                        <ssid>=<host:port>[,secured=<password>][,lan=<host:port>]
                        (host:port is where 192.168.4.1 really is, lan= where the device shows up afterwards)
  --ip-change-map <ip>=<host:port>
                        Dev only, repeatable: where the IP change job looks for a device after it moved to <ip>
                        (fake devices cannot move; map to a closed port to see the revert path)
  --help                Show this help
`;

/** Parse argv (without node + script). Throws a readable Error on bad input. */
export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      lan: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "no-open": { type: "boolean", default: false },
      "allow-origin": { type: "string", multiple: true },
      "no-network-scan": { type: "boolean", default: false },
      "wifi-adapter": { type: "string" },
      "fake-ap": { type: "string", multiple: true },
      "ip-change-map": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  let port = 5180;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${values.port}`);
  }
  const wifiAdapter = (values["wifi-adapter"] ?? "system") as WifiAdapterKind;
  if (!WIFI_ADAPTER_KINDS.includes(wifiAdapter)) throw new Error(`Invalid --wifi-adapter: ${values["wifi-adapter"]} (use fake, system or none)`);
  const fakeAps = (values["fake-ap"] ?? []).map((v) => parseFakeAp(v));
  if (fakeAps.length > 0 && wifiAdapter !== "fake") throw new Error("--fake-ap needs --wifi-adapter fake");
  const lan = values.lan === true;
  const host = values.host ?? (lan ? "0.0.0.0" : "127.0.0.1");
  return {
    port,
    host,
    lan: lan || !isLoopbackBind(host),
    dataDir: path.resolve(values["data-dir"] ?? defaultDataDir(process.platform, env)),
    open: values["no-open"] !== true,
    allowOrigins: values["allow-origin"] ?? [],
    networkScan: values["no-network-scan"] !== true,
    wifiAdapter,
    fakeAps,
    ipChangeMap: parseIpChangeMap(values["ip-change-map"] ?? []),
    help: values.help === true,
  };
}

/** A non-loopback --host implies LAN mode (the token is required whenever the server is reachable from the network). */
function isLoopbackBind(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

/** `--ip-change-map 192.168.1.50=127.0.0.1:8221` (repeatable) to `{ "192.168.1.50": "127.0.0.1:8221" }`. */
export function parseIpChangeMap(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const i = e.indexOf("=");
    const ip = i < 0 ? "" : e.slice(0, i);
    if (parseIp4(ip) === null) throw new Error(`Invalid --ip-change-map ${e} (use <ip>=<host:port>, for example 192.168.1.50=127.0.0.1:8221)`);
    try {
      out[ip] = formatHostAddr(parseHostInput(e.slice(i + 1)));
    } catch (err) {
      if (err instanceof HostAddrError) throw new Error(`Invalid --ip-change-map ${e}: ${err.message}`, { cause: err });
      throw err;
    }
  }
  return out;
}
