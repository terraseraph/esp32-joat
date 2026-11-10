import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isLoopbackAddress, isLoopbackHost } from "../net";
import { MUTATING_METHODS } from "./router";

/**
 * Request gatekeeping (spec 3.1).
 *
 * Localhost mode: Host must be localhost|127.0.0.1|[::1]:<port> (DNS rebinding),
 *   mutating requests / WS upgrades with an Origin must be same-origin or allow-listed (CSRF).
 * LAN mode: a token is required (Bearer, `dem_token` cookie, or `?token=` on a page GET
 *   which sets the cookie and redirects), except for the local user (loopback socket AND
 *   loopback Host). The Origin rule applies to everyone.
 *
 * LAN mode and the token can change while the server runs (Settings switch, token rotation):
 * the object below is mutable and every check reads the live values.
 *
 * ---- Security model, and why each rule is there -------------------------------------------------------------
 *
 * What the token protects. Whoever holds the token can read and change every device behind this Manager (pins,
 * Wi-Fi/MQTT settings, firmware). The devices themselves have NO authentication of their own, so the token is
 * the only gate on the LAN. It is a bearer secret over plain http: anyone who can sniff the network can read it.
 * LAN mode is meant for a trusted home/lab network, not for the internet.
 *
 * Local user. A request is "local" only if BOTH the socket peer is a loopback address AND the Host header is a
 * loopback name with our port. Peer alone is not enough: a reverse proxy or a tunnel running on this PC also
 * connects from 127.0.0.1 but forwards the public Host. Host alone is not enough: any remote client can type
 * `Host: localhost:5180`. Requiring both means DNS rebinding (the browser connects to 127.0.0.1 but sends
 * `Host: evil.example`) and remote spoofing both fall back to the token rule.
 *
 * DNS rebinding in LAN mode. A malicious page whose name is re-pointed at this PC's LAN address sends
 * `Host: evil.example`: not loopback, so the token is required; the cookie is scoped to our host name and is
 * SameSite=Strict, so the attacker's origin never has it. We do not allow-list Host names in LAN mode (people
 * reach the Manager by IP, `machine.local`, a DNS name ...): the token is the gate, not the Host.
 * In localhost mode every non-loopback Host is refused (403 forbidden_host).
 *
 * CSRF. Any POST/PUT/PATCH/DELETE and every WebSocket upgrade that carries an `Origin` must be same-origin (equal
 * to the Host header) or in the allow-list (the Vite dev server). `Origin: null` (sandboxed iframes, data: URLs,
 * some redirects) never parses as a URL and is therefore refused. Requests without Origin (curl, scripts) are not
 * browser requests and pass. The rule also applies to the local user and to token holders: a valid cookie does not
 * make a cross-site request acceptable. GETs are not Origin-checked; they never change state.
 *
 * Token transport. Bearer header and the HttpOnly `dem_token` cookie are accepted everywhere (the cookie also on
 * the WebSocket upgrade). `?token=` is accepted ONLY on a page GET (not under /api): it sets the cookie and
 * answers 302 to the same URL without `token`, so the secret does not stay in the address bar, history or
 * Referer. A query token on an API call is never accepted (URLs end up in logs and proxies).
 * Cookie: HttpOnly (scripts cannot read it), SameSite=Strict, Path=/, Max-Age 30 days. No `Secure`: the
 * Manager speaks plain http on the LAN, and a Secure cookie would never be sent back.
 *
 * Comparison and brute force. Every comparison is constant-time (`safeEqual`: hash both sides, then
 * timingSafeEqual). Remote addresses that present a wrong token more than `maxAttempts` times in `windowMs`
 * (default 10 per 60 s) get 429 `too_many_attempts` with `Retry-After` for HTTP and WS alike until the window
 * ends. Requests without any token are not counted, the local user is never limited, and the table is capped.
 *
 * The token never appears in logs, job data or WebSocket messages; the only place it is printed is the start-up
 * banner on stdout (main.ts).
 */

export const TOKEN_COOKIE = "dem_token";
/** 30 days. Rotating the token invalidates every cookie anyway. */
export const TOKEN_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

export type SecurityDecision =
  | { kind: "allow" }
  | { kind: "deny"; status: number; code: string; message: string; headers?: Record<string, string> }
  | { kind: "redirect"; location: string; setCookie: string };

export interface RateLimitOptions {
  /** Wrong tokens allowed per remote address per window (default 10). */
  maxAttempts?: number;
  /** Window length in ms (default 60000). */
  windowMs?: number;
  /** Max addresses remembered (default 1000; oldest are dropped first). */
  maxTracked?: number;
}

export interface SecurityOptions {
  lan: boolean;
  /** Required in LAN mode (without one every non-local request is refused). */
  token: string | null;
  /** Extra origins accepted by the Origin check, e.g. "http://localhost:5173" for `npm run dev`. */
  allowOrigins: string[];
  /** Actual listening port (known only after listen). */
  getPort: () => number;
  rateLimit?: RateLimitOptions;
  /** Clock (tests). */
  now?: () => number;
}

