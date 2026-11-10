import type { ServerResponse } from "node:http";

/**
 * Throw from a handler to produce the Manager error envelope:
 * `{ "error": "<message>", "code": "<snake_case>", "details"?: ... }`.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
): void {
  const body: { error: string; code: string; details?: unknown } = { error: message, code };
  if (details !== undefined) body.details = details;
  sendJson(res, status, body, headers);
}
