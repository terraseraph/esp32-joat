import type { AppContext } from "../appContext";
import { callDevice, requireDevice } from "../api/deviceCall";
import { DeviceError } from "../device/client";
import { HttpError } from "../http/errors";
import { JobFailure, type JobControl } from "../jobs";
import type { RegistryDevice } from "../store/registry";
import type { Job } from "../types/api-jobs";
import type {
  WifiMoveBody,
  WifiMoveCheckBody,
  WifiMoveCheckResult,
  WifiMoveFieldError,
  WifiMoveJobResult,
  WifiMoveLastChange,
  WifiMoveSettings,
  WifiMoveWarning,
} from "../types/api-wifimove";
import type { DeviceStatus, NetworkStatus, WifiChange } from "../types/device-api";

/**
 * Move a device to another Wi-Fi network (L1, spec §9; firmware `wifi_change`, §2.9). `start()` creates it and closes it
 * on shutdown; `api/wifimove.ts` uses it. The move itself is a job of kind `wifi-move`.
 *
 * The device answers `network.wifi.set` after it tested the new network (up to 20 s), or never (the link dies when it
 * changes network). Either is normal, so the job does not trust the reply: it watches the device's own `wifi_change`
 * record (sequence number compared with the one read before) and looks for the device by id
 * (`discovery.waitForDevice`: registry address, the settings' discovery targets, mDNS and sweep when allowed).
 *
 * The password is held in the job closure only: never in params, result, messages, steps, logs or any file.
 */

/** `StartOptions.wifiMove`. Times in milliseconds; tests use small values. */
export interface WifiMoveConfig {
  /** How long the job looks for the device after sending the credentials (default 90000; a request may override it in seconds). */
  findTimeoutMs?: number;
  /** One round of looking (`waitForDevice` timeout, default 4000). */
  roundMs?: number;
  /** Pause between rounds (default 1000). */
  intervalMs?: number;
  /** Pause after the credentials were sent before the first round (default 1500). */
  settleMs?: number;
}

export interface WifiMoveFeature {
  /** Current Wi-Fi state of a device. Throws `HttpError` 404; a `DeviceError` when the device cannot be reached. */
  settings(id: string): Promise<WifiMoveSettings>;
  /** Dry run: errors the request would be refused for, and warnings. Never changes anything. */
  check(id: string, body: WifiMoveCheckBody): Promise<WifiMoveCheckResult>;
  /** Validate, then start the job. Throws `HttpError` 404/409/422; a `DeviceError` for transport problems. */
  start(id: string, body: WifiMoveBody): Promise<Job>;
  close(): Promise<void>;
}

const titleOf = (d: RegistryDevice): string => d.label || d.name || d.hostname || d.id;

const UNSUPPORTED = "This device's firmware cannot move to another Wi-Fi network safely yet. Update its firmware first.";

