// Arguments for the dev API server (used by dev.mjs). `npm run dev -- <args>` reaches the server unchanged.
// The dev server is the real thing: it scans this network (mDNS + /24 sweep) and uses this PC's Wi-Fi adapter for
// SoftAP setup, like the packaged app. Only the data folder (.data/dev), --no-open and the Vite origin are dev-specific.
// For simulated boards use `npm run fake` and, if you want a simulated Wi-Fi adapter, `npm run dev -- --wifi-adapter fake`.

/** @param {string[]} extra what the user typed after `npm run dev --` */
export function devServerArgs(extra) {
  return ["--no-open", "--data-dir", ".data/dev", "--allow-origin", "http://localhost:5173", ...extra];
}
