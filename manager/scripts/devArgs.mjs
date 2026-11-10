// Arguments for the dev API server (used by dev.mjs). `npm run dev -- <args>` reaches the server unchanged, except:
//   - the dev server defaults to --no-network-scan and --wifi-adapter fake, so a dev session never scans the real LAN
//     or touches this PC's Wi-Fi by accident;
//   - `--network-scan` opts back in to scanning (it is consumed here, the server has no such flag);
//   - `--wifi-adapter <kind>` / `--wifi-adapter=<kind>` (for example `system`) replaces the fake adapter.

/** @param {string[]} extra what the user typed after `npm run dev --` */
export function devServerArgs(extra) {
  const args = [];
  let networkScan = false;
  for (const a of extra) {
    if (a === "--network-scan") networkScan = true;
    else args.push(a);
  }
  const hasWifi = args.some((a) => a === "--wifi-adapter" || a.startsWith("--wifi-adapter="));
  return [
    "--no-open",
    "--data-dir",
    ".data/dev",
    "--allow-origin",
    "http://localhost:5173",
    ...(networkScan || args.includes("--no-network-scan") ? [] : ["--no-network-scan"]),
    ...(hasWifi ? [] : ["--wifi-adapter", "fake"]),
    ...args,
  ];
}
