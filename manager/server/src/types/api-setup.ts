/**
 * Batch 3: types and TypeBox schemas of the SoftAP setup track. Owned by that track (nobody else edits this file).
 * Re-exported from `./api`, so the web app imports them as `import type { X } from "@shared/api"`.
 * Documented in `API.md` under "SoftAP setup". A setup run is a generic `Job` of kind `"setup"` (see `api-jobs.ts`).
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const SetupAdapterKindSchema = Type.Union([Type.Literal("fake"), Type.Literal("system"), Type.Literal("none")], {
  description: "fake = built-in simulator (--wifi-adapter fake) · system = this PC's own Wi-Fi (Windows only for now) · none = setup is off",
});

export const SetupAdapterStatusSchema = Type.Object(
  {
    kind: SetupAdapterKindSchema,
    supported: Type.Boolean({ description: "false = the Manager cannot switch this PC's Wi-Fi, so setup is unavailable" }),
    reason: Nullable(Type.String({ description: "Plain words why setup is unavailable; null when supported" })),
    interfaceName: Nullable(Type.String({ description: "Name of the Wi-Fi adapter that will be used" })),
    connectedSsid: Nullable(Type.String({ description: "The Wi-Fi network this PC is on right now" })),
    localAddress: Nullable(Type.String({ description: "This PC's IPv4 address on that adapter" })),
  },
  { description: "Whether the Manager can control this PC's Wi-Fi" },
);
export type SetupAdapterStatus = Static<typeof SetupAdapterStatusSchema>;

export const SetupApSchema = Type.Object(
  {
    ssid: Type.String({ description: "The device's setup Wi-Fi name: esp32-<last 6 hex of its id>" }),
    idSuffix: Type.String({ description: "The last 6 hex characters of the device id" }),
    secured: Type.Boolean({ description: "true = the setup Wi-Fi needs a password" }),
    signal: Nullable(Type.Number({ minimum: 0, maximum: 100, description: "Signal strength in percent" })),
    knownDeviceId: Nullable(Type.String({ description: "Id of a device in the fleet whose id ends with `idSuffix` (the setup Wi-Fi name is esp32-<last 6 hex of the id>)" })),
    knownDeviceOnline: Type.Boolean({
      description:
        "true when that fleet device answers on the network right now: it is already set up and only its setup Wi-Fi is still on (firmware leaves it open until a restart). false = not in the fleet, or in the fleet but not answering (a device to recover)",
    }),
  },
  { description: "A device that is raising its own setup Wi-Fi" },
);
export type SetupAp = Static<typeof SetupApSchema>;

export const SetupApListQuerySchema = Type.Object({
  refresh: Type.Optional(Type.Boolean({ description: "true = scan again now instead of returning the last scan" })),
});
export type SetupApListQuery = Static<typeof SetupApListQuerySchema>;

export const SetupApListSchema = Type.Object({
  supported: Type.Boolean(),
  reason: Nullable(Type.String()),
  aps: Type.Array(SetupApSchema),
  scannedAt: Nullable(Type.String({ description: "ISO time of the scan" })),
});
export type SetupApList = Static<typeof SetupApListSchema>;

export const SetupWifiChoiceSchema = Type.Object({
  ssid: Type.String({ minLength: 1, maxLength: 32, description: "Network the device should join" }),
  password: Type.Optional(Type.String({ maxLength: 64, description: "Empty or omitted for an open network. Never stored or echoed." })),
});

export const SetupStartBodySchema = Type.Object({
  ssid: Type.String({ pattern: "^esp32-[0-9a-fA-F]{6}$", description: "The device's setup Wi-Fi, from `GET /api/setup/aps`" }),
  apPassword: Type.Optional(Type.String({ maxLength: 64, description: "Only when the setup Wi-Fi is secured" })),
  deviceId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{12}$", description: "Recover mode: the id the device must have. A different device ends the job with `not_our_device`" })),
  wifi: Type.Optional(SetupWifiChoiceSchema),
  factoryResetFirst: Type.Optional(Type.Boolean({ description: "Erase the device's saved settings before sending the Wi-Fi details" })),
});
export type SetupStartBody = Static<typeof SetupStartBodySchema>;

export const SetupWifiBodySchema = Type.Object({
  ssid: Type.String({ minLength: 1, maxLength: 32 }),
  password: Type.Optional(Type.String({ maxLength: 64 })),
  factoryResetFirst: Type.Optional(Type.Boolean()),
});
export type SetupWifiBody = Static<typeof SetupWifiBodySchema>;

export const SetupJobIdParamsSchema = Type.Object({ id: Type.String() });

/** `job.result` while the `choose` step waits. */
export const SetupChooseResultSchema = Type.Object({
  networks: Type.Array(Type.Object({ ssid: Type.String(), rssi: Type.Number(), secure: Type.Boolean() })),
  device: Type.Object({ id: Type.String(), name: Type.String(), fw: Type.Optional(Type.String()), app_version: Type.Optional(Type.String()) }),
});
export type SetupChooseResult = Static<typeof SetupChooseResultSchema>;

/** `job.result` of a succeeded setup job. */
export const SetupJobResultSchema = Type.Object({
  deviceId: Type.String(),
  host: Type.String(),
  name: Type.String(),
  added: Type.Boolean({ description: "true = the device is now in the fleet (false when it was already there)" }),
});
export type SetupJobResult = Static<typeof SetupJobResultSchema>;

export const SetupRecoveryMarkerSchema = Type.Object({
  jobId: Type.String(),
  startedAt: Type.String(),
  originalSsid: Nullable(Type.String({ description: "The network this PC was on before the job switched it" })),
  profiles: Type.Array(Type.String(), { description: "Temporary Wi-Fi profiles the job created and may have left behind" }),
});
export type SetupRecoveryMarker = Static<typeof SetupRecoveryMarkerSchema>;

export const SetupRecoveryStateSchema = Type.Object({
  pending: Type.Boolean({ description: "true = a previous setup run stopped before it could put this PC's Wi-Fi back" }),
  marker: Nullable(SetupRecoveryMarkerSchema),
});
export type SetupRecoveryState = Static<typeof SetupRecoveryStateSchema>;

export const SetupRestoreResultSchema = Type.Object({
  restored: Type.Boolean(),
  message: Type.String({ description: "Plain words about what happened" }),
});
export type SetupRestoreResult = Static<typeof SetupRestoreResultSchema>;

/** Step ids of a setup job, in order. */
export const SETUP_STEP_IDS = ["remember", "join_ap", "fingerprint", "scan", "choose", "factory_reset", "send_wifi", "check_result", "leave_ap", "wait_lan", "add"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** `JobError.code` values a setup job can end with. */
export const SETUP_ERROR_CODES = [
  "adapter_unsupported",
  /** Added: this PC's Wi-Fi did not do what the Manager asked (profile could not be saved, command failed). */
  "adapter_failed",
  "ap_not_found",
  "ap_password_wrong",
  "device_not_responding",
  "not_our_device",
  "wifi_auth",
  "wifi_no_ap",
  "wifi_no_ip",
  "wifi_failed",
  /** Added: the device refused or did not answer the factory reset. */
  "factory_reset_failed",
  "device_not_on_lan",
  "restore_failed",
  "choose_timeout",
  "cancelled",
] as const;
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number];