export interface Security {
  check(req: IncomingMessage, kind: "http" | "upgrade"): SecurityDecision;
  /** LAN mode is on (live). */
  readonly lan: boolean;
  /** The current token (null while LAN mode is off). */
  readonly token: string | null;
  setLan(on: boolean): void;
  setToken(token: string | null): void;
  /** Loopback socket AND loopback Host (never true for a remote client, whatever it sends). */
  isLocalUser(req: IncomingMessage): boolean;
  /** The caller may see the token and change access: the local user, or a request that carries the valid token (header or cookie). */
  isTrusted(req: IncomingMessage): boolean;
  /** `Set-Cookie` value for a token. */
  cookieFor(token: string): string;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time string comparison (hashes first so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** `Host` header is a loopback name with the bound port. */
function hostIsLoopback(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  if (!m) return false;
  const name = m[1] as string;
  const p = m[2] ? Number(m[2]) : 80;
  return p === port && isLoopbackHost(name);
}

export function createSecurity(opts: SecurityOptions): Security {
  const allowed = new Set(opts.allowOrigins.map((o) => o.replace(/\/+$/, "").toLowerCase()));
  const maxAttempts = opts.rateLimit?.maxAttempts ?? 10;
  const windowMs = opts.rateLimit?.windowMs ?? 60_000;
  const maxTracked = opts.rateLimit?.maxTracked ?? 1000;
  const now = opts.now ?? Date.now;
  let lan = opts.lan;
  let token = opts.token;
  /** Wrong-token counters per remote address (fixed window, bounded). */
  const failures = new Map<string, { count: number; start: number }>();

  function retryAfterS(addr: string): number {
    const e = failures.get(addr);
    if (!e) return 0;
    const left = e.start + windowMs - now();
    if (left <= 0) {
      failures.delete(addr);
      return 0;
    }
    return e.count >= maxAttempts ? Math.max(1, Math.ceil(left / 1000)) : 0;
  }

  function recordFailure(addr: string): void {
    const t = now();
    const e = failures.get(addr);
    if (e && t - e.start < windowMs) {
      e.count++;
      return;
    }
    failures.delete(addr);
    if (failures.size >= maxTracked) {
      for (const [k, v] of failures) if (t - v.start >= windowMs) failures.delete(k);
      while (failures.size >= maxTracked) {
        const oldest = failures.keys().next();
        if (oldest.done) break;
        failures.delete(oldest.value);
      }
    }
    failures.set(addr, { count: 1, start: t });
  }

  function originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser clients (curl, node) send no Origin
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false; // includes the literal "null"
    }
    if (allowed.has(u.origin.toLowerCase())) return true;
    const host = req.headers.host;
    return host !== undefined && u.host.toLowerCase() === host.toLowerCase();
  }

  /** Token from the Authorization header, else from the cookie. */
  function tokenFrom(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();
    return parseCookies(req.headers.cookie)[TOKEN_COOKIE] ?? null;
  }

  function isLocalUser(req: IncomingMessage): boolean {
    return isLoopbackAddress(req.socket.remoteAddress) && hostIsLoopback(req.headers.host, opts.getPort());
  }

  function hasValidToken(req: IncomingMessage): boolean {
    const given = tokenFrom(req);
    return given !== null && token !== null && safeEqual(given, token);
  }

  const cookieFor = (t: string): string => `${TOKEN_COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE_S}`;

  return {
    get lan() {
      return lan;
    },
    get token() {
      return token;
    },
    setLan(on) {
      lan = on;
    },
    setToken(t) {
      token = t;
    },
    isLocalUser,
    isTrusted(req) {
      if (!lan) return hostIsLoopback(req.headers.host, opts.getPort());
      return isLocalUser(req) || hasValidToken(req);
    },
    cookieFor,
    check(req, kind) {
      const port = opts.getPort();
      const loopbackHost = hostIsLoopback(req.headers.host, port);

      if (!lan && !loopbackHost) {
        return { kind: "deny", status: 403, code: "forbidden_host", message: `Host header not allowed: ${req.headers.host ?? "(none)"}` };
      }

      if (lan && !isLocalUser(req)) {
        const addr = req.socket.remoteAddress ?? "?";
        const url = new URL(req.url ?? "/", "http://localhost");
        const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
        const given = tokenFrom(req);
        const queryToken = url.searchParams.get("token");
        const presented = given !== null || queryToken !== null;

        if (presented) {
          const wait = retryAfterS(addr);
          if (wait > 0) {
            return {
              kind: "deny",
              status: 429,
              code: "too_many_attempts",
              message: `Too many wrong access tokens from this address. Try again in ${wait} s.`,
              headers: { "Retry-After": String(wait) },
            };
          }
        }
        if (token === null || given === null || !safeEqual(given, token)) {
          if (token !== null && kind === "http" && req.method === "GET" && !isApi && queryToken !== null && safeEqual(queryToken, token)) {
            url.searchParams.delete("token");
            return { kind: "redirect", location: url.pathname + url.search, setCookie: cookieFor(token) };
          }
          if (presented) recordFailure(addr);
          return { kind: "deny", status: 401, code: "unauthorized", message: "Access token required" };
        }
      }

      if ((kind === "upgrade" || MUTATING_METHODS.has((req.method ?? "GET").toUpperCase())) && !originOk(req)) {
        return { kind: "deny", status: 403, code: "forbidden_origin", message: `Origin not allowed: ${req.headers.origin}` };
      }
      return { kind: "allow" };
    },
  };
}
