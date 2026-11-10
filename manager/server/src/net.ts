import os from "node:os";

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || h.startsWith("127.");
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** True for a socket remote address on this machine (IPv4, IPv6 or IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || a.startsWith("127.");
}

/** Non-internal IPv4 addresses of this machine. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** URL a person on this machine should open. */
export function localUrlFor(host: string, port: number): string {
  const h = isLoopbackHost(host) || isWildcardHost(host) ? "localhost" : host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}/`;
}

/** URLs other machines can use to reach a LAN-mode server. */
export function lanUrlsFor(host: string, port: number): string[] {
  if (isLoopbackHost(host)) return [];
  const hosts = isWildcardHost(host) ? lanAddresses() : [host];
  return hosts.map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${port}/`);
}
