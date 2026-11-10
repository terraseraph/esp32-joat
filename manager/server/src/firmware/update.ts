import { createReadStream } from "node:fs";
import type { AppContext } from "../appContext";
import { callDevice } from "../api/deviceCall";
import { DeviceError } from "../device/client";
import type { FirmwareTargetInfo } from "../device/summary";
import type { RegistryDevice } from "../store/registry";
import type { JobError } from "../types/api-jobs";
import type { FirmwareImage, OtaDeviceResult, OtaStep } from "../types/api-firmware";
import type { DeviceStatus } from "../types/device-api";

/**
 * Pushing one image to one device, and checking that it took (spec 3.7). Shared by the single-device job, the rollback job
 * and the bulk job; nothing in here knows about jobs: progress is reported through a `Reporter`.
 */

/** All timings in ms; the defaults are the real ones, tests shrink them. */
export interface UpdateTimings {
  /** Time between `/status` polls while waiting for the restart (default 2000). */
  verifyPollMs: number;
  /** How long the device may take to restart and report itself (default 120000). */
  verifyTimeoutMs: number;
  /** How long `pending_verify` may last after the new image runs (default 60000). */
  pendingVerifyMs: number;
  /** Timeout of one `/status` call (default 4000). */
  statusTimeoutMs: number;
  /** Upload stalls longer than this fail (default 30000). */
  uploadIdleMs: number;
  /** Time the device gets to check the image after the last byte (default 60000). */
  uploadAnswerMs: number;
}

export const DEFAULT_TIMINGS: UpdateTimings = {
  verifyPollMs: 2000,
  verifyTimeoutMs: 120_000,
  pendingVerifyMs: 60_000,
  statusTimeoutMs: 4000,
  uploadIdleMs: 30_000,
  uploadAnswerMs: 60_000,
};

/** A refusal or failure with a plain message. `status` is the HTTP status the single-device routes answer it with. */
export class OtaProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly step?: OtaStep,
  ) {
    super(message);
    this.name = "OtaProblem";
  }
}

export interface Reporter {
  signal: AbortSignal;
  /** The device is now on this step (the previous one is done). */
  enter(step: OtaStep, message?: string): void;
  /** Upload progress 0..1. */
  progress(value: number): void;
  note(message: string): void;
}

export type OtaOutcome =
  | { state: "done"; result: OtaDeviceResult; message: string }
  | { state: "rolled_back"; error: JobError; message: string }
  | { state: "failed"; error: JobError; message: string }
  | { state: "cancelled"; message: string };

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const nameOf = (d: RegistryDevice): string => d.label || d.name || d.hostname || d.id;

export const targetOf = (i: FirmwareImage): FirmwareTargetInfo => ({ version: i.version, date: i.date, time: i.time });

