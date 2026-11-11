import type { AppContext } from "../appContext";
import { HttpError } from "../http/errors";
import { TERMINAL_JOB_STATES, type Job } from "../types/api-jobs";
import type {
  SetupAdapterStatus,
  SetupApList,
  SetupRecoveryState,
  SetupRestoreResult,
  SetupStartBody,
  SetupWifiBody,
} from "../types/api-setup";
import { createWifiAdapter, SETUP_SSID_RE, type FakeApSpec, type FakeWifiOptions, type WifiAdapter, type WifiAdapterKind } from "../wifi";
import { ChooseGate, DEFAULT_TIMINGS, runSetupJob, SETUP_STEPS, type SetupTimings } from "./job";
import { clearMarker, readMarker, type SetupMarkerFile } from "./marker";
import { restoreNetwork } from "./restore";

/**
 * SoftAP setup feature (batch 3, owner: SoftAP setup track). `start()` creates it right after the app context exists and
 * closes it FIRST on shutdown (it may have to put this PC's Wi-Fi back).
 */

export type { WifiAdapterKind };

/** `StartOptions.setup`: injection points for tests and the CLI (`--fake-ap`). */
export interface SetupConfig {
  /** Use this adapter instead of building one from `--wifi-adapter`. */
  adapter?: WifiAdapter;
  /** Simulated access points (only with the `fake` adapter). */
  fakeAps?: FakeApSpec[];
  /** More options of the simulated Wi-Fi (the network the PC is on, delays, faults). */
  fakeWifi?: Omit<FakeWifiOptions, "aps">;
  /** Time limits; tests use small values. */
  timings?: Partial<SetupTimings>;
  /** Where the device's setup network lives (default 192.168.4.1). */
  apAddress?: string;
  /** How long `close()` waits for a running job to put the network back (default 25 s). */
  closeTimeoutMs?: number;
}

