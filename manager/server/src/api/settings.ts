import { canonicalTarget, parseSubnet, SubnetError, TargetError } from "../discovery/sweep";
import { HttpError } from "../http/errors";
import { defineRoute } from "../http/router";
import { publicSettings, type Settings } from "../store/settings";
import { SettingsResponseSchema, SettingsUpdateSchema } from "../types/api";

/** Validate a list entry by entry; 400 `invalid_body` with one `{path, message}` per bad entry. Returns the de-duplicated canonical list. */
function checkList(key: string, list: string[], canon: (s: string) => string, bad: (e: unknown) => boolean): string[] {
  const problems: { path: string; message: string }[] = [];
  const out: string[] = [];
  list.forEach((s, i) => {
    try {
      const c = canon(s);
      if (!out.includes(c)) out.push(c);
    } catch (err) {
      if (!bad(err)) throw err;
      problems.push({ path: `/${key}/${i}`, message: (err as Error).message });
    }
  });
  if (problems.length) throw new HttpError(400, "invalid_body", `Invalid ${key}: ${problems[0]?.message}`, problems);
  return out;
}

/** Subnets are stored as typed (trimmed); parseSubnet only validates, and the scan clamps them to a /24. */
const subnetCanon = (s: string): string => {
  parseSubnet(s);
  return s.trim();
};

/** `firmwareBaseUrl` must be an http(s) URL; stored with exactly one trailing slash. */
function checkBaseUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new HttpError(400, "invalid_body", "firmwareBaseUrl must be a web address such as https://example.github.io/esp32-joat/", [{ path: "/firmwareBaseUrl", message: "not a URL" }]);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HttpError(400, "invalid_body", "firmwareBaseUrl must start with http:// or https://", [{ path: "/firmwareBaseUrl", message: "unsupported scheme" }]);
  }
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/*$/, "/");
}

export const settingsRoutes = [
  defineRoute({
    method: "GET",
    path: "/api/settings",
    summary: "Get app settings",
    description:
      "`pollIntervalS` (health poll interval, 10-300 s, default 30), `discoveryTargets` (extra host[:port] probed on every scan), `extraSubnets` (extra CIDR ranges swept on every scan) and `backgroundScan` `{enabled, periodMin}` (default off, every 5 min). The LAN access token is never part of the settings API (see GET /api/access).",
    tags: ["settings"],
    response: SettingsResponseSchema,
    handler: ({ app }) => ({ body: publicSettings(app.settings.get()) }),
  }),

  defineRoute({
    method: "PUT",
    path: "/api/settings",
    summary: "Update app settings",
    description:
      "Partial update: send only the keys to change (`backgroundScan` may carry just `enabled` or `periodMin`). Takes effect immediately (the poller reschedules, the background timer restarts). Unknown keys, including `lanToken`, are rejected with 400 invalid_body, as are invalid `discoveryTargets`/`extraSubnets` entries (details list each). Lists are replaced, de-duplicated, and targets are stored in canonical form (`http://` removed, lower case). Returns the full settings.",
    tags: ["settings"],
    body: SettingsUpdateSchema,
    response: SettingsResponseSchema,
    responses: { 400: { description: "invalid_body (out of range, unknown key, or an invalid target / subnet)" } },
    handler: async ({ app, body }) => {
      const patch: Partial<Settings> = {};
      if (body.pollIntervalS !== undefined) patch.pollIntervalS = body.pollIntervalS;
      if (body.discoveryTargets !== undefined) patch.discoveryTargets = checkList("discoveryTargets", body.discoveryTargets, canonicalTarget, (e) => e instanceof TargetError);
      if (body.extraSubnets !== undefined) patch.extraSubnets = checkList("extraSubnets", body.extraSubnets, subnetCanon, (e) => e instanceof SubnetError);
      if (body.firmwareBaseUrl !== undefined) patch.firmwareBaseUrl = checkBaseUrl(body.firmwareBaseUrl);
      if (body.defaultParallelUpdates !== undefined) patch.defaultParallelUpdates = body.defaultParallelUpdates;
      if (body.backgroundScan !== undefined) patch.backgroundScan = { ...app.settings.get().backgroundScan, ...body.backgroundScan };
      const next = Object.keys(patch).length ? await app.settings.update(patch) : app.settings.get();
      return { body: publicSettings(next) };
    },
  }),
];
