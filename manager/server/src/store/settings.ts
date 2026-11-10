import { promises as fs } from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { atomicWrite } from "./atomicWrite";

/**
 * App settings (`<dataDir>/settings.json`). Known keys are typed and defaulted;
 * unknown keys are preserved on save so older/newer versions can share a file.
 * Later milestones add keys here (and defaults in `DEFAULT_SETTINGS`).
 */
export const SettingsSchema = Type.Object(
  {
    lanToken: Type.Union([Type.String(), Type.Null()]),
    /** LAN access switched on from Settings (persisted; the CLI `--lan` also turns it on at start). */
    lanEnabled: Type.Boolean(),
    /** Seconds between health polls of each device. */
    pollIntervalS: Type.Integer({ minimum: 10, maximum: 300 }),
    /** Extra host[:port] addresses probed on every discovery scan (canonical form). */
    discoveryTargets: Type.Array(Type.String()),
    /** Extra CIDR ranges swept on every discovery scan. */
    extraSubnets: Type.Array(Type.String()),
    backgroundScan: Type.Object({ enabled: Type.Boolean(), periodMin: Type.Integer({ minimum: 1, maximum: 60 }) }),
    /** Where "Get latest firmware" looks: `<base>/firmware/de_esp32_runtime.bin` (the Pages URL). */
    firmwareBaseUrl: Type.String(),
    /** Id (sha256) of the target firmware image, null = none. Changed through `PUT /api/firmware/target`. */
    firmwareTarget: Type.Union([Type.String(), Type.Null()]),
    /** Initial "Parallel updates" value of the Firmware screen (1-4). */
    defaultParallelUpdates: Type.Integer({ minimum: 1, maximum: 4 }),
  },
  { additionalProperties: true },
);
export type Settings = Static<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  lanToken: null,
  lanEnabled: false,
  pollIntervalS: 30,
  discoveryTargets: [],
  extraSubnets: [],
  backgroundScan: { enabled: false, periodMin: 5 },
  firmwareBaseUrl: "https://terraseraph.github.io/esp32-joat/",
  firmwareTarget: null,
  defaultParallelUpdates: 2,
};

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}

/** Load settings, filling defaults. A missing file gives defaults; an unreadable one throws. */
export async function loadSettings(dataDir: string): Promise<Settings> {
  const file = settingsPath(dataDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or delete it.`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object. Fix or delete it.`);
  }
  const merged = { ...DEFAULT_SETTINGS, ...(parsed as Record<string, unknown>) };
  if (!Value.Check(SettingsSchema, merged)) {
    const first = [...Value.Errors(SettingsSchema, merged)][0];
    throw new Error(`${file}: invalid value at ${first?.path ?? "/"}: ${first?.message ?? "unknown"}`);
  }
  return merged;
}

export async function saveSettings(dataDir: string, settings: Settings): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await atomicWrite(settingsPath(dataDir), JSON.stringify(settings, null, 2) + "\n");
}

/** The part of the settings the API exposes (never the LAN token or the LAN switch, which GET/PUT /api/access handle). */
export function publicSettings(s: Settings): Omit<Settings, "lanToken" | "lanEnabled" | "firmwareTarget"> {
  return {
    pollIntervalS: s.pollIntervalS,
    discoveryTargets: [...s.discoveryTargets],
    extraSubnets: [...s.extraSubnets],
    backgroundScan: { ...s.backgroundScan },
    firmwareBaseUrl: s.firmwareBaseUrl,
    defaultParallelUpdates: s.defaultParallelUpdates,
  };
}
/** Settings held in memory, saved on every change (writes are serialised). */
export interface SettingsService {
  get(): Settings;
  /** Merge a partial update, save, notify listeners; resolves with the new settings. */
  update(patch: Partial<Settings>): Promise<Settings>;
  onChange(fn: (s: Settings) => void): () => void;
}

export async function createSettingsService(dataDir: string): Promise<SettingsService> {
  let current = await loadSettings(dataDir);
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(s: Settings) => void>();
  return {
    get: () => current,
    update(patch) {
      const run = chain.then(async () => {
        const next = { ...current, ...patch };
        await saveSettings(dataDir, next);
        current = next;
        for (const fn of listeners) fn(next);
        return next;
      });
      chain = run.catch(() => undefined);
      return run;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