export interface SetupFeature {
  readonly adapter: WifiAdapter;
  adapterStatus(): Promise<SetupAdapterStatus>;
  listAps(refresh: boolean): Promise<SetupApList>;
  /** Start a setup job. Throws `HttpError` (409 `setup_running`, `adapter_unsupported`, `recovery_pending`; 400). */
  start(body: SetupStartBody): Promise<Job>;
  /** Answer the `choose` step. Throws `HttpError` (404 `not_found`, 409 `job_not_waiting`). */
  chooseWifi(jobId: string, body: SetupWifiBody): Job;
  recovery(): Promise<SetupRecoveryState>;
  restore(): Promise<SetupRestoreResult>;
  dismiss(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_AP_ADDRESS = "192.168.4.1";
const DEFAULT_CLOSE_TIMEOUT_MS = 25_000;

const publicMarker = (m: SetupMarkerFile): NonNullable<SetupRecoveryState["marker"]> => ({
  jobId: m.jobId,
  startedAt: m.startedAt,
  originalSsid: m.originalSsid,
  profiles: [...m.profiles],
});

export async function createSetupFeature(app: AppContext, opts: { adapterKind: WifiAdapterKind; config?: SetupConfig }): Promise<SetupFeature> {
  const cfg = opts.config ?? {};
  const log = (msg: string): void => app.log(msg);
  const adapter =
    cfg.adapter ?? createWifiAdapter(opts.adapterKind, { ...(cfg.fakeAps ? { fakeAps: cfg.fakeAps } : {}), ...(cfg.fakeWifi ? { fake: cfg.fakeWifi } : {}) });
  const timings: SetupTimings = { ...DEFAULT_TIMINGS, ...(cfg.timings ?? {}) };
  const apAddress = cfg.apAddress ?? DEFAULT_AP_ADDRESS;
  const closeTimeoutMs = cfg.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const gates = new Map<string, ChooseGate>();
  let activeJobId: string | null = null;
  let closing = false;
  let apCache: { scannedAt: string; aps: Omit<SetupApList["aps"][number], "knownDeviceId" | "knownDeviceOnline">[] } | null = null;

  const leftover = await readMarker(app.dataDir, log);
  if (leftover) {
    log(
      `setup: a previous setup run did not finish (job ${leftover.jobId}, started ${leftover.startedAt}). ` +
        `This PC's Wi-Fi was on "${leftover.originalSsid ?? "nothing"}" before it. Nothing is changed automatically; use Restore network in the Manager.`,
    );
  }

  const isActive = (): boolean => {
    if (activeJobId === null) return false;
    const j = app.jobs.get(activeJobId);
    return j !== undefined && !TERMINAL_JOB_STATES.includes(j.state);
  };

  /** Marker that belongs to NO running job = a run that never finished. */
  async function strayMarker(): Promise<SetupMarkerFile | null> {
    const m = await readMarker(app.dataDir, log);
    if (!m) return null;
    if (isActive() && m.jobId === activeJobId) return null;
    return m;
  }

  async function status(): Promise<SetupAdapterStatus> {
    const info = await adapter.info().catch((err: unknown) => ({ supported: false, reason: err instanceof Error ? err.message : String(err), interfaceName: null }));
    const connected = info.supported ? await adapter.current().catch(() => ({ ssid: null, profile: null })) : { ssid: null, profile: null };
    const local = info.supported ? await adapter.localAddress().catch(() => null) : null;
    return {
      kind: adapter.kind,
      supported: info.supported,
      reason: info.supported ? null : (info.reason ?? "SoftAP setup is not available on this PC."),
      interfaceName: info.interfaceName,
      connectedSsid: connected.ssid,
      localAddress: local,
    };
  }

  return {
    adapter,
    adapterStatus: status,

    async listAps(refresh) {
      const info = await adapter.info().catch(() => ({ supported: false, reason: "The Wi-Fi adapter did not answer.", interfaceName: null }));
      if (!info.supported) return { supported: false, reason: info.reason ?? "SoftAP setup is not available on this PC.", aps: [], scannedAt: null };
      if (refresh || !apCache) {
        let nets;
        try {
          nets = await adapter.scan();
        } catch (err) {
          throw new HttpError(502, "wifi_scan_failed", `Could not list the Wi-Fi networks around this PC: ${err instanceof Error ? err.message : String(err)}`);
        }
        const aps = nets
          .filter((n) => SETUP_SSID_RE.test(n.ssid))
          .map((n) => {
            const idSuffix = n.ssid.slice(-6).toLowerCase();
            return {
              ssid: n.ssid,
              idSuffix,
              secured: n.secured,
              signal: n.signal,
            };
          })
          .sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1) || a.ssid.localeCompare(b.ssid));
        apCache = { scannedAt: new Date().toISOString(), aps };
      }
      // Known-device links and their health follow the registry even for a cached scan.
      const ids = app.registry.list().map((d) => d.id.toLowerCase());
      const link = (idSuffix: string): { knownDeviceId: string | null; knownDeviceOnline: boolean } => {
        const id = ids.find((x) => x.endsWith(idSuffix)) ?? null;
        return { knownDeviceId: id, knownDeviceOnline: id !== null && app.summaries.get(id)?.health === "online" };
      };
      const cache = apCache;
      return { supported: true, reason: null, aps: cache.aps.map((a) => ({ ...a, ...link(a.idSuffix) })), scannedAt: cache.scannedAt };
    },

    async start(body) {
      if (closing) throw new HttpError(503, "shutting_down", "The Manager is shutting down.");
      const st = await status();
      if (!st.supported) throw new HttpError(409, "adapter_unsupported", st.reason ?? "SoftAP setup is not available on this PC.");
      if (await strayMarker()) {
        throw new HttpError(
          409,
          "recovery_pending",
          "A previous setup did not finish, so this PC's Wi-Fi may still be on the device's network. Use Restore network (or Dismiss) first.",
        );
      }
      // No await between this check and `jobs.create` below, so two requests cannot both start a job.
      if (isActive()) throw new HttpError(409, "setup_running", "A setup is already running. Wait for it to finish or cancel it first.");
      const ssid = body.ssid;
      const deviceId = body.deviceId?.toLowerCase();
      if (deviceId !== undefined && !ssid.toLowerCase().endsWith(deviceId.slice(-6))) {
        throw new HttpError(400, "invalid_body", `The setup Wi-Fi ${ssid} does not belong to the device ${deviceId}.`);
      }
      const wifi = body.wifi && body.wifi.ssid !== "" ? { ssid: body.wifi.ssid, ...(body.wifi.password ? { password: body.wifi.password } : {}) } : undefined;
      const known = deviceId ? app.registry.get(deviceId) : undefined;
      const gate = new ChooseGate();
      const req = {
        ssid,
        ...(body.apPassword ? { apPassword: body.apPassword } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(wifi ? { wifi } : {}),
        factoryResetFirst: body.factoryResetFirst === true,
      };
      const env = { app, adapter, timings, apAddress, dataDir: app.dataDir, log };
      const job = app.jobs.create(
        {
          kind: "setup",
          title: deviceId ? `Recover ${known?.name || deviceId}` : `Set up ${ssid}`,
          steps: SETUP_STEPS,
          params: {
            ssid,
            ...(deviceId ? { deviceId } : {}),
            ...(wifi ? { wifiSsid: wifi.ssid } : {}),
            factoryResetFirst: req.factoryResetFirst,
          },
        },
        (ctl) => runSetupJob(env, ctl, req, gate),
      );
      activeJobId = job.id;
      gates.set(job.id, gate);
      void app.jobs
        .whenDone(job.id)
        .catch(() => undefined)
        .finally(() => {
          gates.delete(job.id);
          if (activeJobId === job.id) activeJobId = null;
        });
      return job;
    },

    chooseWifi(jobId, body) {
      const job = app.jobs.get(jobId);
      if (!job) throw new HttpError(404, "not_found", `There is no setup job with the id ${jobId}.`);
      const gate = gates.get(jobId);
      if (!gate || !gate.submit({ ssid: body.ssid, ...(body.password ? { password: body.password } : {}), ...(body.factoryResetFirst !== undefined ? { factoryResetFirst: body.factoryResetFirst } : {}) })) {
        throw new HttpError(409, "job_not_waiting", "This setup is not waiting for a network choice right now.");
      }
      return app.jobs.get(jobId) ?? job;
    },

    async recovery() {
      const m = await strayMarker();
      return m ? { pending: true, marker: publicMarker(m) } : { pending: false, marker: null };
    },

    async restore() {
      if (isActive()) throw new HttpError(409, "setup_running", "A setup is running; cancel it to put the Wi-Fi back.");
      const m = await strayMarker();
      if (!m) return { restored: false, message: "There is nothing to restore." };
      const info = await adapter.info().catch(() => ({ supported: false, reason: null as string | null, interfaceName: null }));
      if (!info.supported) return { restored: false, message: info.reason ?? "SoftAP setup is not available on this PC, so its Wi-Fi cannot be restored from here." };
      const out = await restoreNetwork(adapter, m, { rejoinMs: timings.rejoinMs, log });
      if (out.ok) {
        await clearMarker(app.dataDir);
        log("setup: this PC's Wi-Fi was restored from the recovery marker");
      }
      return { restored: out.ok, message: out.message };
    },

    async dismiss() {
      if (isActive()) throw new HttpError(409, "setup_running", "A setup is running.");
      await clearMarker(app.dataDir);
    },

    async close() {
      closing = true;
      const id = activeJobId;
      if (id !== null && isActive()) {
        try {
          app.jobs.cancel(id);
        } catch {
          /* already gone */
        }
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeTimeoutMs);
          timer.unref();
        });
        await Promise.race([app.jobs.whenDone(id).then(() => undefined, () => undefined), limit]);
        if (timer) clearTimeout(timer);
      }
      await adapter.close?.();
    },
  };
}
