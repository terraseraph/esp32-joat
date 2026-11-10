import { randomBytes } from "node:crypto";
import type http from "node:http";
import net, { type Socket } from "node:net";
import { isLoopbackAddress, isLoopbackHost, isWildcardHost, lanUrlsFor, localUrlFor } from "../net";
import type { SettingsService } from "../store/settings";
import type { AccessResponse } from "../types/api";
import type { BrowserHub } from "../ws/browserHub";
import { HttpError } from "./errors";
import type { Security } from "./security";

/**
 * Runtime LAN access: switch the listening socket between this PC only and the whole network, rotate the token,
 * and cut off everybody who is not local when access is withdrawn. Owned by `start()`; routes reach it as `ctx.app.access`.
 *
 * Rules (see API.md "Access"):
 * - Effective LAN at start = CLI `--lan` OR the persisted `lanEnabled` setting (the latter only while the toggle is available).
 * - The toggle is unavailable when the embedding app forbids it (`StartOptions.lanToggle: false`, the desktop app) or when the
 *   server was started with an explicit `--host` that is neither a loopback name nor a wildcard (0.0.0.0, ::): that flag fixes
 *   the bind, so the UI must not pretend it can change it.
 * - Switching re-binds the same port: close the listening socket, listen on the LAN host (the wildcard) or the loopback host.
 *   If listening fails the previous host is re-listened and the call fails with 409 `rebind_failed`, so the server never ends up deaf.
 *   Connections that are already open (loopback keep-alive, browser sockets) stay open across the switch.
 * - Switching off destroys every non-local HTTP socket and closes every non-local browser WebSocket.
 */

export const LAN_WS_CLOSE_CODE = 4001;

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The stored LAN token, created (and saved) the first time it is needed. Never called in localhost mode. */
export async function ensureLanToken(settings: SettingsService): Promise<string> {
  const existing = settings.get().lanToken;
  if (existing) return existing;
  const lanToken = generateToken();
  await settings.update({ lanToken });
  return lanToken;
}

export interface ToggleStatus {
  available: boolean;
  reason: string | null;
}

/** Whether LAN access can be switched at runtime for these start options. */
export function toggleStatus(opts: { host: string; lanToggle?: boolean }): ToggleStatus {
  if (opts.lanToggle === false) return { available: false, reason: "LAN access is not available in the desktop app." };
  if (!isLoopbackHost(opts.host) && !isWildcardHost(opts.host)) {
    return {
      available: false,
      reason: `The Manager was started with --host ${opts.host}, which fixes the address it listens on. Restart it without --host (use --lan if you want network access) to switch this here.`,
    };
  }
  return { available: true, reason: null };
}

export interface AccessControllerDeps {
  server: http.Server;
  security: Security;
  settings: SettingsService;
  hub: BrowserHub;
  /** Address the server is bound to right now. */
  initialHost: string;
  /** `StartOptions.host`: decides which addresses a switch uses. */
  startHost: string;
  lanBindHost: string;
  toggle: ToggleStatus;
  getPort: () => number;
  lanAddresses?: () => string[];
  log: (msg: string) => void;
}

export interface AccessController {
  readonly lan: boolean;
  readonly token: string | null;
  /** Address the server is bound to right now. */
  readonly host: string;
  toggle(): ToggleStatus;
  /** Count a connection (call from the server's `connection` event). */
  trackConnection(s: Socket): void;
  /** Note who sent a request: a socket that ever carried a non-local request is cut when LAN access is withdrawn. */
  noteRequest(req: http.IncomingMessage): void;
  /** Mark a socket as upgraded to a browser WebSocket (the hub closes those itself). */
  noteUpgrade(s: Socket): void;
  /** The caller passed the security check AND is the local user or holds the valid token. */
  isTrusted(req: http.IncomingMessage): boolean;
  /**
   * Everything about access that a trusted caller may see. Pass `known` when trust was established before a change that
   * invalidates it (the caller's own token was just regenerated, or the switch that let it in was turned off).
   */
  describe(req: http.IncomingMessage, known?: { trusted: boolean }): AccessResponse;
  /** Switch LAN access. `caller` (the request that asked) keeps its connection until its response is out. */
  setLan(on: boolean, caller?: { req: http.IncomingMessage; res: http.ServerResponse }): Promise<void>;
  /** New token; every old cookie/Bearer stops working and non-local browser sockets are closed. Resolves with the new token. */
  rotateToken(): Promise<string>;
  /** Value for `Set-Cookie` that gives a remote browser the current token. */
  cookieFor(token: string): string;
}

