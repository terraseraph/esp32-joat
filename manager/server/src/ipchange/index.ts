import type { AppContext } from "../appContext";
import { callDevice, requireDevice } from "../api/deviceCall";
import { createDeviceClient, DeviceError } from "../device/client";
import { formatHostAddr, parseHostInput, splitStoredHost } from "../device/hostAddr";
import { localInterfaces, probeStatus, type IfaceAddr } from "../discovery/sweep";
import { HttpError } from "../http/errors";
import { JobFailure, type JobControl } from "../jobs";
import { isLoopbackHost } from "../net";
import type { RegistryDevice } from "../store/registry";
import type { IpChangeBody, IpCheckResult, IpFieldError, IpJobResult, IpMode, IpSettings } from "../types/api-ip";
import type { Job } from "../types/api-jobs";
import type { DeviceStatus, IpChange, NetworkStatus } from "../types/device-api";
import { ipWarnings, validateIpChange, type StaticConfig } from "./validate";

export { validateIpChange, ipWarnings, parseIp4 } from "./validate";

/**
 * IP address change feature (batch 3, spec 3.12). `start()` creates it and closes it on shutdown. The three calls
 * (`settings`, `check`, `start`) are used by `api/ip.ts`; the change itself is a job of kind `ip-change`.
 *
 * Reaching the device at its new address: fakes in tests live on 127.0.0.1 and cannot move, so when the stored host is a
 * loopback address the device is reached at that same host:port, and `hostMap` (CLI `--ip-change-map`) can point a new
 * address somewhere else (for example a closed port, to see the revert path). See API.md "Testing without moving a device".
 */

/** `StartOptions.ipChange`. Every time is in milliseconds; tests use small values. */
export interface IpChangeConfig {
  /** The Manager PC's IPv4 interfaces (default: the machine's). An empty list means no "outside your networks" warning. */
  interfaces?: () => IfaceAddr[];
  /** The device's confirm window (firmware: 90000). The Manager gives up confirming a little before it ends. */
  confirmWindowMs?: number;
  /** Wait after the device answered `network.ip.set` before looking for it (firmware applies after about 1500). */
  applyDelayMs?: number;
  /** Pause between probes (default 1000). */
  probeIntervalMs?: number;
  /** Timeout of one probe (default 1500). */
  probeTimeoutMs?: number;
  /** Extra time to keep watching the OLD address after the confirm window closed, before ending `not_reachable` (default 10000). */
  revertMarginMs?: number;
  /** How long to look for the device at a new static address before giving up (default 20000). */
  reachTimeoutMs?: number;
  /** How long to look for the device after switching to DHCP (default 60000). */
  dhcpTimeoutMs?: number;
  /** Where to look for the device after it moved to `newIp` (stored form `ip` or `ip:port`). Default: see `defaultResolveHost`. */
  resolveHost?: (newIp: string, currentHost: string) => string;
  /** Fixed `new ip -> host[:port]` lookups, checked before `resolveHost` (CLI `--ip-change-map`). */
  hostMap?: Record<string, string>;
}

export interface IpChangeFeature {
  /** Current address settings. Throws `HttpError` 404; a `DeviceError` when the device cannot be reached. */
  settings(id: string): Promise<IpSettings>;
  /** Dry run. */
  check(id: string, body: IpChangeBody): Promise<IpCheckResult>;
  /** Validate, send the change to the device and start the job. Throws `HttpError` 404/409/422; a `DeviceError` for transport problems. */
  start(id: string, body: IpChangeBody): Promise<Job>;
  close(): Promise<void>;
}

const CONFIRM_MARGIN_MS = 2000;

/**
 * Default place to look for a device after it moved to `newIp`: the new address with the current port. A loopback host
 * (a fake device) cannot move, so it stays where it is.
 */
export function defaultResolveHost(newIp: string, currentHost: string): string {
  const cur = splitStoredHost(currentHost);
  if (isLoopbackHost(cur.hostname)) return currentHost;
  return formatHostAddr({ host: newIp, port: cur.port, isIp: true });
}

const titleOf = (d: RegistryDevice): string => d.label || d.name || d.hostname || d.id;

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

const ipChangeOf = (st: DeviceStatus | null | undefined): IpChange | undefined => st?.network?.ip_change;

