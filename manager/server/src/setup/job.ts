import { randomBytes } from "node:crypto";
import { isOurs } from "node-red-contrib-de-esp32/lib/fingerprint";
import type { AppContext } from "../appContext";
import { createDeviceClient, DeviceError, WIFI_TIMEOUT_MS, type DeviceClient } from "../device/client";
import { JobFailure, type JobControl } from "../jobs";
import type { AccessPoint, DeviceEnvelope, DeviceStatus, NetworkStatus, WifiChangeReason } from "../types/device-api";
import type { SetupChooseResult, SetupJobResult } from "../types/api-setup";
import { SETUP_SSID_RE, TEMP_PROFILE_PREFIX, WifiError, type WifiAdapter } from "../wifi/adapter";
import { clearMarker, writeMarker, type SetupMarkerFile } from "./marker";
import { restoreNetwork } from "./restore";

/**
 * The setup job: join the device's setup Wi-Fi, check it is ours, optionally let the user choose a network, send the Wi-Fi
 * details, rejoin this PC's own network (always, in a final path), find the device on the LAN and add it to the fleet.
 * Passwords live only in the closure of `runSetupJob`; every text that leaves it goes through `scrub`.
 */

export interface SetupTimings {
  /** Time `connect` waits for the PC to join the setup Wi-Fi. */
  joinMs: number;
  /** After joining: time to wait for the device at the setup address. */
  apReachMs: number;
  /** After sending the Wi-Fi details: time to wait for the device to report whether it joined. */
  wifiResultMs: number;
  /** After rejoining the PC's network: time to find the device there. */
  lanWaitMs: number;
  /** Time the job waits for the user to choose a network. */
  chooseTimeoutMs: number;
  /** After a factory reset: time for the device to come back on its setup Wi-Fi. */
  factoryResetWaitMs: number;
  /** Pause between polls of the device. */
  pollMs: number;
  /** Time to wait for the PC to rejoin its own network, per attempt. */
  rejoinMs: number;
  /** Timeout of one status probe. */
  probeMs: number;
}

export const DEFAULT_TIMINGS: SetupTimings = {
  joinMs: 20_000,
  apReachMs: 30_000,
  wifiResultMs: 45_000,
  lanWaitMs: 90_000,
  chooseTimeoutMs: 180_000,
  factoryResetWaitMs: 45_000,
  pollMs: 1_000,
  rejoinMs: 25_000,
  probeMs: 2_500,
};

export interface SetupRequest {
  ssid: string;
  apPassword?: string;
  deviceId?: string;
  wifi?: { ssid: string; password?: string };
  factoryResetFirst: boolean;
}

export interface WifiChoice {
  ssid: string;
  password?: string;
  factoryResetFirst?: boolean;
}

export interface SetupJobEnv {
  app: AppContext;
  adapter: WifiAdapter;
  timings: SetupTimings;
  apAddress: string;
  dataDir: string;
  log: (msg: string) => void;
}

export const SETUP_STEPS: { id: string; label: string }[] = [
  { id: "remember", label: "Remember this PC's Wi-Fi" },
  { id: "join_ap", label: "Join the device's setup Wi-Fi" },
  { id: "fingerprint", label: "Check the device" },
  { id: "scan", label: "Look for networks" },
  { id: "choose", label: "Choose a network" },
  { id: "factory_reset", label: "Factory reset" },
  { id: "send_wifi", label: "Send Wi-Fi details" },
  { id: "check_result", label: "Check the device's answer" },
  { id: "leave_ap", label: "Rejoin this PC's Wi-Fi" },
  { id: "wait_lan", label: "Wait for the device on your network" },
  { id: "add", label: "Add to the fleet" },
];

/** Where the job waits for the user's choice of network (`POST /api/setup/jobs/:id/wifi`). */
export class ChooseGate {
  private resolver: ((choice: WifiChoice) => void) | null = null;

