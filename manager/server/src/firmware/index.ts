import type { AppContext } from "../appContext";
import { HttpError } from "../http/errors";
import type { JobControl } from "../jobs";
import { matchesTarget, type FirmwareTargetInfo } from "../device/summary";
import type { RegistryDevice } from "../store/registry";
import type { Job } from "../types/api-jobs";
import type { FirmwareBulkBody, FirmwareImage, FirmwareImageSource, FirmwareLatestInfo, FirmwareListResponse, OtaBulkResult, OtaStep } from "../types/api-firmware";
import { ImageError, MAX_IMAGE_BYTES } from "./image";
import { createFirmwareStore, type FirmwareStore } from "./store";
import { DEFAULT_TIMINGS, OtaProblem, createUpdater, nameOf, targetOf, type OtaOutcome, type Reporter, type UpdateTimings } from "./update";

export { ImageError, MAX_IMAGE_BYTES } from "./image";
export type { UpdateTimings } from "./update";

/**
 * Firmware / OTA feature (batch 3, firmware track): the image library, the target firmware, "Get latest", and the jobs that
 * push an image to one device or many (`kind: "ota"`). `start()` creates it right after the app context exists.
 */

/** `StartOptions.firmware`. All timings are in ms. */
export interface FirmwareConfig extends Partial<UpdateTimings> {
  /** Injected `fetch` for "Get latest" (tests; nothing may reach the internet). */
  fetch?: typeof fetch;
  /** Timeout of the "Get latest" download (default 30000). */
  fetchTimeoutMs?: number;
}

export interface FirmwareFeature {
  list(): FirmwareListResponse;
  addImage(buf: Buffer, filename: string, source: FirmwareImageSource): Promise<{ image: FirmwareImage; created: boolean }>;
  fetchLatest(): Promise<{ image: FirmwareImage; created: boolean }>;
  removeImage(id: string): Promise<void>;
  setTarget(id: string | null): Promise<FirmwareListResponse>;
  startUpdate(deviceId: string, firmwareId: string): Promise<Job>;
  startRollback(deviceId: string): Promise<Job>;
  startBulk(body: FirmwareBulkBody): Job;
  /** Ids of devices that are in an active `ota` job. */
  busyDevices(): string[];
  close(): Promise<void>;
}