/** Turn the device's refusal text (the README lists the conditions, not the words) into a plain HTTP error. */
export function refusalFor(text: string): HttpError {
  const t = text.trim();
  const field = /^(ip|netmask|gateway|dns)\b/i.exec(t)?.[1]?.toLowerCase() as IpFieldError["field"] | undefined;
  if (/must|overlap|contiguous/i.test(t) && (field || /^subnet/i.test(t))) {
    const errors: IpFieldError[] = [{ field: field ?? "ip", message: `The device does not accept these settings: ${t}.` }];
    return new HttpError(422, "invalid_ip_config", errors[0]?.message ?? "The device does not accept these settings.", errors);
  }
  let message: string;
  if (/no saved wi-?fi/i.test(t)) message = "This device has no saved Wi-Fi network yet, so there is no address to change. Set up its Wi-Fi first.";
  else if (/wi-?fi.*(progress|test)/i.test(t)) message = "The device is testing a Wi-Fi change right now. Try again in a moment.";
  else if (/already pending|pending/i.test(t)) message = "An address change is already waiting for confirmation on this device. Wait for it to finish (up to 90 seconds) and try again.";
  else if (/not connected/i.test(t)) message = "The device is not connected to Wi-Fi right now, so it cannot take a fixed address.";
  else message = `The device refused the change${t ? `: ${t}` : "."}`;
  return new HttpError(409, "ip_change_refused", message);
}