  get waiting(): boolean {
    return this.resolver !== null;
  }

  /** Called by the job. Rejects with the job's own failures. */
  wait(timeoutMs: number, signal: AbortSignal): Promise<WifiChoice> {
    return new Promise<WifiChoice>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.resolver = null;
      };
      const onAbort = (): void => {
        cleanup();
        reject(new JobFailure("cancelled", "Setup was cancelled.", "choose"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new JobFailure("choose_timeout", "No network was chosen in time, so the setup was stopped. Start it again when you are ready.", "choose"));
      }, timeoutMs);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.resolver = (choice) => {
        cleanup();
        resolve(choice);
      };
    });
  }

  /** Called by the route. false = the job is not waiting. */
  submit(choice: WifiChoice): boolean {
    const r = this.resolver;
    if (!r) return false;
    r(choice);
    return true;
  }
}

const REASON_FAILURES: Record<WifiChangeReason, { code: string; text: (ssid: string) => string }> = {
  auth: { code: "wifi_auth", text: (s) => `The device could not join "${s}": the Wi-Fi password was wrong.` },
  no_ap: { code: "wifi_no_ap", text: (s) => `"${s}" was not found by the device. It may be out of range, or only broadcast on 5 GHz (the device needs 2.4 GHz).` },
  no_ip: { code: "wifi_no_ip", text: (s) => `The device joined "${s}" but did not get an address from it. Check that the router hands out addresses (DHCP).` },
  timeout: { code: "wifi_failed", text: (s) => `The device could not join "${s}" in time.` },
  connect_failed: { code: "wifi_failed", text: (s) => `The device could not connect to "${s}".` },
  save_failed: { code: "wifi_failed", text: (s) => `The device joined "${s}" but could not save the Wi-Fi details.` },
};

/** Device answers that mean "this is not one of our devices" rather than "no answer yet". */
const FOREIGN_KINDS: ReadonlySet<string> = new Set(["captive_redirect", "bad_response", "http_status"]);

interface DeviceInfoLike {
  id: string;
  name: string;
  hostname: string;
}

