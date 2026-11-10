import type { FirmwareBulkBody, FirmwareImage, FirmwareLatestInfo, FirmwareListResponse, Job, JobDeviceResult } from "@shared/api";
import { useEffect } from "react";
import { ApiError, apiFetch } from "./client";
import { jobsStore, startJobs, upsertJob } from "./jobs";
import { createStore, useStore } from "./store";

export type { FirmwareImage, FirmwareLatestInfo };
/** `GET /api/firmware`. */
export type FirmwareList = FirmwareListResponse;
/** `POST /api/firmware/update`. */
export type FirmwareBulkRequest = FirmwareBulkBody;

// ---- library store ---------------------------------------------------------------------------------------------------

interface FirmwareState {
  data: FirmwareList | null;
  error: ApiError | null;
  loaded: boolean;
}

const EMPTY: FirmwareState = { data: null, error: null, loaded: false };
export const firmwareStore = createStore<FirmwareState>(EMPTY);

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "unknown", e instanceof Error ? e.message : String(e)));

export async function loadFirmware(): Promise<void> {
  try {
    const data = await apiFetch<FirmwareList>("/api/firmware");
    firmwareStore.set({ data, error: null, loaded: true });
  } catch (err) {
    firmwareStore.set((p) => ({ ...p, error: asApiError(err), loaded: true }));
  }
}

/** Tests only. */
export function resetFirmware(): void {
  firmwareStore.set(EMPTY);
}

export interface UseFirmware extends FirmwareState {
  images: readonly FirmwareImage[];
  target: FirmwareImage | null;
  latest: FirmwareLatestInfo | null;
  reload(): Promise<void>;
}

/** The image library, the target and the latest-build status. Loads on mount. */
export function useFirmware(): UseFirmware {
  useEffect(() => {
    void loadFirmware();
  }, []);
  const s = useStore(firmwareStore, (x) => x);
  const images = s.data?.images ?? NO_IMAGES;
  const target = s.data?.targetId ? (images.find((i) => i.id === s.data?.targetId) ?? null) : null;
  return { ...s, images, target, latest: s.data?.latest ?? null, reload: loadFirmware };
}
const NO_IMAGES: readonly FirmwareImage[] = [];

/** Compare a device's reported build with an image (version and, when both are known, the build date). */
export function sameBuild(device: { app_version: string | null; compile_date: string | null }, image: Pick<FirmwareImage, "version" | "date">): boolean {
  if (!device.app_version || device.app_version !== image.version) return false;
  return !device.compile_date || !image.date || device.compile_date === image.date;
}

// ---- library calls ---------------------------------------------------------------------------------------------------

function addImage(image: FirmwareImage): void {
  firmwareStore.set((p) => {
    if (!p.data) return p;
    const images = [image, ...p.data.images.filter((i) => i.id !== image.id)];
    return { ...p, data: { ...p.data, images } };
  });
}

/**
 * POST /api/firmware with the raw file (XMLHttpRequest, because `fetch` cannot report upload progress).
 * Rejects with `ApiError`; a rejected image carries the server's plain reason as `message`.
 */
export function uploadFirmware(file: Blob & { name: string }, onProgress?: (fraction: number) => void): Promise<{ image: FirmwareImage; existing: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/firmware");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    // Header values are Latin-1 only.
    xhr.setRequestHeader("X-Filename", file.name.replace(/[^\x20-\x7e]/g, "_"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Cannot reach the Manager server."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "The upload was cancelled."));
    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        parsed = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const image = parsed as FirmwareImage;
        addImage(image);
        onProgress?.(1);
        resolve({ image, existing: xhr.status === 200 });
        return;
      }
      const env = (parsed ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
      reject(
        new ApiError(
          xhr.status,
          typeof env.code === "string" ? env.code : `http_${xhr.status}`,
          typeof env.error === "string" ? env.error : `The upload failed (${xhr.status}).`,
          env.details,
        ),
      );
    };
    xhr.send(file);
  });
}