export function createUpdater(app: AppContext, timings: UpdateTimings) {
  const client = (dev: RegistryDevice) => app.pool.forDevice(dev.id, dev.host);

  /** Fresh `/status`; a device that does not answer is `device_offline`. */
  async function readStatus(dev: RegistryDevice): Promise<DeviceStatus> {
    try {
      const s = await client(dev).status({ timeoutMs: timings.statusTimeoutMs });
      app.health.ingest(dev.id, s);
      return s;
    } catch (err) {
      if (err instanceof DeviceError) {
        throw new OtaProblem("device_offline", `${nameOf(dev)} did not answer, so nothing was sent. Check that it is powered and on the network, then try again.`, 409, "checking");
      }
      throw err;
    }
  }

  /** The refusals shared by the routes and the bulk job. Returns the fresh status. */
  async function precheck(dev: RegistryDevice, image?: FirmwareImage): Promise<DeviceStatus> {
    const s = await readStatus(dev);
    const o = s.ota;
    if (!o) throw new OtaProblem("ota_unavailable", `${nameOf(dev)} did not report its firmware state, so it cannot be updated from here.`, 409, "checking");
    if (o.busy || o.session === "writing" || o.session === "fetching") {
      throw new OtaProblem("ota_busy", `${nameOf(dev)} is already receiving a firmware image. Wait for it to finish.`, 409, "checking");
    }
    if (o.image_state === "pending_verify") {
      throw new OtaProblem(
        "pending_verify",
        `${nameOf(dev)} is still checking its current firmware (it has not confirmed it works yet). Wait a minute and try again, or roll it back.`,
        409,
        "checking",
      );
    }
    if (image && o.next_size > 0 && image.size > o.next_size) {
      throw new OtaProblem(
        "image_too_large",
        `This firmware (${image.size} bytes) is bigger than the space ${nameOf(dev)} has for it (${o.next_size} bytes).`,
        422,
        "checking",
      );
    }
    return s;
  }

  interface Before {
    version: string;
    partition: string;
    uptime: number | undefined;
    sawRebootingSession: boolean;
  }

  /** Poll until the device shows it restarted (or time runs out). */
  async function awaitRestart(dev: RegistryDevice, before: Before, signal: AbortSignal): Promise<{ status: DeviceStatus } | { timeout: "offline" | "norestart" } | { cancelled: true }> {
    const end = Date.now() + timings.verifyTimeoutMs;
    let sawDown = false;
    for (;;) {
      await sleep(timings.verifyPollMs, signal);
      if (signal.aborted) return { cancelled: true };
      let s: DeviceStatus;
      try {
        s = await client(dev).status({ timeoutMs: timings.statusTimeoutMs });
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        sawDown = true;
        if (Date.now() > end) return { timeout: "offline" };
        continue;
      }
      const o = s.ota;
      const restarted =
        sawDown ||
        (typeof s.uptime_s === "number" && before.uptime !== undefined && s.uptime_s < before.uptime) ||
        (before.sawRebootingSession && o?.session !== "rebooting") ||
        (before.partition !== "" && o?.running_partition !== undefined && o.running_partition !== before.partition);
      if (restarted) return { status: s };
      if (Date.now() > end) return { timeout: "norestart" };
    }
  }

  /** The new image should confirm itself (`pending_verify` -> `valid`) within `pendingVerifyMs`. */
  async function awaitConfirmed(dev: RegistryDevice, first: DeviceStatus, signal: AbortSignal): Promise<{ status: DeviceStatus; confirmed: boolean; cancelled: boolean }> {
    let s = first;
    const end = Date.now() + timings.pendingVerifyMs;
    const waiting = (x: DeviceStatus): boolean => x.ota?.image_state === "pending_verify" || x.ota?.image_state === "new";
    while (waiting(s)) {
      if (Date.now() > end) return { status: s, confirmed: false, cancelled: false };
      await sleep(timings.verifyPollMs, signal);
      if (signal.aborted) return { status: s, confirmed: false, cancelled: true };
      try {
        s = await client(dev).status({ timeoutMs: timings.statusTimeoutMs });
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
      }
    }
    const st = s.ota?.image_state;
    return { status: s, confirmed: st === "valid" || st === "undefined", cancelled: false };
  }

  const fail = (code: string, message: string, step: OtaStep): OtaOutcome => ({ state: "failed", error: { code, message, step }, message });

  /** Upload `image` to the device and verify. `before` is the status the caller already read (the pre-checks passed on it). */
  async function updateDevice(dev: RegistryDevice, image: FirmwareImage, filePath: string, pre: DeviceStatus, rep: Reporter): Promise<OtaOutcome> {
    const name = nameOf(dev);
    const o = pre.ota;
    const before: Before = { version: o.app_version, partition: o.running_partition ?? "", uptime: pre.uptime_s, sawRebootingSession: false };
    try {
      rep.enter("uploading", `Sending ${image.version} to ${name}`);
      rep.progress(0);
      let res;
      try {
        res = await client(dev).upload("/ota", createReadStream(filePath), image.size, {
          signal: rep.signal,
          idleTimeoutMs: timings.uploadIdleMs,
          answerTimeoutMs: timings.uploadAnswerMs,
          onProgress: (sent) => rep.progress(Math.min(1, sent / image.size)),
        });
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        if (rep.signal.aborted) return { state: "cancelled", message: "Cancelled while sending. The device keeps its old firmware." };
        // The connection broke. A device that is still up and has not restarted never took the image.
        let probe: DeviceStatus | null = null;
        try {
          probe = await client(dev).status({ timeoutMs: timings.statusTimeoutMs });
        } catch {
          probe = null;
        }
        if (probe && probe.ota?.session !== "rebooting" && (probe.ota?.running_partition ?? "") === before.partition) {
          const why = probe.ota?.last_error ? ` (${probe.ota.last_error})` : "";
          return fail("upload_failed", `The connection dropped while sending the firmware${why}. ${name} is still on ${before.version}.`, "uploading");
        }
        if (probe === null && !/reset|timeout/.test(err.kind)) {
          return fail("upload_failed", `${name} stopped answering while the firmware was being sent. It should still be on ${before.version}; check it, then try again.`, "uploading");
        }
        res = null;
      }
      if (res) {
        const env = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; error?: unknown; result?: { session?: unknown } }) : undefined;
        if (res.status < 200 || res.status >= 300 || env?.ok !== true) {
          const reason = typeof env?.error === "string" ? env.error : res.status === 400 || res.status === 500 ? res.text.trim() || `HTTP ${res.status}` : `HTTP ${res.status}`;
          return fail("device_refused", `${name} refused the firmware: ${reason}. It stays on ${before.version}.`, "uploading");
        }
        before.sawRebootingSession = env.result?.session === "rebooting";
      }

      rep.enter("rebooting", `${name} is restarting`);
      app.health.markRebooting(dev.id);
      const restarted = await awaitRestart(dev, before, rep.signal);
      if ("cancelled" in restarted) return { state: "cancelled", message: "Cancelled while the device restarted." };
      if ("timeout" in restarted) {
        return restarted.timeout === "offline"
          ? fail("verify_timeout", `${name} did not come back within ${Math.round(timings.verifyTimeoutMs / 1000)} seconds. Power-cycle it and check the page again.`, "rebooting")
          : fail("no_restart", `${name} accepted the firmware but did not restart.`, "rebooting");
      }

      rep.enter("verifying", `Checking the new firmware on ${name}`);
      const s0 = restarted.status;
      const o0 = s0.ota;
      const partitionChanged = before.partition === "" || o0?.running_partition !== before.partition;
      if (!partitionChanged) {
        const why = o0?.last_error ? ` (${o0.last_error})` : "";
        return {
          state: "rolled_back",
          error: { code: "rolled_back", message: `The new firmware did not start properly${why}. ${name} went back to ${o0?.app_version ?? before.version}.`, step: "verifying" },
          message: `The new firmware did not start; ${name} went back to ${o0?.app_version ?? before.version}.`,
        };
      }
      if (o0?.app_version !== image.version) {
        return fail("version_mismatch", `${name} restarted on ${o0?.app_version ?? "an unknown version"}, not ${image.version}.`, "verifying");
      }
      const settled = await awaitConfirmed(dev, s0, rep.signal);
      if (settled.cancelled) return { state: "cancelled", message: "Cancelled while checking the new firmware." };
      if (!settled.confirmed) {
        return fail(
          "not_confirmed",
          `${name} runs ${image.version} but has not confirmed that it works (state ${settled.status.ota?.image_state ?? "unknown"}). It may go back to the old firmware at the next restart.`,
          "verifying",
        );
      }
      app.health.ingest(dev.id, settled.status);
      return {
        state: "done",
        result: { fromVersion: before.version, toVersion: image.version, partition: settled.status.ota?.running_partition ?? "" },
        message: `Updated to ${image.version}`,
      };
    } catch (err) {
      if (err instanceof OtaProblem) return fail(err.code, err.message, err.step ?? "uploading");
      app.log(`firmware update of ${dev.id} crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return fail("internal_error", "Something went wrong inside the Manager while updating this device. Its log has the details.", "uploading");
    }
  }

  /** Ask the device to go back to the other firmware and check that it did. `pre` is the status the caller read. */
  async function rollbackDevice(dev: RegistryDevice, pre: DeviceStatus, rep: Reporter): Promise<OtaOutcome> {
    const name = nameOf(dev);
    const before: Before = { version: pre.ota.app_version, partition: pre.ota.running_partition ?? "", uptime: pre.uptime_s, sawRebootingSession: false };
    try {
      rep.enter("rebooting", `${name} is going back to its previous firmware`);
      const res = await callDevice(app, dev, "POST", "/command", { json: { cmd: "ota.rollback" } });
      const env = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; error?: unknown }) : undefined;
      if (res.status < 200 || res.status >= 300 || env?.ok !== true) {
        const reason = typeof env?.error === "string" ? env.error : `HTTP ${res.status}`;
        return fail("device_refused", `${name} refused to roll back: ${reason}.`, "rebooting");
      }
      app.health.markRebooting(dev.id);
      const restarted = await awaitRestart(dev, before, rep.signal);
      if ("cancelled" in restarted) return { state: "cancelled", message: "Stopped waiting. The device was already restarting." };
      if ("timeout" in restarted) {
        return restarted.timeout === "offline"
          ? fail("verify_timeout", `${name} did not come back within ${Math.round(timings.verifyTimeoutMs / 1000)} seconds. Power-cycle it and check the page again.`, "rebooting")
          : fail("no_restart", `${name} accepted the roll back but did not restart.`, "rebooting");
      }
      rep.enter("verifying", `Checking the firmware on ${name}`);
      const o = restarted.status.ota;
      if (o?.running_partition === before.partition) {
        return fail("rollback_failed", `${name} restarted but is still on ${o?.app_version ?? before.version}, so the roll back did not happen.`, "verifying");
      }
      const settled = await awaitConfirmed(dev, restarted.status, rep.signal);
      app.health.ingest(dev.id, settled.status);
      return {
        state: "done",
        result: { fromVersion: before.version, toVersion: settled.status.ota?.app_version ?? "", partition: settled.status.ota?.running_partition ?? "" },
        message: `Back on ${settled.status.ota?.app_version ?? "the previous firmware"}`,
      };
    } catch (err) {
      if (err instanceof OtaProblem) return fail(err.code, err.message, err.step ?? "rebooting");
      if (err instanceof DeviceError) return fail("device_offline", `${name} did not answer: ${err.message}`, "rebooting");
      app.log(`firmware rollback of ${dev.id} crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return fail("internal_error", "Something went wrong inside the Manager while rolling this device back. Its log has the details.", "rebooting");
    }
  }

  return { precheck, updateDevice, rollbackDevice };
}

export type Updater = ReturnType<typeof createUpdater>;