export async function runSetupJob(env: SetupJobEnv, ctl: JobControl, req: SetupRequest, gate: ChooseGate): Promise<void> {
  const { app, adapter, timings } = env;
  const signal = ctl.signal;
  const secrets: string[] = [];
  const addSecret = (s: string | undefined): void => {
    if (s !== undefined && s.length > 0) secrets.push(s);
  };
  addSecret(req.apPassword);
  addSecret(req.wifi?.password);
  const scrub = (text: string): string => secrets.reduce((t, s) => (s.length >= 3 ? t.split(s).join("***") : t), text);

  const cancelled = (step?: string): JobFailure => new JobFailure("cancelled", "Setup was cancelled.", step);
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(cancelled());
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  /** Race a slow call against cancel, so Cancel never waits for a device timeout. */
  const race = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        p.catch(() => undefined);
        return reject(cancelled());
      }
      const onAbort = (): void => {
        p.catch(() => undefined);
        reject(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  const begin = (id: string, detail?: string): void => ctl.step(id, { status: "running", ...(detail !== undefined ? { detail } : {}) });
  const done = (id: string, detail?: string): void => ctl.step(id, { status: "done", ...(detail !== undefined ? { detail } : {}) });

  const apSsid = req.ssid;
  let marker: SetupMarkerFile | null = null;
  let client: DeviceClient | null = null;
  let restoreOnce: Promise<JobFailure | null> | null = null;

  const saveMarker = async (): Promise<void> => {
    if (marker) await writeMarker(env.dataDir, marker);
  };

  /** Put this PC's Wi-Fi back. Runs once; later calls get the same answer. Never throws. */
  const ensureRestored = (): Promise<JobFailure | null> => {
    restoreOnce ??= (async () => {
      if (!marker) return null;
      const out = await restoreNetwork(adapter, marker, { rejoinMs: timings.rejoinMs, log: env.log }, secrets);
      if (out.ok) {
        await clearMarker(env.dataDir).catch((err: unknown) => env.log(`setup: could not remove the recovery marker: ${(err as Error).message}`));
        env.log("setup: this PC's Wi-Fi is back");
        return null;
      }
      marker.profiles = out.remaining;
      await saveMarker().catch(() => undefined);
      return new JobFailure("restore_failed", out.message, "leave_ap");
    })();
    return restoreOnce;
  };

  const wifiFailure = (err: unknown, step: string): JobFailure => {
    if (err instanceof JobFailure) return err;
    if (err instanceof WifiError) {
      if (err.kind === "aborted") return cancelled(step);
      if (err.kind === "unsupported") return new JobFailure("adapter_unsupported", scrub(err.message), step);
      if (err.kind === "auth") return new JobFailure("ap_password_wrong", scrub(err.message), step);
      return new JobFailure("adapter_failed", scrub(err.message), step);
    }
    throw err;
  };

  /** One look at the device through the Wi-Fi adapter; the client is only kept when asked to. */
  const look = async (): Promise<{ client: DeviceClient; status: DeviceStatus } | { error: DeviceError }> => {
    const ep = await adapter.endpoint(env.apAddress);
    const c = createDeviceClient({ host: ep.host, ...(ep.localAddress ? { localAddress: ep.localAddress } : {}) });
    try {
      const status = await race(c.status({ timeoutMs: timings.probeMs }));
      return { client: c, status };
    } catch (err) {
      c.destroy();
      if (err instanceof DeviceError) return { error: err };
      throw err;
    }
  };

  const joinAp = async (profile: string, step: string): Promise<void> => {
    try {
      await adapter.connect(profile, apSsid, { timeoutMs: timings.joinMs, signal });
    } catch (err) {
      if (err instanceof WifiError && err.kind === "auth") {
        throw new JobFailure("ap_password_wrong", req.apPassword ? "The setup Wi-Fi password was not accepted." : "The setup Wi-Fi needs a password. Enter it and try again.", step);
      }
      if (err instanceof WifiError && err.kind !== "aborted" && err.kind !== "unsupported") {
        throw await diagnoseJoin(err, step);
      }
      throw wifiFailure(err, step);
    }
  };

  /** Why did joining fail? Look at the networks that are visible now. */
  const diagnoseJoin = async (err: WifiError, step: string): Promise<JobFailure> => {
    let visible: { secured: boolean } | null | undefined;
    try {
      const nets = await adapter.scan();
      visible = nets.find((n) => n.ssid.toLowerCase() === apSsid.toLowerCase()) ?? null;
    } catch {
      visible = undefined;
    }
    if (err.kind === "not_found" || visible === null) {
      return new JobFailure("ap_not_found", `The device's setup Wi-Fi "${apSsid}" is no longer visible. Move closer, check that the device is powered and in setup mode, then try again.`, step);
    }
    if (visible?.secured === true) {
      return new JobFailure(
        "ap_password_wrong",
        req.apPassword ? "The setup Wi-Fi password was not accepted." : "The setup Wi-Fi needs a password. Enter it and try again.",
        step,
      );
    }
    return new JobFailure("ap_not_found", `This PC could not join the device's setup Wi-Fi "${apSsid}". ${scrub(err.message)}`, step);
  };

  const newProfileName = (): string => `${TEMP_PROFILE_PREFIX}${randomBytes(4).toString("hex")}`;

  const addProfile = async (password: string | undefined, step: string): Promise<string> => {
    if (!marker) throw new Error("setup marker missing");
    const name = newProfileName();
    marker.profiles.push(name); // listed BEFORE it exists, so a crash leaves a record
    await saveMarker();
    try {
      await adapter.addTempProfile(apSsid, password, name);
    } catch (err) {
      throw wifiFailure(err, step);
    }
    return name;
  };

  let failure: unknown = null;
  let leftOwnNetwork = false; // the PC started joining the setup Wi-Fi, so it has to be brought back
  let leaveStepFinal = false; // the leave_ap step already ended in the normal path
  try {
    // ---- remember --------------------------------------------------------------------------------------------------
    begin("remember");
    ctl.message("Remembering this PC's Wi-Fi network");
    let info;
    try {
      info = await adapter.info();
    } catch (err) {
      throw wifiFailure(err, "remember");
    }
    if (!info.supported) throw new JobFailure("adapter_unsupported", info.reason ?? "SoftAP setup is not available on this PC.", "remember");
    let current;
    try {
      current = await adapter.current();
    } catch (err) {
      throw wifiFailure(err, "remember");
    }
    // A PC that is already on a setup Wi-Fi has no "own" network worth returning to.
    const originalSsid = current.ssid !== null && SETUP_SSID_RE.test(current.ssid) ? null : current.ssid;
    marker = {
      v: 1,
      jobId: ctl.id,
      startedAt: new Date().toISOString(),
      originalSsid,
      originalProfile: originalSsid === null ? null : current.profile,
      profiles: [],
    };
    await saveMarker();
    done("remember", originalSsid ? `Now on "${originalSsid}"` : "Not connected to a Wi-Fi network");

    // ---- join_ap ---------------------------------------------------------------------------------------------------
    begin("join_ap", apSsid);
    ctl.message(`Joining ${apSsid} (this PC leaves your network for a moment)`);
    leftOwnNetwork = true;
    const apProfile = await addProfile(req.apPassword, "join_ap");
    await joinAp(apProfile, "join_ap");
    env.log(`setup: joined ${apSsid}`);
    done("join_ap", apSsid);

    // ---- fingerprint -----------------------------------------------------------------------------------------------
    begin("fingerprint");
    ctl.message("Checking that this is one of your devices");
    const deadline = Date.now() + timings.apReachMs;
    let found: { client: DeviceClient; status: DeviceStatus } | null = null;
    for (;;) {
      let seen;
      try {
        seen = await look();
      } catch (err) {
        throw wifiFailure(err, "fingerprint");
      }
      if ("client" in seen) {
        found = seen;
        break;
      }
      if (FOREIGN_KINDS.has(seen.error.kind)) {
        throw new JobFailure("not_our_device", "This Wi-Fi does not belong to a de-esp32 device, so nothing was sent to it.", "fingerprint");
      }
      if (Date.now() >= deadline) {
        throw new JobFailure(
          "device_not_responding",
          `This PC joined ${apSsid}, but the device did not answer at ${env.apAddress}. Unplug it, plug it in again and wait a few seconds, then try again.`,
          "fingerprint",
        );
      }
      await wait(timings.pollMs);
    }
    client = found.client;
    let status = found.status;
    if (!isOurs(status)) throw new JobFailure("not_our_device", "This Wi-Fi does not belong to a de-esp32 device, so nothing was sent to it.", "fingerprint");
    if (req.deviceId !== undefined && status.id.toLowerCase() !== req.deviceId) {
      throw new JobFailure(
        "not_our_device",
        `This setup Wi-Fi belongs to a different device (${status.id}), not the one you wanted to recover (${req.deviceId}). Nothing was changed on it.`,
        "fingerprint",
      );
    }
    const device: DeviceInfoLike = { id: status.id.toLowerCase(), name: status.name, hostname: status.hostname };
    ctl.device(device.id, { name: device.name, state: "running", step: "fingerprint" });
    done("fingerprint", `${device.name} (${device.id})`);

    // ---- scan + choose ---------------------------------------------------------------------------------------------
    let choice: WifiChoice;
    if (req.wifi) {
      choice = { ssid: req.wifi.ssid, ...(req.wifi.password ? { password: req.wifi.password } : {}), factoryResetFirst: req.factoryResetFirst };
      ctl.step("scan", "skipped");
      ctl.step("choose", "skipped");
    } else {
      begin("scan");
      ctl.message("Asking the device which networks it can see");
      let networks: SetupChooseResult["networks"] = [];
      try {
        const aps = await race(client.getJson<AccessPoint[]>("/network/scan", { timeoutMs: 15_000 }));
        const best = new Map<string, SetupChooseResult["networks"][number]>();
        for (const a of Array.isArray(aps) ? aps : []) {
          if (typeof a.ssid !== "string" || a.ssid === "") continue;
          const prev = best.get(a.ssid);
          if (!prev || a.rssi > prev.rssi) best.set(a.ssid, { ssid: a.ssid, rssi: a.rssi, secure: a.auth !== 0 });
        }
        networks = [...best.values()].sort((a, b) => b.rssi - a.rssi);
        done("scan", `${networks.length} network${networks.length === 1 ? "" : "s"} found`);
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        done("scan", "The device could not list networks; type the name instead");
      }
      begin("choose");
      ctl.result({
        networks,
        device: { id: device.id, name: device.name, fw: status.fw, app_version: status.ota?.app_version ?? "" },
      } satisfies SetupChooseResult);
      ctl.message("Choose the network for the device");
      choice = await gate.wait(timings.chooseTimeoutMs, signal);
      addSecret(choice.password);
      done("choose", choice.ssid);
    }
    const wifiSsid = choice.ssid;
    const wifiPassword = choice.password ?? "";

    // ---- factory_reset ---------------------------------------------------------------------------------------------
    if (choice.factoryResetFirst === true) {
      begin("factory_reset");
      ctl.message("Erasing the device's saved settings");
      const before = { boot: status.boot_count, uptime: status.uptime_s };
      let reply: DeviceEnvelope<unknown>;
      try {
        reply = await race(client.command({ cmd: "system.factory_reset" }));
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        throw new JobFailure("device_not_responding", "The device did not answer the factory reset.", "factory_reset");
      }
      if (!reply.ok) throw new JobFailure("factory_reset_failed", `The device refused the factory reset: ${reply.error}`, "factory_reset");
      client.destroy();
      client = null;
      // The reset also removes the setup Wi-Fi password: after it the device is open.
      const openProfile = await addProfile(undefined, "factory_reset");
      /** Profiles to use when rejoining the setup Wi-Fi, best first. */
      const apProfiles = [openProfile, apProfile];
      ctl.message("Waiting for the device to restart");
      const resetDeadline = Date.now() + timings.factoryResetWaitMs;
      let gone = false;
      let back: { client: DeviceClient; status: DeviceStatus } | null = null;
      while (!back) {
        let seen;
        try {
          seen = await look();
        } catch {
          seen = null;
        }
        if (seen && "client" in seen) {
          if (gone || seen.status.boot_count > before.boot || seen.status.uptime_s < before.uptime) back = seen;
          else seen.client.destroy();
        } else {
          gone = true;
        }
        if (back) break;
        if (Date.now() >= resetDeadline) {
          throw new JobFailure("device_not_responding", "The device did not come back on its setup Wi-Fi after the factory reset. Unplug it, plug it in again and try again.", "factory_reset");
        }
        // The PC's connection to the setup Wi-Fi dropped when the device restarted and does not come back on its own.
        if (gone) {
          const now = await adapter.current().catch(() => ({ ssid: null, profile: null }));
          if (now.ssid !== apSsid) {
            for (const p of apProfiles) {
              try {
                await adapter.connect(p, apSsid, { timeoutMs: Math.min(timings.joinMs, 8_000), signal });
                break;
              } catch (err) {
                if (err instanceof WifiError && err.kind === "aborted") throw cancelled("factory_reset");
              }
            }
          }
        }
        await wait(timings.pollMs);
      }
      client = back.client;
      status = back.status;
      if (status.id.toLowerCase() !== device.id) {
        throw new JobFailure("not_our_device", "A different device answered after the factory reset. Nothing was sent to it.", "factory_reset");
      }
      done("factory_reset");
    } else {
      ctl.step("factory_reset", "skipped");
    }

    // ---- send_wifi -------------------------------------------------------------------------------------------------
    begin("send_wifi", wifiSsid);
    ctl.message(`Sending the Wi-Fi details for "${wifiSsid}" to the device`);
    ctl.device(device.id, { step: "send_wifi" });
    const net0 = status.network as NetworkStatus | undefined;
    const hasWifiChange = net0?.wifi_change !== undefined;
    const seqBefore = net0?.wifi_change?.seq ?? 0;
    let reply: DeviceEnvelope<NetworkStatus> | null = null;
    try {
      reply = await race(client.postJson<DeviceEnvelope<NetworkStatus>>("/network/wifi", { ssid: wifiSsid, password: wifiPassword }, { timeoutMs: WIFI_TIMEOUT_MS }));
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err;
      if (err.kind === "http_status" || err.kind === "body_too_large") {
        throw new JobFailure("wifi_failed", "The device rejected the Wi-Fi details. Check the network name and password for unusual characters and try again.", "send_wifi");
      }
      reply = null; // connection dropped: the device may be switching networks; ask it below
    }
    done("send_wifi");

    // ---- check_result ----------------------------------------------------------------------------------------------
    begin("check_result");
    ctl.message("Waiting for the device to say whether it joined");
    const fail = (reason: WifiChangeReason | undefined): JobFailure => {
      if (reason === undefined) {
        return new JobFailure("wifi_failed", `The device could not join "${wifiSsid}". The most likely reason is a wrong password; check it and try again.`, "check_result");
      }
      const f = REASON_FAILURES[reason];
      return new JobFailure(f.code, f.text(wifiSsid), "check_result");
    };
    const reported = (n: NetworkStatus | undefined): "ok" | "failed" | "testing" | null => {
      const wc = n?.wifi_change;
      if (!wc || (wc.seq ?? 0) <= seqBefore) return null;
      return wc.result === "ok" ? "ok" : wc.result === "failed" ? "failed" : wc.result === "testing" ? "testing" : null;
    };
    type Verdict = { kind: "ok" } | { kind: "failed"; reason: WifiChangeReason | undefined } | { kind: "gone" } | { kind: "none" };
    /** Ask the device until it says whether it joined, stops answering on its setup Wi-Fi, or the time is up. */
    const pollVerdict = async (timeoutMs: number): Promise<Verdict> => {
      const end = Date.now() + timeoutMs;
      let unreachable = 0;
      for (;;) {
        let st: DeviceStatus | null = null;
        try {
          const seen = await look();
          if ("client" in seen) {
            seen.client.destroy();
            st = seen.status;
          }
        } catch (err) {
          throw wifiFailure(err, "check_result");
        }
        if (st) {
          unreachable = 0;
          const net = st.network as NetworkStatus | undefined;
          const r = reported(net);
          if (r === "ok") return { kind: "ok" };
          if (r === "failed") return { kind: "failed", reason: net?.wifi_change?.reason };
          // Older firmware has no wifi_change: it only saves and connects when its own test passed.
          if (!hasWifiChange && net?.sta_connected === true && net.sta_ip) return { kind: "ok" };
        } else if (++unreachable >= 3) {
          return { kind: "gone" }; // it most likely left the setup Wi-Fi for your network; the LAN step checks
        }
        if (Date.now() >= end) return { kind: "none" };
        await wait(timings.pollMs);
      }
    };
    let joinedNote = "The device joined the network";
    if (reply?.ok === true) {
      const wc = reply.result?.wifi_change;
      if (wc && (wc.seq ?? 0) > seqBefore && wc.result === "failed") throw fail(wc.reason);
    } else if (reply?.ok === false) {
      let reason: WifiChangeReason | undefined;
      if (hasWifiChange) {
        const v = await pollVerdict(Math.min(timings.wifiResultMs, 8_000));
        if (v.kind === "failed") reason = v.reason;
      }
      throw fail(reason);
    } else {
      const v = await pollVerdict(timings.wifiResultMs);
      if (v.kind === "failed") throw fail(v.reason);
      if (v.kind === "none") {
        throw new JobFailure("wifi_failed", `The device did not say whether it joined "${wifiSsid}". Check the network name and password and try again.`, "check_result");
      }
      if (v.kind === "gone") joinedNote = "The device left its setup Wi-Fi";
    }
    done("check_result", joinedNote);
    client.destroy();
    client = null;

    // ---- leave_ap --------------------------------------------------------------------------------------------------
    begin("leave_ap");
    ctl.message("Putting this PC back on its own Wi-Fi");
    const restoreFailure = await ensureRestored();
    if (restoreFailure) throw restoreFailure;
    leaveStepFinal = true;
    done("leave_ap", originalSsid ? `Back on "${originalSsid}"` : undefined);

    // ---- wait_lan --------------------------------------------------------------------------------------------------
    begin("wait_lan");
    ctl.message("Looking for the device on your network");
    const hit = await app.discovery.waitForDevice(device.id, {
      timeoutMs: timings.lanWaitMs,
      signal,
      intervalMs: Math.max(100, timings.pollMs),
      targets: adapter.lanTargets(apSsid),
    });
    if (signal.aborted) throw cancelled("wait_lan");
    if (!hit) {
      const seconds = Math.max(1, Math.round(timings.lanWaitMs / 1000));
      throw new JobFailure(
        "device_not_on_lan",
        `The device joined "${wifiSsid}" but did not appear on your network within ${seconds} s.` +
          (app.networkScan
            ? " Check that this PC and the device are on the same network, then add it from Discover."
            : " Network scanning is turned off on this Manager (--no-network-scan), so only addresses it already knows were checked; add the device by its address."),
        "wait_lan",
      );
    }
    done("wait_lan", hit.host);

    // ---- add -------------------------------------------------------------------------------------------------------
    begin("add");
    const name = hit.status.name || hit.status.hostname || device.name;
    const { created } = app.registry.upsert({ id: device.id, host: hit.host, hostname: hit.status.hostname || device.hostname, name, addedVia: "manual" });
    app.registry.unignore(device.id);
    await app.health.pollNow(device.id);
    ctl.device(device.id, { state: "done", step: "add", name });
    const result: SetupJobResult = { deviceId: device.id, host: hit.host, name, added: created };
    ctl.result(result);
    ctl.message(created ? `${name} was added to your devices` : `${name} is back on your network`);
    done("add", name);
  } catch (err) {
    failure = err;
  } finally {
    client?.destroy();
  }

  // Always, whatever happened above: failure, cancel or shutdown. Never skipped.
  const restoreProblem = await ensureRestored();
  // The restore ran after a cancel or a failure: say so on the step instead of leaving it cancelled/skipped.
  if (!leaveStepFinal && marker) {
    if (restoreProblem) ctl.step("leave_ap", { status: "failed", detail: "This PC could not be put back on its Wi-Fi" });
    else if (leftOwnNetwork) done("leave_ap", marker.originalSsid ? `Back on "${marker.originalSsid}"` : undefined);
  }
  if (restoreProblem) {
    const original = failure instanceof JobFailure && failure.code !== "cancelled" && failure.code !== "restore_failed" ? ` (The setup itself also stopped: ${failure.message})` : "";
    if (signal.aborted) {
      ctl.fail({ code: restoreProblem.code, message: restoreProblem.message, ...(restoreProblem.step ? { step: restoreProblem.step } : {}) });
      return;
    }
    throw new JobFailure(restoreProblem.code, restoreProblem.message + original, restoreProblem.step);
  }
  if (failure) throw failure;
}