const STEP_LABELS: Record<OtaStep, string> = {
  checking: "Checking the device",
  uploading: "Sending the firmware",
  rebooting: "Restarting the device",
  verifying: "Checking the new firmware",
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function createFirmwareFeature(app: AppContext, config: FirmwareConfig = {}): Promise<FirmwareFeature> {
  const store: FirmwareStore = await createFirmwareStore(app.dataDir);
  const timings: UpdateTimings = {
    verifyPollMs: config.verifyPollMs ?? DEFAULT_TIMINGS.verifyPollMs,
    verifyTimeoutMs: config.verifyTimeoutMs ?? DEFAULT_TIMINGS.verifyTimeoutMs,
    pendingVerifyMs: config.pendingVerifyMs ?? DEFAULT_TIMINGS.pendingVerifyMs,
    statusTimeoutMs: config.statusTimeoutMs ?? DEFAULT_TIMINGS.statusTimeoutMs,
    uploadIdleMs: config.uploadIdleMs ?? DEFAULT_TIMINGS.uploadIdleMs,
    uploadAnswerMs: config.uploadAnswerMs ?? DEFAULT_TIMINGS.uploadAnswerMs,
  };
  const fetchImpl = config.fetch ?? fetch;
  const fetchTimeoutMs = config.fetchTimeoutMs ?? 30_000;
  const updater = createUpdater(app, timings);

  const latest: FirmwareLatestInfo = { baseUrl: app.settings.get().firmwareBaseUrl, checkedAt: null, imageId: null, error: null };
  /** device id -> job id, while an ota job owns the device (queued or running). */
  const claims = new Map<string, string>();
  /** image id -> number of active jobs using it. */
  const inUse = new Map<string, number>();

  const useImage = (id: string, delta: 1 | -1): void => {
    const n = (inUse.get(id) ?? 0) + delta;
    if (n <= 0) inUse.delete(id);
    else inUse.set(id, n);
  };

  const targetImage = (): FirmwareImage | undefined => {
    const id = app.settings.get().firmwareTarget;
    return id ? store.get(id) : undefined;
  };
  app.summaries.setTargetSource((): FirmwareTargetInfo | null => {
    const t = targetImage();
    return t ? targetOf(t) : null;
  });
  const refreshSummaries = (): void => {
    for (const d of app.registry.list()) app.hub.deviceChanged(d.id);
  };

  function list(): FirmwareListResponse {
    const t = targetImage();
    return { images: store.list(), targetId: t ? t.id : null, latest: { ...latest, baseUrl: app.settings.get().firmwareBaseUrl } };
  }

  function needImage(id: string): FirmwareImage {
    const img = store.get(id);
    if (!img) throw new HttpError(404, "unknown_image", `There is no firmware image ${id.slice(0, 12)} in the library. List them with GET /api/firmware.`);
    return img;
  }

  function needDevice(id: string): RegistryDevice {
    const d = app.registry.get(id);
    if (!d) throw new HttpError(404, "unknown_device", `No device with id "${id}" is registered. List them with GET /api/devices.`);
    return d;
  }

  const asHttp = (err: unknown): never => {
    if (err instanceof ImageError) throw new HttpError(422, "invalid_image", err.message, { reason: err.message });
    if (err instanceof OtaProblem) throw new HttpError(err.status, err.code, err.message);
    throw err;
  };

  async function addImage(buf: Buffer, filename: string, source: FirmwareImageSource): Promise<{ image: FirmwareImage; created: boolean }> {
    try {
      return await store.add(buf, filename, source);
    } catch (err) {
      return asHttp(err);
    }
  }

  async function fetchLatest(): Promise<{ image: FirmwareImage; created: boolean }> {
    const base = app.settings.get().firmwareBaseUrl.replace(/\/*$/, "/");
    const url = `${base}firmware/de_esp32_runtime.bin`;
    latest.checkedAt = new Date().toISOString();
    const failed = (message: string): never => {
      latest.error = message;
      throw new HttpError(502, "fetch_failed", message, { url });
    };
    let buf: Buffer;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(fetchTimeoutMs), redirect: "follow" });
      if (!res.ok) return failed(`The firmware page answered HTTP ${res.status} for ${url}. Check the Pages URL in the settings, and that the firmware has been published.`);
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return failed(`The file at ${url} is larger than ${MAX_IMAGE_BYTES / 1048576} MB, so it is not a firmware image.`);
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) return failed(`The firmware page sent no file at ${url}.`);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return failed(`The file at ${url} is larger than ${MAX_IMAGE_BYTES / 1048576} MB, so it is not a firmware image.`);
        }
        chunks.push(Buffer.from(value));
      }
      buf = Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return failed(timedOut ? `The firmware page at ${url} did not answer in time.` : `Could not reach the firmware page at ${url}. Check this PC's internet connection and the Pages URL in the settings.`);
    }
    try {
      const out = await store.add(buf, "de_esp32_runtime.bin", "latest");
      latest.error = null;
      latest.imageId = out.image.id;
      return out;
    } catch (err) {
      if (err instanceof ImageError) latest.error = `The file at ${url} is not a usable firmware image: ${err.message}`;
      return asHttp(err);
    }
  }

  // ---- jobs --------------------------------------------------------------------------------------------------------

  /** Reporter for a single-device job: job-level steps plus the one device row. */
  function singleReporter(ctl: JobControl, deviceId: string, signal: AbortSignal): Reporter {
    let current: OtaStep | null = null;
    return {
      signal,
      enter(step, message) {
        if (current && current !== step) ctl.step(current, "done");
        current = step;
        ctl.step(step, "running");
        ctl.device(deviceId, { step, state: "running", ...(message ? { message } : {}) });
        if (message) ctl.message(message);
      },
      progress(value) {
        ctl.step("uploading", { progress: value });
        ctl.device(deviceId, { progress: value });
      },
      note(message) {
        ctl.message(message);
      },
    };
  }

  function applySingle(ctl: JobControl, deviceId: string, outcome: OtaOutcome): void {
    switch (outcome.state) {
      case "done":
        ctl.device(deviceId, { state: "done", message: outcome.message, progress: null, result: outcome.result });
        ctl.result(outcome.result);
        break;
      case "rolled_back":
        ctl.device(deviceId, { state: "rolled_back", message: outcome.message, progress: null, error: outcome.error });
        break;
      case "failed":
        ctl.device(deviceId, { state: "failed", message: outcome.message, progress: null, error: outcome.error });
        if (outcome.error.step) ctl.step(outcome.error.step, "failed");
        break;
      case "cancelled":
        ctl.device(deviceId, { state: "cancelled", message: outcome.message, progress: null });
        break;
    }
  }

  function claim(deviceId: string, jobId: string): void {
    claims.set(deviceId, jobId);
  }

  function checkNotBusy(ids: string[]): void {
    const busy = ids.filter((id) => claims.has(id));
    if (busy.length === 0) return;
    const first = needDevice(busy[0] as string);
    throw new HttpError(
      409,
      "ota_running",
      busy.length === 1 ? `${nameOf(first)} is already being updated. Wait for that to finish or cancel it first.` : `${plural(busy.length, "device is", "devices are")} already being updated: wait for those jobs or cancel them first.`,
      { deviceIds: busy },
    );
  }

  async function startUpdate(deviceId: string, firmwareId: string): Promise<Job> {
    const dev = needDevice(deviceId);
    const image = needImage(firmwareId);
    checkNotBusy([deviceId]);
    claims.set(deviceId, "pending"); // held while the pre-checks talk to the device
    let pre;
    try {
      pre = await updater.precheck(dev, image);
    } catch (err) {
      claims.delete(deviceId);
      return asHttp(err);
    }
    const stepIds: OtaStep[] = ["checking", "uploading", "rebooting", "verifying"];
    useImage(image.id, 1);
    const job = app.jobs.create(
      {
        kind: "ota",
        title: `Update ${nameOf(dev)} to ${image.version}`,
        deviceIds: [deviceId],
        devices: [{ deviceId, name: nameOf(dev) }],
        steps: stepIds.map((id) => ({ id, label: STEP_LABELS[id] })),
        params: { action: "update", firmwareId: image.id, version: image.version },
      },
      async (ctl) => {
        app.health.setUpdating(deviceId, true);
        try {
          const rep = singleReporter(ctl, deviceId, ctl.signal);
          ctl.step("checking", "done");
          ctl.device(deviceId, { state: "running", step: "checking" });
          const outcome = await updater.updateDevice(dev, image, store.filePath(image.id), pre, rep);
          applySingle(ctl, deviceId, outcome);
        } finally {
          claims.delete(deviceId);
          useImage(image.id, -1);
          app.health.setUpdating(deviceId, false);
        }
      },
    );
    claim(deviceId, job.id);
    return job;
  }

  async function startRollback(deviceId: string): Promise<Job> {
    const dev = needDevice(deviceId);
    checkNotBusy([deviceId]);
    claims.set(deviceId, "pending");
    let pre;
    try {
      pre = await updater.precheck(dev);
      if (pre.ota.rollback_possible !== true) {
        throw new OtaProblem("rollback_not_possible", `${nameOf(dev)} has no previous firmware to go back to.`, 409, "checking");
      }
    } catch (err) {
      claims.delete(deviceId);
      return asHttp(err);
    }
    const stepIds: OtaStep[] = ["checking", "rebooting", "verifying"];
    const job = app.jobs.create(
      {
        kind: "ota",
        title: `Roll back ${nameOf(dev)}`,
        deviceIds: [deviceId],
        devices: [{ deviceId, name: nameOf(dev) }],
        steps: stepIds.map((id) => ({ id, label: id === "rebooting" ? "Going back to the previous firmware" : STEP_LABELS[id] })),
        params: { action: "rollback", fromVersion: pre.ota.app_version },
      },
      async (ctl) => {
        app.health.setUpdating(deviceId, true);
        try {
          const rep = singleReporter(ctl, deviceId, ctl.signal);
          ctl.step("checking", "done");
          ctl.device(deviceId, { state: "running", step: "checking" });
          const outcome = await updater.rollbackDevice(dev, pre, rep);
          applySingle(ctl, deviceId, outcome);
        } finally {
          claims.delete(deviceId);
          app.health.setUpdating(deviceId, false);
        }
      },
    );
    claim(deviceId, job.id);
    return job;
  }

  /** Counts from the device rows as the job service will leave them: rows still queued or running after a cancel end up cancelled. */
  function tally(ctl: JobControl): OtaBulkResult {
    const counts: OtaBulkResult = { updated: 0, skipped: 0, failed: 0, rolledBack: 0, cancelled: 0 };
    const cancelled = ctl.isCancelled();
    for (const d of app.jobs.get(ctl.id)?.devices ?? []) {
      const state = cancelled && (d.state === "queued" || d.state === "running") ? "cancelled" : d.state;
      if (state === "done") counts.updated++;
      else if (state === "skipped") counts.skipped++;
      else if (state === "failed") counts.failed++;
      else if (state === "rolled_back") counts.rolledBack++;
      else if (state === "cancelled") counts.cancelled++;
    }
    return counts;
  }

  function startBulk(body: FirmwareBulkBody): Job {
    const image = needImage(body.firmwareId);
    const ids = [...new Set(body.deviceIds)];
    const devs = ids.map(needDevice);
    checkNotBusy(ids);
    const concurrency = body.concurrency ?? 2;
    const stopOn = body.stopOnFailures ?? 1;
    const skipSame = body.skipSame ?? true;
    useImage(image.id, 1);

    const job: Job = app.jobs.create(
      {
        kind: "ota",
        title: `Update ${plural(devs.length, "device", "devices")} to ${image.version}`,
        deviceIds: ids,
        devices: devs.map((d) => ({ deviceId: d.id, name: nameOf(d) })),
        params: { action: "bulk", firmwareId: image.id, version: image.version, concurrency, stopOnFailures: stopOn, skipSame },
        supports: { pause: true, retry: true },
        onRetry: (old) => {
          const again = old.devices.filter((d) => d.state === "failed" || d.state === "rolled_back" || d.state === "cancelled").map((d) => d.deviceId);
          const present = again.filter((id) => app.registry.get(id));
          if (present.length === 0) throw new HttpError(409, "nothing_to_retry", "There is no device left to retry.");
          return startBulk({ deviceIds: present, firmwareId: image.id, concurrency, stopOnFailures: stopOn, skipSame });
        },
      },
      async (ctl) => {
        const queue = [...devs];
        let sincePause = 0;

        const runOne = async (dev: RegistryDevice): Promise<void> => {
          const id = dev.id;
          const rep: Reporter = {
            signal: ctl.signal,
            enter(step, message) {
              ctl.device(id, { state: "running", step, ...(message ? { message } : {}) });
            },
            progress(value) {
              ctl.device(id, { progress: value });
            },
            note(message) {
              ctl.device(id, { message });
            },
          };
          app.health.setUpdating(id, true);
          try {
            ctl.device(id, { state: "running", step: "checking", message: "Checking the device" });
            let outcome: OtaOutcome;
            try {
              const pre = await updater.precheck(dev, image);
              if (skipSame && matchesTarget({ app_version: pre.ota.app_version, compile_date: pre.ota.compile_date, compile_time: pre.ota.compile_time }, targetOf(image)) === true) {
                ctl.device(id, { state: "skipped", progress: null, message: `Already on ${image.version}` });
                return;
              }
              outcome = await updater.updateDevice(dev, image, store.filePath(image.id), pre, rep);
            } catch (err) {
              if (!(err instanceof OtaProblem)) throw err;
              outcome = { state: "failed", error: { code: err.code, message: err.message, ...(err.step ? { step: err.step } : {}) }, message: err.message };
            }
            switch (outcome.state) {
              case "done":
                ctl.device(id, { state: "done", progress: null, message: outcome.message, result: outcome.result });
                break;
              case "rolled_back":
                ctl.device(id, { state: "rolled_back", progress: null, message: outcome.message, error: outcome.error });
                break;
              case "failed":
                ctl.device(id, { state: "failed", progress: null, message: outcome.message, error: outcome.error });
                break;
              case "cancelled":
                ctl.device(id, { state: "cancelled", progress: null, message: outcome.message });
                break;
            }
            if ((outcome.state === "failed" || outcome.state === "rolled_back") && ++sincePause >= stopOn && queue.length > 0 && !ctl.isCancelled()) {
              sincePause = 0;
              const why = `Paused: ${plural(stopOn, "device", "devices")} failed. Resume to carry on with the remaining ${queue.length}, or cancel.`;
              ctl.message(why);
              app.jobs.pause(ctl.id).catch(() => undefined);
            }
          } finally {
            claims.delete(id);
            app.health.setUpdating(id, false);
          }
        };

        const worker = async (): Promise<void> => {
          for (;;) {
            await ctl.waitWhilePaused();
            if (ctl.isCancelled()) return;
            const dev = queue.shift();
            if (!dev) return;
            await runOne(dev);
          }
        };

        try {
          await Promise.all(Array.from({ length: Math.min(concurrency, devs.length) }, () => worker()));
        } finally {
          for (const d of devs) claims.delete(d.id);
          useImage(image.id, -1);
        }
        const counts = tally(ctl);
        ctl.result(counts);
        if (!ctl.isCancelled()) {
          const bits = [`${counts.updated} updated`];
          if (counts.skipped) bits.push(`${counts.skipped} already up to date`);
          if (counts.failed) bits.push(`${counts.failed} failed`);
          if (counts.rolledBack) bits.push(`${counts.rolledBack} went back to the old firmware`);
          ctl.message(bits.join(", "));
        }
      },
    );
    for (const d of devs) claims.set(d.id, job.id);
    return job;
  }

  return {
    list,
    addImage,
    fetchLatest,
    async removeImage(id) {
      needImage(id);
      if (inUse.has(id)) throw new HttpError(409, "image_in_use", "An update that uses this firmware is still running. Cancel it or wait for it to finish.");
      await store.remove(id);
      if (app.settings.get().firmwareTarget === id) {
        await app.settings.update({ firmwareTarget: null });
        refreshSummaries();
      }
      if (latest.imageId === id) latest.imageId = null;
    },
    async setTarget(id) {
      if (id !== null) needImage(id);
      await app.settings.update({ firmwareTarget: id });
      refreshSummaries();
      return list();
    },
    startUpdate,
    startRollback,
    startBulk,
    busyDevices: () => [...claims.keys()],
    async close() {
      app.summaries.setTargetSource(() => null);
    },
  };
}