/** The device's failure reasons (`wifi_change.reason`) in plain words. */
export const REASON_WORDS: Record<string, string> = {
  auth: "The network refused the password. Check it and try again.",
  no_ap: "The device could not find that network. It may be out of range, or the name may be spelled differently (names are case sensitive).",
  no_ip: "The device joined the network but did not get an address from its router.",
  timeout: "The device did not manage to join the network in time.",
  connect_failed: "The device could not connect to that network.",
  save_failed:
    "The device joined the new network but could not save it, so it will go back to the old network the next time it restarts. Restart it to return to the old network, or try again.",
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** SSID 1-32 bytes, password empty or 8-63 characters (WPA2). */
export function validateWifiCredentials(ssid: string, password: string | undefined): WifiMoveFieldError[] {
  const errors: WifiMoveFieldError[] = [];
  const bytes = Buffer.byteLength(ssid, "utf8");
  if (ssid.length === 0) errors.push({ field: "ssid", message: "Enter the name of the Wi-Fi network." });
  else if (bytes > 32) errors.push({ field: "ssid", message: `A Wi-Fi name can be at most 32 bytes; this one is ${bytes}.` });
  if (password !== undefined && password !== "" && (password.length < 8 || password.length > 63)) {
    errors.push({ field: "password", message: "A Wi-Fi password has 8 to 63 characters (leave it empty for an open network)." });
  }
  return errors;
}

/** One sentence for a `wifi_change` record; null while there is nothing to say. */
export function wifiChangeWords(wc: WifiChange | undefined | null): string | null {
  if (!wc || wc.result === "none") return null;
  const net = wc.ssid ? ` "${wc.ssid}"` : "";
  if (wc.result === "testing") return `The device is testing the network${net}.`;
  if (wc.result === "ok") return `The last change worked: the device joined${net || " the new network"}.`;
  if (wc.result === "failed") {
    const why = (wc.reason && REASON_WORDS[wc.reason]) || "The reason is unknown.";
    return `The last change${net} failed. ${why}${wc.restored_previous ? " The device went back to its previous network." : ""}`;
  }
  return null;
}

function lastChangeOf(wc: WifiChange | undefined): WifiMoveLastChange | null {
  if (!wc || wc.result === "none") return null;
  return {
    result: String(wc.result),
    ssid: wc.ssid ?? null,
    reason: wc.reason ?? null,
    restoredPrevious: wc.restored_previous ?? null,
    seq: wc.seq ?? null,
    words: wifiChangeWords(wc),
  };
}

type ResultFn = (r: Partial<WifiMoveJobResult> & Pick<WifiMoveJobResult, "outcome">) => void;

interface Plan {
  ssid: string;
  password: string;
  seq0: number;
  staticBefore: boolean;
  timeoutMs: number;
}

export async function createWifiMoveFeature(app: AppContext, config: WifiMoveConfig = {}): Promise<WifiMoveFeature> {
  const findTimeoutMs = config.findTimeoutMs ?? 90_000;
  const roundMs = config.roundMs ?? 4000;
  const intervalMs = config.intervalMs ?? 1000;
  const settleMs = config.settleMs ?? 1500;
  const starting = new Set<string>();

  const activeJob = (id: string): Job | undefined => app.jobs.list({ kind: "wifi-move", active: true }).find((j) => j.deviceIds.includes(id));
  const readStatus = (dev: RegistryDevice): Promise<DeviceStatus> => app.pool.forDevice(dev.id, dev.host).status();

  /** The PC's Wi-Fi network, when the adapter can tell. Never switches anything. */
  async function pcNetwork(): Promise<{ ssid: string | null; known: boolean; setupAp: boolean }> {
    try {
      const a = await app.setup.adapterStatus();
      return { ssid: a.connectedSsid, known: a.supported && a.connectedSsid !== null, setupAp: a.supported };
    } catch {
      return { ssid: null, known: false, setupAp: false };
    }
  }

  async function settings(id: string): Promise<WifiMoveSettings> {
    const dev = requireDevice(app, id);
    const net: Partial<NetworkStatus> = (await readStatus(dev)).network ?? {};
    const supported = net.wifi_change !== undefined;
    const pc = await pcNetwork();
    const mode = net.ip_mode;
    return {
      supported,
      reason: supported ? null : UNSUPPORTED,
      state: net.state ?? "",
      connected: Boolean(net.sta_connected),
      ip: net.sta_ip ?? "",
      hostname: net.hostname ?? "",
      ipMode: mode === undefined ? null : mode === "dhcp" || mode === "static" ? mode : "unknown",
      staticIp: mode === "static",
      lastChange: lastChangeOf(net.wifi_change),
      pcSsid: pc.ssid,
      pcSsidKnown: pc.known,
      setupApAvailable: pc.setupAp,
      activeJobId: activeJob(id)?.id ?? null,
    };
  }

  async function check(id: string, body: WifiMoveCheckBody): Promise<WifiMoveCheckResult> {
    const dev = requireDevice(app, id);
    const errors: WifiMoveFieldError[] = validateWifiCredentials(body.ssid, body.password);
    let net: NetworkStatus | undefined;
    try {
      net = (await readStatus(dev)).network;
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err;
      errors.push({ field: "device", message: "The device does not answer right now, so it cannot be moved." });
    }
    if (net) {
      if (net.wifi_change === undefined) errors.push({ field: "device", message: UNSUPPORTED });
      else if (net.wifi_change.result === "testing") errors.push({ field: "device", message: "The device is testing a Wi-Fi change right now. Try again in a moment." });
    }
    if (errors.length > 0) return { ok: false, errors, warnings: [] };
    const warnings: WifiMoveWarning[] = [];
    const pc = await pcNetwork();
    if (!pc.known) {
      warnings.push({
        code: "pc_network_unknown",
        message: "The Manager cannot tell which Wi-Fi network this PC is on. If this PC cannot reach the new network, it will not be able to find the device afterwards.",
      });
    } else if (pc.ssid !== body.ssid) {
      warnings.push({
        code: "pc_other_network",
        message: `This PC is on "${pc.ssid}", not on "${body.ssid}". If this PC cannot reach "${body.ssid}", the Manager will not be able to find the device afterwards.`,
      });
    }
    if (net?.ip_mode === "static") {
      warnings.push({ code: "static_ip_reset", message: "This device uses a fixed address. On the new network it goes back to an automatic (DHCP) address." });
    }
    return { ok: true, errors: [], warnings };
  }

  async function start(id: string, body: WifiMoveBody): Promise<Job> {
    const dev = requireDevice(app, id);
    if (starting.has(id) || activeJob(id)) {
      throw new HttpError(409, "job_running", "A Wi-Fi move for this device is already running. Wait for it to finish, or cancel it first.");
    }
    const health = app.health.stateOf(id).health;
    if (health === "offline") throw new HttpError(409, "device_offline", "The device is offline. Bring it back online first, or use the recovery over its setup Wi-Fi.");
    if (health === "updating") throw new HttpError(409, "device_busy", "The device is being updated. Wait for that to finish.");
    const errors = validateWifiCredentials(body.ssid, body.password);
    if (errors.length > 0) throw new HttpError(422, "invalid_wifi_config", errors[0]?.message ?? "These settings are not valid.", errors);
    starting.add(id);
    try {
      const net = (await readStatus(dev)).network;
      if (net?.wifi_change === undefined) throw new HttpError(409, "wifi_change_unsupported", UNSUPPORTED);
      if (net.wifi_change.result === "testing") throw new HttpError(409, "device_busy", "The device is testing a Wi-Fi change right now. Try again in a moment.");
      const ssid = body.ssid;
      const password = body.password ?? ""; // closure only
      const plan: Plan = {
        ssid,
        password,
        seq0: net.wifi_change.seq ?? 0,
        staticBefore: net.ip_mode === "static",
        timeoutMs: body.timeoutS !== undefined ? body.timeoutS * 1000 : findTimeoutMs,
      };
      return app.jobs.create(
        {
          kind: "wifi-move",
          title: `Move ${titleOf(dev)} to "${ssid}"`,
          deviceIds: [dev.id],
          devices: [{ deviceId: dev.id, name: titleOf(dev) }],
          params: { ssid, open: password === "" },
          steps: [
            { id: "check", label: "Check the device" },
            { id: "send", label: "Send the new network" },
            { id: "switch", label: "Device tries the new network" },
            { id: "find", label: "Find the device again" },
            { id: "save", label: "Update the Manager's address" },
          ],
        },
        (ctl) => run(ctl, dev, plan),
      );
    } finally {
      starting.delete(id);
    }
  }

  // ---- the job ------------------------------------------------------------------------------------------------------

  async function run(ctl: JobControl, dev: RegistryDevice, plan: Plan): Promise<void> {
    const { ssid, seq0, staticBefore } = plan;
    const oldHost = dev.host;
    const stored = (): string => app.registry.get(dev.id)?.host ?? oldHost;
    const result: ResultFn = (r) => {
      const full: WifiMoveJobResult = {
        ssid,
        reason: null,
        reasonCode: null,
        restoredPrevious: null,
        oldHost,
        newHost: null,
        addressChanged: false,
        staticIpReset: false,
        ...r,
      };
      ctl.result(full);
    };
    const pollSoon = async (): Promise<void> => {
      try {
        await app.health.pollNow(dev.id);
      } catch {
        /* the next poll will tell */
      }
    };
    const cancelled = (): void => {
      const note =
        "Cancelled. The Manager stopped waiting, but the device may already have moved to the new network, or be about to. If it does not show up, scan again from a PC that can reach the new network.";
      ctl.message(note);
      result({ outcome: "unknown", reason: note, newHost: stored() === oldHost ? null : stored(), addressChanged: stored() !== oldHost });
    };
    const failedRestored = (wc: WifiChange, foundHost?: string): never => {
      const code = wc.reason && wc.reason in REASON_WORDS ? wc.reason : "wifi_failed";
      const base = (wc.reason && REASON_WORDS[wc.reason]) || "The device could not join the new network.";
      const back =
        wc.reason === "save_failed"
          ? ""
          : wc.restored_previous
            ? " The device went back to its previous network, so nothing changed."
            : " The device did not report going back to its previous network; check that it is still reachable.";
      const reason = `${base}${back}`;
      const at = foundHost ?? stored();
      ctl.device(dev.id, { state: wc.restored_previous ? "reverted" : "failed", message: reason });
      result({ outcome: "failed", reason, reasonCode: wc.reason ?? null, restoredPrevious: wc.restored_previous ?? null, newHost: at, addressChanged: at !== oldHost });
      throw new JobFailure(code, reason, "switch");
    };

    ctl.device(dev.id, { state: "running" });
    ctl.step("check", "done");
    app.health.setUpdating(dev.id, true); // the poller leaves the device alone while it changes network
    try {
      // ---- send ----------------------------------------------------------------------------------------------------
      ctl.step("send", { status: "running" });
      ctl.message("Sending the new network to the device.");
      let refusal: string | null = null;
      const call = callDevice(app, dev, "POST", "/command", { json: { cmd: "network.wifi.set", ssid, password: plan.password } }).then(
        (res) => {
          const env = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; error?: unknown }) : undefined;
          if (!(res.status >= 200 && res.status < 300 && env?.ok === true)) {
            refusal = typeof env?.error === "string" && env.error ? env.error : `the device answered with status ${res.status}`;
          }
        },
        (err: unknown) => {
          if (!(err instanceof DeviceError)) throw err; // a dropped connection is normal: the device is changing network
        },
      );
      const aborted = new Promise<"aborted">((resolve) => {
        if (ctl.signal.aborted) return resolve("aborted");
        ctl.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const sent = await Promise.race([call.then(() => "sent" as const), aborted]);
      if (sent === "aborted") {
        void call.catch(() => undefined);
        return cancelled();
      }
      ctl.step("send", { status: "done", detail: "The device received the network." });

      // ---- an answer with ok:false: read the device's own record to explain it ---------------------------------------
      if (refusal !== null) {
        const why = await explainFailure(ctl, dev, seq0);
        ctl.step("switch", { status: "failed", detail: why ? (wifiChangeWords(why) ?? refusal) : refusal });
        ctl.step("find", { status: "skipped" });
        ctl.step("save", { status: "skipped" });
        if (why) return failedRestored(why);
        const message = `The device refused the change: ${refusal}.`;
        ctl.device(dev.id, { state: "failed", message });
        result({ outcome: "failed", reason: message });
        throw new JobFailure("device_refused", message, "send");
      }

      // ---- look for the device -------------------------------------------------------------------------------------
      ctl.step("switch", { status: "running", detail: "The device tests the network for up to 20 seconds. It may stop answering." });
      ctl.message("Waiting for the device to try the new network.");
      await sleep(settleMs, ctl.signal);
      const deadline = Date.now() + plan.timeoutMs;
      let found: { host: string; status: DeviceStatus } | null = null;
      while (!ctl.signal.aborted) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const hit = await app.discovery.waitForDevice(dev.id, { timeoutMs: Math.min(roundMs, left), signal: ctl.signal, intervalMs });
        if (ctl.signal.aborted) break;
        if (!hit) continue;
        const wc = hit.status.network?.wifi_change;
        const fresh = wc !== undefined && (wc.seq ?? 0) > seq0;
        if (fresh && wc.result === "testing") {
          ctl.step("find", { status: "running", detail: "The device is still testing the network." });
          await sleep(intervalMs, ctl.signal);
          continue;
        }
        if (fresh && (wc.result === "failed" || wc.result === "ok")) {
          found = hit;
          break;
        }
        if (hit.host !== stored() || wc === undefined) {
          // Found somewhere else (or without a record: it restarted): it is on another network now.
          found = hit;
          break;
        }
        // Same address and no new record: the device has not started or finished the change yet. Keep looking.
        await sleep(intervalMs, ctl.signal);
      }
      if (ctl.signal.aborted) return cancelled();
      ctl.step("switch", "done");

      if (!found) {
        const reason =
          `The Manager did not see the device again within ${Math.round(plan.timeoutMs / 1000)} second${Math.round(plan.timeoutMs / 1000) === 1 ? "" : "s"}. It may have joined "${ssid}" and be on a network this PC cannot reach. ` +
          `To find it: connect this PC to "${ssid}" and scan again. If the device cannot join that network, it raises its own setup Wi-Fi after about a minute without a network: ` +
          `use "Recover over its setup Wi-Fi" on the device page.`;
        ctl.step("find", { status: "failed", detail: "Not found" });
        ctl.step("save", { status: "skipped" });
        ctl.device(dev.id, { state: "failed", message: reason });
        result({ outcome: "not_found", reason });
        throw new JobFailure("not_found", reason, "find");
      }

      const net = found.status.network;
      const wc = net?.wifi_change;
      ctl.step("find", { status: "done", detail: `Found it at ${found.host}` });
      ctl.step("save", { status: "running" });
      if (found.host !== stored()) app.registry.update(dev.id, { host: found.host }); // where it really is now, also after a failed try
      await pollSoon();
      ctl.step("save", found.host !== oldHost ? { status: "done", detail: found.host } : { status: "skipped", detail: "The address did not change." });
      if (wc && (wc.seq ?? 0) > seq0 && wc.result === "failed") return failedRestored(wc, found.host);

      const staticIpReset = net?.ip_change?.result === "reset" || (staticBefore && net?.ip_mode === "dhcp");
      ctl.device(dev.id, { state: "done" });
      ctl.message(`The device is on "${ssid}" now.`);
      result({ outcome: "ok", newHost: found.host, addressChanged: found.host !== oldHost, staticIpReset });
    } finally {
      app.health.setUpdating(dev.id, false);
    }
  }

  /** The device answered "failed": read its own record (it may need a moment after the reply) to explain why. */
  async function explainFailure(ctl: JobControl, dev: RegistryDevice, seq0: number): Promise<WifiChange | null> {
    for (let i = 0; i < 5 && !ctl.signal.aborted; i++) {
      try {
        const wc = (await readStatus(dev)).network?.wifi_change;
        if (wc && (wc.seq ?? 0) > seq0 && wc.result === "failed") return wc;
      } catch {
        /* try again */
      }
      await sleep(intervalMs, ctl.signal);
    }
    return null;
  }

  return { settings, check, start, async close() {} };
}