export function createAccessController(deps: AccessControllerDeps): AccessController {
  const { server, security, settings, hub, log } = deps;
  let host = deps.initialHost;
  const sockets = new Set<Socket>();
  const remoteSockets = new WeakSet<Socket>();
  const wsSockets = new WeakSet<Socket>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const lanHost = isWildcardHost(deps.startHost) ? deps.startHost : deps.lanBindHost;
  const localHost = isLoopbackHost(deps.startHost) ? deps.startHost : "127.0.0.1";

  function listenOn(h: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, h);
    });
  }

  /**
   * Move the listening socket. `net.Server.close` is used on purpose, not `http.Server.close`: the latter also
   * closes idle keep-alive connections, and those must survive the switch.
   */
  async function rebindTo(next: string): Promise<void> {
    if (next === host) return;
    const prev = host;
    const port = deps.getPort();
    net.Server.prototype.close.call(server);
    try {
      await listenOn(next, port);
      host = next;
    } catch (err) {
      try {
        await listenOn(prev, port);
      } catch (again) {
        log(`could not listen again on ${prev}:${port} after a failed switch: ${(again as Error).message}`);
      }
      const code = (err as NodeJS.ErrnoException).code;
      throw new HttpError(
        409,
        "rebind_failed",
        `Could not listen on ${next}:${port}${code ? ` (${code})` : ""}: ${(err as Error).message}. The Manager keeps listening on ${prev}.`,
      );
    }
  }

  const isRemoteSocket = (s: Socket): boolean => !isLoopbackAddress(s.remoteAddress) || remoteSockets.has(s);

  function cutRemote(caller?: { req: http.IncomingMessage; res: http.ServerResponse }): void {
    hub.closeRemote(LAN_WS_CLOSE_CODE, "LAN access was switched off");
    for (const s of sockets) {
      if (wsSockets.has(s) || s === caller?.req.socket || !isRemoteSocket(s)) continue;
      s.destroy();
    }
    const own = caller?.req.socket;
    if (own && isRemoteSocket(own)) {
      // The caller asked to switch it off: let it read the answer first.
      caller.res.once("finish", () => setImmediate(() => own.destroy()));
    }
  }

  function maskToken(t: string): string {
    return "•".repeat(12) + t.slice(-4);
  }

  function urls(): string[] {
    if (!security.lan) return [];
    const port = deps.getPort();
    if (deps.lanAddresses) return deps.lanAddresses().map((a) => `http://${a.includes(":") ? `[${a}]` : a}:${port}/`);
    return lanUrlsFor(host, port);
  }

  const controller: AccessController = {
    get lan() {
      return security.lan;
    },
    get token() {
      return security.lan ? security.token : null;
    },
    get host() {
      return host;
    },
    toggle: () => deps.toggle,
    trackConnection(s) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    },
    noteRequest(req) {
      if (!security.isLocalUser(req)) remoteSockets.add(req.socket);
    },
    noteUpgrade(s) {
      wsSockets.add(s);
    },
    isTrusted: (req) => security.isTrusted(req),
    cookieFor: (t) => security.cookieFor(t),
    describe(req, known) {
      const trusted = known?.trusted ?? security.isTrusted(req);
      const lanUrls = urls();
      const token = trusted && security.lan ? security.token : null;
      const tokenUrls = token ? lanUrls.map((u) => `${u}?token=${token}`) : [];
      return {
        lan: security.lan,
        host,
        port: deps.getPort(),
        localUrl: localUrlFor(host, deps.getPort()),
        lanUrls,
        token,
        tokenMasked: token ? maskToken(token) : null,
        tokenUrls,
        openUrl: tokenUrls[0] ?? null,
        remote: !security.isLocalUser(req),
        toggleAvailable: deps.toggle.available,
        toggleUnavailableReason: deps.toggle.reason,
      };
    },
    setLan(on, caller) {
      return serial(async () => {
        if (!deps.toggle.available) throw new HttpError(409, "lan_unavailable", deps.toggle.reason ?? "LAN access cannot be switched here.");
        if (on === security.lan) return;
        if (on) {
          const token = await ensureLanToken(settings);
          // Token and rules first, socket second: the wide listener never exists without the gate.
          security.setToken(token);
          security.setLan(true);
          try {
            await rebindTo(lanHost);
          } catch (err) {
            security.setLan(false);
            security.setToken(null);
            throw err;
          }
          await settings.update({ lanEnabled: true });
          log(`LAN access switched on, listening on ${host}:${deps.getPort()} (access token required)`);
        } else {
          await rebindTo(localHost);
          security.setLan(false);
          security.setToken(null);
          await settings.update({ lanEnabled: false });
          log(`LAN access switched off, listening on ${host}:${deps.getPort()}`);
          hub.broadcast({ t: "access", lan: false });
          cutRemote(caller);
          return;
        }
        hub.broadcast({ t: "access", lan: true });
      });
    },
    rotateToken() {
      return serial(async () => {
        if (!security.lan) throw new HttpError(409, "lan_disabled", "LAN access is off, so there is no token to regenerate. Switch it on first.");
        const token = generateToken();
        await settings.update({ lanToken: token });
        security.setToken(token);
        hub.closeRemote(LAN_WS_CLOSE_CODE, "The access token was regenerated");
        log("LAN access token regenerated");
        return token;
      });
    },
  };
  return controller;
}