/** POST /api/firmware/latest. The server fetches the CI build; the status (`latest`) is re-read either way. */
export async function fetchLatestFirmware(): Promise<FirmwareImage> {
  try {
    const image = await apiFetch<FirmwareImage>("/api/firmware/latest", { method: "POST" });
    addImage(image);
    await loadFirmware();
    return image;
  } catch (err) {
    await loadFirmware();
    throw err;
  }
}

export async function deleteFirmware(id: string): Promise<void> {
  await apiFetch<void>(`/api/firmware/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadFirmware();
}

export async function setFirmwareTarget(firmwareId: string | null): Promise<FirmwareList> {
  const data = await apiFetch<FirmwareList>("/api/firmware/target", { method: "PUT", body: { firmwareId } });
  firmwareStore.set({ data, error: null, loaded: true });
  return data;
}

// ---- update jobs -----------------------------------------------------------------------------------------------------

const dev = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

/** POST /api/devices/:id/ota. Resolves the new job (already in the jobs store). */
export async function startDeviceUpdate(deviceId: string, firmwareId: string): Promise<Job> {
  const job = await apiFetch<Job>(`${dev(deviceId)}/ota`, { method: "POST", body: { firmwareId } });
  upsertJob(job);
  return job;
}

/** POST /api/devices/:id/rollback. */
export async function startRollback(deviceId: string): Promise<Job> {
  const job = await apiFetch<Job>(`${dev(deviceId)}/rollback`, { method: "POST" });
  upsertJob(job);
  return job;
}

/** POST /api/firmware/update (several devices, one job). */
export async function startBulkUpdate(req: FirmwareBulkRequest): Promise<Job> {
  const job = await apiFetch<Job>("/api/firmware/update", { method: "POST", body: req });
  upsertJob(job);
  return job;
}

// ---- who is being updated right now ------------------------------------------------------------------------------------

const isActive = (j: Job) => j.state !== "succeeded" && j.state !== "failed" && j.state !== "partial" && j.state !== "cancelled" && j.state !== "interrupted";

/** The device's row in an unfinished firmware job (any state of the row), if there is one. */
function activeRow(jobs: readonly Job[], deviceId: string): { job: Job; row: JobDeviceResult | undefined } | null {
  for (const job of jobs) {
    if (job.kind !== "ota" || !isActive(job) || !job.deviceIds.includes(deviceId)) continue;
    return { job, row: job.devices.find((d) => d.deviceId === deviceId) };
  }
  return null;
}

/** Ids of the devices that are in an unfinished firmware job (waiting or running). */
export function activeUpdateIds(jobs: readonly Job[]): Set<string> {
  const ids = new Set<string>();
  for (const j of jobs) {
    if (j.kind !== "ota" || !isActive(j)) continue;
    // Before the rows exist every device of the job counts; afterwards only the ones still waiting or running.
    const waiting = j.devices.length === 0 ? j.deviceIds : j.devices.filter((d) => d.state === "queued" || d.state === "running").map((d) => d.deviceId);
    for (const id of waiting) ids.add(id);
  }
  return ids;
}

export interface DeviceUpdateActivity {
  /** The device itself is being worked on (not just waiting in the queue). */
  running: boolean;
  /** 0..1 while its upload runs. */
  progress: number | null;
  /** The job's plain status line for this device. */
  message: string | null;
}

/**
 * Live state of the firmware job a device is in, for the Fleet cards and rows. Returns primitives from the store, so a
 * card re-renders only when its own numbers change.
 */
export function useDeviceUpdate(deviceId: string): DeviceUpdateActivity | null {
  useEffect(() => startJobs(), []);
  const running = useStore(jobsStore, (s) => {
    const a = activeRow(s.list, deviceId);
    return a ? (a.row ? a.row.state === "running" : true) : null;
  });
  const progress = useStore(jobsStore, (s) => activeRow(s.list, deviceId)?.row?.progress ?? null);
  const message = useStore(jobsStore, (s) => activeRow(s.list, deviceId)?.row?.message ?? null);
  if (running === null) return null;
  return { running, progress, message };
}
