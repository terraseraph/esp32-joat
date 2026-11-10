import { ApiError } from "../../api/client";

/**
 * POST JSON and also return the HTTP status (`apiFetch` hides it, and `POST /api/devices` answers 201 for a new
 * device and 200 for one that was already in the fleet). Errors become `ApiError` like everywhere else.
 */
export async function postJsonWithStatus<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, "network_error", "Cannot reach the Manager server.", err instanceof Error ? err.message : err);
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const env = (parsed ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
    throw new ApiError(
      res.status,
      typeof env.code === "string" ? env.code : `http_${res.status}`,
      typeof env.error === "string" ? env.error : res.statusText || `Request failed (${res.status})`,
      env.details,
    );
  }
  return { status: res.status, data: parsed as T };
}
