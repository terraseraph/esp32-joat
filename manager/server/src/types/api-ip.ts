/**
 * Batch 3: types and TypeBox schemas of the IP address track. Owned by that track (nobody else edits this file).
 * Re-exported from `./api`, so the web app imports them as `import type { X } from "@shared/api"`.
 *
 * Routes: `GET /api/devices/:id/ip`, `POST /api/devices/:id/ip/check`, `POST /api/devices/:id/ip` (starts a job of kind
 * `ip-change`). The job's final `result` is an `IpJobResult`. See API.md "IP address".
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const IpModeSchema = Type.Union([Type.Literal("dhcp"), Type.Literal("static")], { description: "How the device gets its Wi-Fi address" });
export type IpMode = Static<typeof IpModeSchema>;

/** What `GET /api/devices/:id/ip` reports. Address fields are empty strings while the device is not connected. */
export const IpSettingsSchema = Type.Object({
  supported: Type.Boolean({ description: "false when the device does not report ip_mode (firmware without static IP support)" }),
  reason: Nullable(Type.String({ description: "Plain words: why changing the address is not possible (only when supported is false)" })),
  ipMode: Type.Union([Type.Literal("dhcp"), Type.Literal("static"), Type.Literal("unknown"), Type.Null()], {
    description: "dhcp | static; unknown when the device reports something else; null when not supported",
  }),
  ip: Type.String({ description: "The device's current Wi-Fi address (status.network.sta_ip)" }),
  netmask: Type.String(),
  gateway: Type.String(),
  dns: Type.String(),
  staConnected: Type.Boolean(),
  ipChange: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
    description: "The device's own ip_change record (snake_case, passed through): result none|pending|ok|reverted|reset|failed, reason, applied, confirm_left_s, seq ...; null when absent",
  }),
  activeJobId: Nullable(Type.String({ description: "Id of the running ip-change job for this device, if any" })),
});
export type IpSettings = Static<typeof IpSettingsSchema>;

/** Body of `POST /api/devices/:id/ip` and `POST /api/devices/:id/ip/check`. `dns` defaults to the gateway. */
export const IpChangeBodySchema = Type.Union([
  Type.Object({ mode: Type.Literal("dhcp") }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal("static"),
      ip: Type.String({ maxLength: 64 }),
      netmask: Type.String({ maxLength: 64 }),
      gateway: Type.String({ maxLength: 64 }),
      dns: Type.Optional(Type.String({ maxLength: 64, description: "Empty or missing = use the gateway" })),
    },
    { additionalProperties: false },
  ),
]);
export type IpChangeBody = Static<typeof IpChangeBodySchema>;

export const IpFieldSchema = Type.Union([Type.Literal("ip"), Type.Literal("netmask"), Type.Literal("gateway"), Type.Literal("dns"), Type.Literal("mode")]);
export type IpField = Static<typeof IpFieldSchema>;

/** A rule the device would refuse; `mode` is used for problems with the request as a whole (not supported, not connected ...). */
export const IpFieldErrorSchema = Type.Object({ field: IpFieldSchema, message: Type.String({ description: "Plain words" }) });
export type IpFieldError = Static<typeof IpFieldErrorSchema>;

/** A heads-up that does not block the change. */
export const IpWarningSchema = Type.Object({
  code: Type.Union([Type.Literal("outside_pc_subnets"), Type.Literal("address_in_use"), Type.Literal("same_as_current")]),
  message: Type.String({ description: "Plain words" }),
});
export type IpWarning = Static<typeof IpWarningSchema>;

export const IpCheckResultSchema = Type.Object({
  ok: Type.Boolean({ description: "false when there is at least one error" }),
  errors: Type.Array(IpFieldErrorSchema),
  warnings: Type.Array(IpWarningSchema),
});
export type IpCheckResult = Static<typeof IpCheckResultSchema>;

/**
 * `job.result` of an ip-change job (set when the job ends, also when it failed or was cancelled).
 * `ok` the change is saved on the device and the Manager uses the new address · `reverted` the device went back to its previous
 * setting · `no_dhcp_lease` switching to DHCP got no address, the device kept its previous setting · `failed` not changed (or about
 * to go back by itself) · `unknown` the Manager could not find out (the device may still be at the new address).
 */
export const IpJobResultSchema = Type.Object({
  outcome: Type.Union([Type.Literal("ok"), Type.Literal("reverted"), Type.Literal("no_dhcp_lease"), Type.Literal("failed"), Type.Literal("unknown")]),
  reason: Nullable(Type.String({ description: "Plain words, null on ok" })),
  host: Nullable(Type.String({ description: "The address the Manager now stores for the device (ip or ip:port); null when unknown" })),
  ipMode: IpModeSchema,
});
export type IpJobResult = Static<typeof IpJobResultSchema>;

/** Error codes of the ip-change job (`job.error.code`) and of the start route. */
export const IP_JOB_ERROR_CODES = ["reverted", "not_reachable", "no_dhcp_lease", "confirm_refused", "lost_device", "cancelled"] as const;
export type IpJobErrorCode = (typeof IP_JOB_ERROR_CODES)[number];
