/**
 * Run N fake de-esp32 devices on consecutive ports:
 *   npm run fake -- --count 3 --base-port 8101 [--host 127.0.0.1] [--seed demo|empty] [--telemetry-ms 15000]
 */
import { parseArgs } from "node:util";
import { startFakeDevice, type FakeDevice } from "./fakeDevice";

const HELP = `Usage: npm run fake -- [options]

Starts fake de-esp32 devices (HTTP + WebSocket on /api/v1) for developing the Manager.

  --count <n>          number of devices (default 1)
  --base-port <port>   port of the first device; the others use consecutive ports (default 8101)
  --host <addr>        address to listen on (default 127.0.0.1)
  --seed <demo|empty>  demo = configured pins, a BME280, a rule, MQTT (default); empty = blank device
  --telemetry-ms <ms>  WebSocket telemetry interval (default 15000)
  --reboot-ms <ms>     offline time after a reboot (default 3000)
  --scan-delay-ms <ms> blocking delay of the Wi-Fi scan (default 1500)
  --pending-firmware   emulate the unmerged firmware branch claude/wifi-change-fallback-ab5ac7: wifi_change,
                       static IP (network.ip.set / network.ip.confirm) and the extra network status fields
  --wifi-move <s>=<a>  (repeatable, with --pending-firmware) a successful Wi-Fi change to SSID <s> moves the device to address
                       <a> (host:port or a port), as if it joined a network on another subnet; the old address stops answering
  --ap-mode            start as an unprovisioned board in SoftAP setup mode (net_state ap_only, no Wi-Fi saved);
                       a successful network.wifi.set moves it to sta_connected (use with the Manager's --fake-ap)
  --help               this text

Ctrl+C stops all devices.
`;

function intArg(name: string, v: string | undefined, def: number, min: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      count: { type: "string" },
      "base-port": { type: "string" },
      host: { type: "string" },
      seed: { type: "string" },
      "telemetry-ms": { type: "string" },
      "reboot-ms": { type: "string" },
      "scan-delay-ms": { type: "string" },
      "pending-firmware": { type: "boolean" },
      "ap-mode": { type: "boolean" },
      "wifi-move": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const count = intArg("count", values.count, 1, 1);
  const basePort = intArg("base-port", values["base-port"], 8101, 1);
  const telemetryIntervalMs = intArg("telemetry-ms", values["telemetry-ms"], 15000, 0);
  const rebootMs = intArg("reboot-ms", values["reboot-ms"], 3000, 0);
  const scanDelayMs = intArg("scan-delay-ms", values["scan-delay-ms"], 1500, 0);
  const host = values.host ?? "127.0.0.1";
  const seed = values.seed ?? "demo";
  if (seed !== "demo" && seed !== "empty") {
    console.error("--seed must be demo or empty");
    process.exit(2);
  }

  const wifiMoves: Record<string, string> = {};
  for (const m of values["wifi-move"] ?? []) {
    const i = m.lastIndexOf("=");
    if (i < 1 || !/^(?:.+:)?\d+$/.test(m.slice(i + 1))) {
      console.error("--wifi-move must look like <ssid>=<host:port>");
      process.exit(2);
    }
    wifiMoves[m.slice(0, i)] = m.slice(i + 1);
  }

  const devices: FakeDevice[] = [];
  for (let i = 0; i < count; i++) {
    const port = basePort + i;
    // Deterministic 12-hex id derived from the port: fe5e + port + index.
    const id = `fe5e${port.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}`.slice(-12).padStart(12, "0");
    const dev = await startFakeDevice({ id, name: `Fake bench ${i + 1}`, host, port, seed, telemetryIntervalMs, rebootMs, scanDelayMs, pendingFirmware: values["pending-firmware"] === true, apMode: values["ap-mode"] === true, wifiMoves, log: process.env.FAKE_VERBOSE ? console.log : undefined });
    devices.push(dev);
    console.log(`${dev.url}  id=${dev.id}  name=${dev.state.name}`);
  }
  console.log(`${count} fake device${count === 1 ? "" : "s"} running. Ctrl+C to stop.`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Promise.all(devices.map((d) => d.close())).then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
