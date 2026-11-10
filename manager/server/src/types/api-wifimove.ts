/**
 * Types and TypeBox schemas of the Wi-Fi move feature (L1, spec §9: "Move to another Wi-Fi network"). Owned by that track.
 * Re-exported from `./api`, so the web app imports them as `import type { X } from "@shared/api"`. Export names are prefixed `WifiMove`.
 *
 * Routes: `GET /api/devices/:id/wifi`, `POST /api/devices/:id/wifi/check`, `POST /api/devices/:id/wifi` (starts a job of kind
 * `wifi-move`; its final `result` is a `WifiMoveJobResult`). See API.md "Wi-Fi move".
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

/** The device's own record of its last Wi-Fi change (`status.network.wifi_change`), in words as well as raw fields. */
export const WifiMoveLastChangeSchema = Type.Object({
  result: Type.String({ description: "none | testing | ok | failed (as the device sends it; unknown values are passed through)" }),
  ssid: Nullable(Type.String()),
  reason: Nullable(Type.String({ description: "auth | no_ap | no_ip | timeout | connect_failed | save_failed" })),
  restoredPrevious: Nullable(Type.Boolean()),
  seq: Nullable(Type.Number()),
  words: Nullable(Type.String({ description: "One plain sentence, null while the device has nothing to report" })),
});
export type WifiMoveLastChange = Static<typeof WifiMoveLastChangeSchema>;

export const WifiMoveSettingsSchema = Type.Object({
  supported: Type.Boolean({ description: "false when the device does not report `wifi_change` (firmware without the safe Wi-Fi change)" }),
  reason: Nullable(Type.String({ description: "Plain words: why moving is not possible (only when supported is false)" })),
  state: Type.String({ description: "The device's net state (sta_connected, ap_only, ...)" }),
  connected: Type.Boolean(),
  ip: Type.String({ description: "The device's current Wi-Fi address, empty when not connected" }),
  hostname: Type.String(),
  ipMode: Type.Union([Type.Literal("dhcp"), Type.Literal("static"), Type.Literal("unknown"), Type.Null()]),
  staticIp: Type.Boolean({ description: "true when the device uses a fixed address (a move resets it to DHCP)" }),
  lastChange: Nullable(WifiMoveLastChangeSchema),
  pcSsid: Nullable(Type.String({ description: "The Wi-Fi network this PC is on, when the Wi-Fi adapter can tell; null otherwise" })),
  pcSsidKnown: Type.Boolean({ description: "false = the Manager cannot tell which network this PC is on (no adapter, or not on Wi-Fi)" }),
  setupApAvailable: Type.Boolean({ description: "true when this PC can join a device's setup Wi-Fi (the way back if the device is lost)" }),
  activeJobId: Nullable(Type.String({ description: "Id of the running wifi-move job for this device, if any" })),
});
export type WifiMoveSettings = Static<typeof WifiMoveSettingsSchema>;

/** Body of `POST /api/devices/:id/wifi/check`. */
export const WifiMoveCheckBodySchema = Type.Object({
  ssid: Type.String({ maxLength: 200, description: "The network to move to (1-32 bytes)" }),
  password: Type.Optional(Type.String({ maxLength: 200, description: "Only checked for length (empty or 8-63); never stored or logged" })),
});
export type WifiMoveCheckBody = Static<typeof WifiMoveCheckBodySchema>;

/** Body of `POST /api/devices/:id/wifi`. The password is kept in memory for the job only. */
export const WifiMoveBodySchema = Type.Object({
  ssid: Type.String({ maxLength: 200, description: "The network to move to (1-32 bytes)" }),
  password: Type.Optional(Type.String({ maxLength: 200, description: "Empty or missing = open network; otherwise 8-63 characters" })),
  timeoutS: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "How long the job looks for the device afterwards (default 90)" })),
});
export type WifiMoveBody = Static<typeof WifiMoveBodySchema>;

export const WifiMoveFieldErrorSchema = Type.Object({ field: Type.Union([Type.Literal("ssid"), Type.Literal("password"), Type.Literal("device")]), message: Type.String() });
export type WifiMoveFieldError = Static<typeof WifiMoveFieldErrorSchema>;

export const WifiMoveWarningCodeSchema = Type.Union([
  Type.Literal("pc_other_network"),
  Type.Literal("pc_network_unknown"),
  Type.Literal("static_ip_reset"),
]);

/** A heads-up that does not block the move. */
export const WifiMoveWarningSchema = Type.Object({ code: WifiMoveWarningCodeSchema, message: Type.String({ description: "Plain words" }) });
export type WifiMoveWarning = Static<typeof WifiMoveWarningSchema>;

export const WifiMoveCheckResultSchema = Type.Object({
  ok: Type.Boolean({ description: "false = the request would be refused (see errors)" }),
  errors: Type.Array(WifiMoveFieldErrorSchema),
  warnings: Type.Array(WifiMoveWarningSchema),
});
export type WifiMoveCheckResult = Static<typeof WifiMoveCheckResultSchema>;

export const WifiMoveOutcomeSchema = Type.Union(
  [Type.Literal("ok"), Type.Literal("failed"), Type.Literal("not_found"), Type.Literal("unknown")],
  { description: "ok = found on the new network · failed = the device could not join and went back · not_found = never seen again · unknown = cancelled or unclear" },
);
export type WifiMoveOutcome = Static<typeof WifiMoveOutcomeSchema>;

/** `job.result` of a `wifi-move` job (never contains the password). */
export const WifiMoveJobResultSchema = Type.Object({
  outcome: WifiMoveOutcomeSchema,
  ssid: Type.String(),
  reason: Nullable(Type.String({ description: "Plain words, null on success" })),
  reasonCode: Nullable(Type.String({ description: "The device's wifi_change.reason (auth, no_ap, no_ip, timeout, connect_failed, save_failed) when it gave one" })),
  restoredPrevious: Nullable(Type.Boolean({ description: "The device's wifi_change.restored_previous, when it reported a failure" })),
  oldHost: Type.String({ description: "Where the Manager knew the device before (host or host:port)" }),
  newHost: Nullable(Type.String({ description: "Where it was found afterwards" })),
  addressChanged: Type.Boolean(),
  staticIpReset: Type.Boolean({ description: "A static address was replaced by DHCP (device ip_change.result reset)" }),
});
export type WifiMoveJobResult = Static<typeof WifiMoveJobResultSchema>;