export async function createIpChangeFeature(app: AppContext, config: IpChangeConfig = {}): Promise<IpChangeFeature> {
  const interfaces = config.interfaces ?? localInterfaces;
  const windowMs = config.confirmWindowMs ?? 90_000;
  const applyDelayMs = config.applyDelayMs ?? 1500;
  const probeIntervalMs = config.probeIntervalMs ?? 1000;
  const probeTimeoutMs = config.probeTimeoutMs ?? 1500;
  const reachTimeoutMs = config.reachTimeoutMs ?? 20_000;
  const revertMarginMs = config.revertMarginMs ?? 10_000;
  const dhcpTimeoutMs = config.dhcpTimeoutMs ?? 60_000;
  const resolveHost = config.resolveHost ?? defaultResolveHost;
  const hostMap = config.hostMap ?? {};
  /** Devices whose start request is in flight (between the check for a running job and the job existing). */
  const starting = new Set<string>();

  const activeJob = (id: string): Job | undefined => app.jobs.list({ kind: "ip-change", active: true }).find((j) => j.deviceIds.includes(id));

  const targetFor = (newIp: string, currentHost: string): string => {
    const mapped = hostMap[newIp];
    const raw = mapped ?? resolveHost(newIp, currentHost);
    return formatHostAddr(parseHostInput(raw));
  };

  const readStatus = (dev: RegistryDevice): Promise<DeviceStatus> => app.pool.forDevice(dev.id, dev.host).status();

  const unsupportedReason = "This device's firmware cannot change its IP address yet. Update its firmware first.";

  async function settings(id: string): Promise<IpSettings> {
    const dev = requireDevice(app, id);
    const net: Partial<NetworkStatus> = (await readStatus(dev)).network ?? {};
    const mode = net.ip_mode;
    const supported = mode !== undefined;
    return {
      supported,
      reason: supported ? null : unsupportedReason,
      ipMode: !supported ? null : mode === "dhcp" || mode === "static" ? mode : "unknown",
      ip: net.sta_ip ?? "",
      netmask: net.netmask ?? "",
      gateway: net.gateway ?? "",
      dns: net.dns ?? "",
      staConnected: Boolean(net.sta_connected),
      ipChange: net.ip_change ? { ...net.ip_change } : null,
      activeJobId: activeJob(id)?.id ?? null,
    };
  }

  async function check(id: string, body: IpChangeBody): Promise<IpCheckResult> {
    const dev = requireDevice(app, id);
    const v = validateIpChange(body);
    const errors: IpFieldError[] = [...v.errors];
    let net: NetworkStatus | undefined;
    try {
      net = (await readStatus(dev)).network;
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err; // unreachable device: the rules still apply, the rest is skipped
    }
    if (net) {
      if (net.ip_mode === undefined) errors.push({ field: "mode", message: unsupportedReason });
      else if (net.ip_change?.result === "pending") errors.push({ field: "mode", message: "An address change is already waiting for confirmation on this device. Wait for it to finish and try again." });
      else if (body.mode === "static" && !net.sta_connected) errors.push({ field: "mode", message: "The device is not connected to Wi-Fi right now, so it cannot take a fixed address." });
    }
    if (errors.length > 0) return { ok: false, errors, warnings: [] };
    const others = app.registry.list().filter((d) => d.id !== dev.id).map((d) => ({ name: titleOf(d), host: d.host }));
    const warnings = ipWarnings({
      body,
      interfaces: interfaces(),
      others,
      ...(net?.ip_mode ? { current: { mode: net.ip_mode, ip: net.sta_ip, netmask: net.netmask ?? "", gateway: net.gateway ?? "", dns: net.dns ?? "" } } : {}),
    });
    return { ok: true, errors: [], warnings };
  }

  async function start(id: string, body: IpChangeBody): Promise<Job> {
    const dev = requireDevice(app, id);
    if (starting.has(id) || activeJob(id)) {
      throw new HttpError(409, "ip_change_running", "An address change for this device is already running. Wait for it to finish, or cancel it first.");
    }
    const v = validateIpChange(body);
    if (v.errors.length > 0) throw new HttpError(422, "invalid_ip_config", v.errors[0]?.message ?? "These settings are not valid.", v.errors);
    starting.add(id);
    try {
      const net = (await readStatus(dev)).network;
      if (net?.ip_mode === undefined) throw new HttpError(409, "ip_change_unsupported", unsupportedReason);
      const cmd =
        body.mode === "dhcp"
          ? { cmd: "network.ip.set", mode: "dhcp" }
          : { cmd: "network.ip.set", mode: "static", ip: body.ip, netmask: body.netmask, gateway: body.gateway, dns: v.config?.dns ?? body.gateway };
      const res = await callDevice(app, dev, "POST", "/command", { json: cmd });
      const env = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; error?: unknown; result?: unknown }) : undefined;
      if (!(res.status >= 200 && res.status < 300 && env?.ok === true)) {
        throw refusalFor(typeof env?.error === "string" ? env.error : `the device answered with status ${res.status}`);
      }
      const reply = (env.result as Partial<NetworkStatus> | undefined)?.ip_change;
      const mode: IpMode = body.mode;
      const job = app.jobs.create(
        {
          kind: "ip-change",
          title: mode === "static" ? `Set a fixed address (${body.mode === "static" ? body.ip : ""}) on ${titleOf(dev)}` : `Switch ${titleOf(dev)} to an automatic address (DHCP)`,
          deviceIds: [dev.id],
          devices: [{ deviceId: dev.id, name: titleOf(dev) }],
          params: { mode, ...(body.mode === "static" ? { ip: body.ip, netmask: body.netmask, gateway: body.gateway, dns: v.config?.dns ?? body.gateway } : {}) },
          steps: [
            { id: "check", label: "Check the device" },
            { id: "send", label: "Send the new settings" },
            { id: "apply", label: "Device applies them" },
            { id: "reach", label: "Reach it at the new address" },
            { id: "confirm", label: "Confirm (keeps the change)" },
            { id: "save", label: "Update the Manager's address" },
          ],
          supports: { retry: true },
          onRetry: () => start(id, body),
        },
        (ctl) => runChange(ctl, dev, mode, v.config, reply),
      );
      return job;
    } finally {
      starting.delete(id);
    }
  }

  // ---- the job ------------------------------------------------------------------------------------------------------

  function finishResult(ctl: JobControl, r: IpJobResult): void {
    ctl.result(r);
  }

  async function savedHost(ctl: JobControl, dev: RegistryDevice, host: string): Promise<void> {
    ctl.step("save", { status: "running" });
    if (app.registry.get(dev.id)?.host !== host) app.registry.update(dev.id, { host });
    try {
      await app.health.pollNow(dev.id);
    } catch {
      /* the next poll will tell */
    }
    ctl.step("save", { status: "done", detail: host });
  }

  async function runChange(ctl: JobControl, dev: RegistryDevice, mode: IpMode, cfg: StaticConfig | undefined, reply: IpChange | undefined): Promise<void> {
    const sentAt = Date.now();
    ctl.device(dev.id, { state: "running" });
    ctl.step("check", "done");
    ctl.step("send", { status: "done", detail: "The device accepted them." });
    const stored = (): string => app.registry.get(dev.id)?.host ?? dev.host;
    const cancelled = (note: string): void => {
      ctl.message(note);
      finishResult(ctl, { outcome: mode === "static" ? "failed" : "unknown", reason: note, host: stored(), ipMode: mode });
    };
    const keepBack = "Cancelled. If the device already applied the change it goes back to its previous setting by itself within 90 seconds.";

    // DHCP while the device is offline: saved at once, nothing to apply.
    if (mode === "dhcp" && reply?.result === "ok") {
      for (const s of ["apply", "reach", "confirm"]) ctl.step(s, { status: "skipped" });
      await savedHost(ctl, dev, stored());
      ctl.device(dev.id, { state: "done" });
      finishResult(ctl, { outcome: "ok", reason: null, host: stored(), ipMode: "dhcp" });
      return;
    }

    ctl.step("apply", { status: "running", detail: "The device switches about a second and a half after it answers." });
    await sleep(applyDelayMs, ctl.signal);
    if (ctl.signal.aborted) return cancelled(keepBack);
    ctl.step("apply", "done");

    if (mode === "dhcp") return runDhcp(ctl, dev, cancelled, keepBack);
    if (!cfg) throw new JobFailure("internal_error", "Something went wrong inside the Manager.");
    return runStatic(ctl, dev, cfg, reply, sentAt, cancelled, keepBack);
  }

  async function runStatic(ctl: JobControl, dev: RegistryDevice, cfg: StaticConfig, reply: IpChange | undefined, sentAt: number, cancelled: (n: string) => void, keepBack: string): Promise<void> {
    const seq = reply?.seq;
    const appliedAt = Date.now();
    const stored = (): string => app.registry.get(dev.id)?.host ?? dev.host;
    const target = targetFor(cfg.ip, dev.host);
    const t = splitStoredHost(target);
    ctl.step("reach", { status: "running", detail: `Looking for it at ${target}` });
    let status: DeviceStatus | null = null;
    let otherDevice = false;
    while (!ctl.signal.aborted) {
      const st = await probeStatus(t.hostname, t.port, { timeoutMs: probeTimeoutMs, signal: ctl.signal });
      if (st && typeof st.id === "string" && st.id.toLowerCase() === dev.id) {
        status = st;
        break;
      }
      otherDevice = otherDevice || st !== null;
      if (Date.now() - appliedAt >= reachTimeoutMs) break;
      await sleep(probeIntervalMs, ctl.signal);
    }
    if (ctl.signal.aborted) return cancelled(keepBack);
    if (!status) {
      const why = otherDevice ? `Something answered at ${cfg.ip}, but it is not this device.` : `The Manager could not reach the device at ${cfg.ip}.`;
      ctl.step("reach", { status: "failed", detail: why });
      return waitForRevert(ctl, dev, cfg.ip, reply, sentAt);
    }
    ctl.step("reach", { status: "done", detail: `Found it at ${target}` });

    const deadline = appliedAt + windowMs - CONFIRM_MARGIN_MS;
    const revertedNow = (st: DeviceStatus | null): boolean => ipChangeOf(st)?.result === "reverted";
    const failReverted = (st: DeviceStatus | null): never => {
      const reason = "The device went back to its previous setting because it was not confirmed in time.";
      ctl.step("confirm", { status: "failed", detail: reason });
      ctl.device(dev.id, { state: "reverted", message: reason });
      finishResult(ctl, { outcome: "reverted", reason, host: stored(), ipMode: "static" });
      void st;
      throw new JobFailure("reverted", reason, "confirm");
    };
    ctl.step("confirm", { status: "running" });
    const client = createDeviceClient({ host: target });
    try {
      let st: DeviceStatus | null = status;
      let confirmed = ipChangeOf(st)?.result === "ok";
      while (!confirmed) {
        if (ctl.signal.aborted) return cancelled(keepBack);
        if (revertedNow(st)) failReverted(st);
        const left = ipChangeOf(st)?.confirm_left_s ?? Math.max(0, Math.ceil((deadline + CONFIRM_MARGIN_MS - Date.now()) / 1000));
        ctl.step("confirm", { detail: `${left} seconds left to confirm` });
        try {
          const env = await client.command({ cmd: "network.ip.confirm", ...(seq !== undefined ? { seq } : {}) });
          if (env.ok) {
            confirmed = true;
            break;
          }
          st = await probeStatus(t.hostname, t.port, { timeoutMs: probeTimeoutMs, signal: ctl.signal });
          if (revertedNow(st)) failReverted(st);
          const msg = `The device did not accept the confirmation${typeof env.error === "string" ? `: ${env.error}` : ""}.`;
          ctl.step("confirm", { status: "failed", detail: msg });
          finishResult(ctl, { outcome: "failed", reason: msg, host: stored(), ipMode: "static" });
          throw new JobFailure("confirm_refused", msg, "confirm");
        } catch (err) {
          if (!(err instanceof DeviceError)) throw err;
          if (Date.now() >= deadline) {
            const reason = `The device answered at ${cfg.ip} but stopped answering before the change was confirmed. It may go back to its previous setting. The Manager's address is unchanged; run a scan to find the device again.`;
            ctl.step("confirm", { status: "failed", detail: "No answer while confirming" });
            ctl.device(dev.id, { state: "failed", message: reason });
            finishResult(ctl, { outcome: "unknown", reason, host: stored(), ipMode: "static" });
            throw new JobFailure("lost_device", reason, "confirm");
          }
          await sleep(probeIntervalMs, ctl.signal);
          st = await probeStatus(t.hostname, t.port, { timeoutMs: probeTimeoutMs, signal: ctl.signal });
        }
      }
    } finally {
      client.destroy();
    }
    ctl.step("confirm", { status: "done", detail: "Confirmed. The device keeps the new address." });
    await savedHost(ctl, dev, target);
    ctl.device(dev.id, { state: "done" });
    finishResult(ctl, { outcome: "ok", reason: null, host: target, ipMode: "static" });
  }

  /**
   * The device was not found at the new address, so it will go back to its previous setting on its own when the confirm
   * window closes. Say so, count down, and look at the OLD address until the device reports the revert (or the window
   * and a margin pass without a sign of it). The registry host is never touched here.
   */
  async function waitForRevert(ctl: JobControl, dev: RegistryDevice, newIp: string, reply: IpChange | undefined, sentAt: number): Promise<void> {
    const oldHost = app.registry.get(dev.id)?.host ?? dev.host;
    const o = splitStoredHost(oldHost);
    const windowEnd = sentAt + (typeof reply?.confirm_left_s === "number" ? reply.confirm_left_s * 1000 : windowMs);
    const giveUpAt = windowEnd + revertMarginMs;
    const label = "Waiting for the device to go back to its previous setting";
    ctl.step("revert", { label, status: "running" });
    let last: DeviceStatus | null = null;
    for (;;) {
      if (ctl.signal.aborted) break;
      const left = Math.max(0, Math.ceil((windowEnd - Date.now()) / 1000));
      ctl.step("revert", { detail: left > 0 ? `${left} ${left === 1 ? "second" : "seconds"} left. Checking ${oldHost}.` : `The time is up. Checking ${oldHost} for a little longer.` });
      const st = await probeStatus(o.hostname, o.port, { timeoutMs: probeTimeoutMs, signal: ctl.signal });
      if (st && typeof st.id === "string" && st.id.toLowerCase() === dev.id) {
        last = st;
        const r = ipChangeOf(st)?.result;
        if (r === "reverted" || r === "failed") break;
        if (Date.now() >= windowEnd && r !== "pending" && r !== "ok") break; // the record is gone: it went back (for example after a restart)
      } else last = null;
      if (Date.now() >= giveUpAt) break;
      await sleep(probeIntervalMs, ctl.signal);
    }
    if (ctl.signal.aborted) {
      const note = `Cancelled. The Manager stopped waiting. The device goes back to its previous setting by itself; if it does not show up at ${oldHost} afterwards, run a scan.`;
      ctl.step("revert", { status: "failed", detail: "Cancelled" });
      ctl.message(note);
      finishResult(ctl, { outcome: "unknown", reason: note, host: oldHost, ipMode: "static" });
      return;
    }
    const r = ipChangeOf(last)?.result;
    if (last && r !== "pending" && r !== "ok") {
      const net = last.network;
      const prevIp = net?.sta_ip || o.hostname;
      const prevMode = net?.ip_mode === "static" ? "static address" : "DHCP";
      const reason = `Could not reach the device at ${newIp}; it went back to ${prevIp} (${prevMode}) by itself. Nothing was changed.`;
      ctl.step("revert", { status: "done", detail: `Back at ${prevIp}` });
      ctl.device(dev.id, { state: "reverted", message: reason });
      finishResult(ctl, { outcome: "reverted", reason, host: oldHost, ipMode: net?.ip_mode === "static" ? "static" : "dhcp" });
      throw new JobFailure("reverted", reason, "revert");
    }
    const reason = `The Manager could not reach the device at ${newIp}, and it did not answer at its old address ${oldHost} either. It may still be at ${newIp} on a network this PC cannot reach, or it may be waiting in setup mode. Run a scan to look for it. If it does not show up, connect to the device’s own setup Wi-Fi to recover it. Nothing was changed in the Manager.`;
    ctl.step("revert", { status: "failed", detail: `No answer at ${oldHost}` });
    ctl.device(dev.id, { state: "failed", message: reason });
    finishResult(ctl, { outcome: "unknown", reason, host: oldHost, ipMode: "static" });
    throw new JobFailure("not_reachable", reason, "revert");
  }

  async function runDhcp(ctl: JobControl, dev: RegistryDevice, cancelled: (n: string) => void, keepBack: string): Promise<void> {
    const startedAt = Date.now();
    const stored = (): string => app.registry.get(dev.id)?.host ?? dev.host;
    ctl.step("reach", { status: "running", detail: "Looking for the device on your network" });
    let found: { host: string; status: DeviceStatus } | null = null;
    while (!ctl.signal.aborted) {
      const remaining = dhcpTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const hit = await app.discovery.waitForDevice(dev.id, { timeoutMs: remaining, signal: ctl.signal, intervalMs: probeIntervalMs });
      if (!hit) break;
      if (ipChangeOf(hit.status)?.result !== "pending") {
        found = hit;
        break;
      }
      await sleep(probeIntervalMs, ctl.signal); // still waiting for the lease
    }
    if (ctl.signal.aborted) return cancelled(keepBack.replace("goes back to its previous setting", "may go back to its previous setting"));
    if (!found) {
      const reason = "The Manager could not find the device after the switch. It may have a new address; run a scan to find it again. The Manager's address is unchanged.";
      ctl.step("reach", { status: "failed", detail: "Not found" });
      ctl.device(dev.id, { state: "failed", message: reason });
      finishResult(ctl, { outcome: "unknown", reason, host: stored(), ipMode: "dhcp" });
      throw new JobFailure("lost_device", reason, "reach");
    }
    const ic = ipChangeOf(found.status);
    if (ic?.result === "reverted" || ic?.result === "failed") {
      const noLease = ic.reason === "no_dhcp_lease";
      const reason = noLease
        ? "The device did not get an address from your router, so it kept its previous setting."
        : "The device went back to its previous setting.";
      ctl.step("reach", { status: "failed", detail: reason });
      ctl.device(dev.id, { state: "reverted", message: reason });
      finishResult(ctl, { outcome: noLease ? "no_dhcp_lease" : "reverted", reason, host: found.host, ipMode: "dhcp" });
      throw new JobFailure(noLease ? "no_dhcp_lease" : "reverted", reason, "reach");
    }
    ctl.step("reach", { status: "done", detail: `Found it at ${found.host}` });
    ctl.step("confirm", { status: "skipped", detail: "Not needed: switching to automatic confirms itself once the device has an address." });
    await savedHost(ctl, dev, found.host);
    ctl.device(dev.id, { state: "done" });
    finishResult(ctl, { outcome: "ok", reason: null, host: found.host, ipMode: "dhcp" });
  }

  return { settings, check, start, async close() {} };
}
