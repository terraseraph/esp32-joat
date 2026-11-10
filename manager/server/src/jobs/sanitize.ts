/** Keys that never reach a stored job (and so never a GET response or a WebSocket message). */
export const SECRET_KEY_RE = /pass|psk|secret|token|key$/i;

const MAX_DEPTH = 8;

function clean(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1) ?? null);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/**
 * A JSON-safe deep copy of a request summary with every key (at any depth) that looks like a secret removed:
 * `password`, `wifiPsk`, `apiSecret`, `authToken`, `apiKey` ... (`/pass|psk|secret|token|key$/i`).
 */
export function sanitizeParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {};
  return clean(params, 0) as Record<string, unknown>;
}

/** The same cleaning for any JSON value (a job `result`, a device `result`, `error.details`): secret-looking keys vanish at any depth. */
export function sanitizeValue(value: unknown): unknown {
  return clean(value, 0);
}
