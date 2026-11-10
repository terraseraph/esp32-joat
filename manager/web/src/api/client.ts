import type { ErrorResponse } from "@shared/api";

/** Error thrown by `apiFetch` for any non-2xx answer (or `status: 0` when the server cannot be reached). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiInit extends Omit<RequestInit, "body"> {
  /** Plain objects/arrays are sent as JSON; strings, FormData, Blob etc. are passed through untouched. */
  body?: unknown;
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

/**
 * Same-origin JSON fetch against the Manager server. Resolves with the parsed body (`undefined` for
 * 204/empty) and rejects with `ApiError` built from the server's `{ error, code, details? }` envelope.
 */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { body, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (isRawBody(body)) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }

  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...rest, headers, body: payload });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Cannot reach the Manager server.", err instanceof Error ? err.message : err);
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const env = (parsed ?? {}) as Partial<ErrorResponse>;
    throw new ApiError(
      res.status,
      typeof env.code === "string" ? env.code : `http_${res.status}`,
      typeof env.error === "string" ? env.error : res.statusText || `Request failed (${res.status})`,
      env.details,
    );
  }
  return parsed as T;
}
