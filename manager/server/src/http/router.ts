import type { IncomingMessage, ServerResponse } from "node:http";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AppContext } from "../appContext";
import { HttpError, sendError, sendJson } from "./errors";

/**
 * Tiny route-table router over node:http. Routes are plain objects made with
 * `defineRoute`; the SAME table feeds the router and the OpenAPI document.
 *
 *   defineRoute({
 *     method: "GET", path: "/api/things/:id", summary: "Get a thing", tags: ["things"],
 *     params: Type.Object({ id: Type.String() }),
 *     response: ThingSchema,
 *     responses: { 404: { description: "Unknown thing" } },
 *     handler: async ({ params, app }) => ({ body: await app.things.get(params.id) }),
 *   })
 *
 * Path syntax: `:name` matches one segment; a trailing `*` matches the rest and
 * is exposed as `params.wildcard` (undecoded, no leading slash).
 * Handlers return `{ status?, body?, headers? }` (status default 200) or throw
 * `HttpError`. Routes with `rawBody: true` get the unread request stream and
 * may write the response themselves (return nothing).
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Val<S, Fallback> = S extends TSchema ? Static<S> : Fallback;

export interface RouteContext<P = Record<string, string>, Q = Record<string, never>, B = undefined> {
  req: IncomingMessage;
  res: ServerResponse;
  /** Validated (and string-coerced) path params; plus `wildcard` for `*` routes. */
  params: P;
  /** Validated query string (numbers/booleans coerced per schema). */
  query: Q;
  /** Validated JSON body (undefined when the route declares no `body` or is `rawBody`). */
  body: B;
  url: URL;
  app: AppContext;
}

export interface RouteResult<R = unknown> {
  status?: number;
  body?: R;
  headers?: Record<string, string>;
}

export interface RouteSpec<P extends TSchema | undefined, Q extends TSchema | undefined, B extends TSchema | undefined, R extends TSchema> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: P;
  query?: Q;
  body?: B;
  /** Schema of the 200 response. */
  response: R;
  /** Other documented responses (errors, 201, 204 ...). */
  responses?: Record<number, { description: string; schema?: TSchema }>;
  /** The JSON body may be omitted entirely (an empty body is treated as `{}`, so every key of `body` must be optional). */
  optionalBody?: boolean;
  /** Do not read/parse the body; the handler gets the raw stream (uploads, proxying). */
  rawBody?: boolean;
  /** Max JSON body size in bytes (default: router option, 1 MB). */
  maxBodyBytes?: number;
  handler: (
    ctx: RouteContext<Val<P, Record<string, string>>, Val<Q, Record<string, never>>, Val<B, undefined>>,
  ) => Promise<RouteResult<Static<R>> | void> | RouteResult<Static<R>> | void;
}

/** A route with its schema generics erased, for storing in the table. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Route = RouteSpec<any, any, any, any>;

export function defineRoute<P extends TSchema | undefined = undefined, Q extends TSchema | undefined = undefined, B extends TSchema | undefined = undefined, R extends TSchema = TSchema>(
  spec: RouteSpec<P, Q, B, R>,
): Route {
  return spec as Route;
}

// ---- matching ---------------------------------------------------------------

interface Compiled {
  route: Route;
  segments: string[]; // ":x" param, "*" wildcard, otherwise literal
  score: number;
}

function compile(route: Route): Compiled {
  const segments = route.path.split("/").filter(Boolean);
  const star = segments.indexOf("*");
  if (star >= 0 && star !== segments.length - 1) throw new Error(`Route ${route.path}: "*" must be the last segment`);
  // literal > param > wildcard, so /api/devices/scan beats /api/devices/:id
  const score = segments.reduce((n, s) => n * 4 + (s === "*" ? 1 : s.startsWith(":") ? 2 : 3), 0);
  return { route, segments, score };
}

function matchPath(c: Compiled, pathname: string): Record<string, string> | null {
  const parts = pathname.split("/").filter(Boolean);
  const wild = c.segments[c.segments.length - 1] === "*";
  if (wild ? parts.length < c.segments.length - 1 : parts.length !== c.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < c.segments.length; i++) {
    const seg = c.segments[i] as string;
    if (seg === "*") {
      params.wildcard = parts.slice(i).join("/");
      break;
    }
    const part = parts[i] as string;
    if (seg.startsWith(":")) {
      try {
        params[seg.slice(1)] = decodeURIComponent(part);
      } catch {
        throw new HttpError(400, "bad_request", `Malformed path segment: ${part}`);
      }
    } else if (seg !== part) {
      return null;
    }
  }
  return params;
}

// ---- validation -------------------------------------------------------------

function schemaErrors(schema: TSchema, value: unknown): { path: string; message: string }[] {
  return [...Value.Errors(schema, value)].map((e) => ({ path: e.path || "/", message: e.message }));
}

function validate(schema: TSchema, value: unknown, what: string, code: string): unknown {
  if (Value.Check(schema, value)) return value;
  throw new HttpError(400, code, `Invalid ${what}`, schemaErrors(schema, value));
}

/** Coerce string inputs (query/params) to what the schema says, then validate. */
function validateCoerced(schema: TSchema, raw: Record<string, unknown>, what: string, code: string): unknown {
  return validate(schema, Value.Convert(schema, raw), what, code);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ---- router -----------------------------------------------------------------

export interface RouterOptions {
  /** Default max JSON body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

export interface Router {
  /** Handle a request already known to be an API request. Always responds. */
  handle(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void>;
}

export function createRouter(routes: Route[], opts: RouterOptions = {}): Router {
  const defaultMax = opts.maxBodyBytes ?? 1024 * 1024;
  const compiled = routes.map(compile);

  async function dispatch(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();

    const byPath = compiled.flatMap((c) => {
      const params = matchPath(c, url.pathname);
      return params ? [{ c, params }] : [];
    });
    if (byPath.length === 0) throw new HttpError(404, "not_found", `No such endpoint: ${method} ${url.pathname}`);
    const hits = byPath.filter((h) => h.c.route.method === method).sort((a, b) => b.c.score - a.c.score);
    const hit = hits[0];
    if (!hit) {
      const allow = [...new Set(byPath.map((h) => h.c.route.method))].join(", ");
      sendError(res, 405, "method_not_allowed", `${method} not allowed on ${url.pathname}`, { allow: allow.split(", ") }, { Allow: allow });
      return;
    }
    const { route } = hit.c;

    const params = route.params ? validateCoerced(route.params, hit.params, "path parameters", "invalid_params") : hit.params;
    const queryRaw: Record<string, unknown> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      queryRaw[key] = all.length > 1 ? all : all[0];
    }
    const query = route.query ? validateCoerced(route.query, queryRaw, "query string", "invalid_query") : queryRaw;

    let body: unknown;
    if (route.body && !route.rawBody) {
      const type = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!route.optionalBody && !type.startsWith("application/json")) {
        throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
      }
      const buf = await readBody(req, route.maxBodyBytes ?? defaultMax);
      if (buf.length === 0 && route.optionalBody) {
        body = validate(route.body, {}, "request body", "invalid_body");
      } else {
        if (!type.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
        if (buf.length === 0) throw new HttpError(400, "invalid_body", "Request body required", [{ path: "/", message: "empty body" }]);
        let parsed: unknown;
        try {
          parsed = JSON.parse(buf.toString("utf8"));
        } catch (err) {
          throw new HttpError(400, "invalid_json", `Body is not valid JSON: ${(err as Error).message}`);
        }
        body = validate(route.body, parsed, "request body", "invalid_body");
      }
    }

    const result = await route.handler({ req, res, params, query, body, url, app });
    if (res.headersSent || res.writableEnded) return;
    if (!result || (result.body === undefined && result.status === undefined)) {
      res.writeHead(204, { "Cache-Control": "no-store", ...result?.headers });
      res.end();
      return;
    }
    if (result.body === undefined) {
      res.writeHead(result.status ?? 204, { "Cache-Control": "no-store", ...result.headers });
      res.end();
      return;
    }
    sendJson(res, result.status ?? 200, result.body, result.headers);
  }

  return {
    async handle(req, res, app) {
      try {
        await dispatch(req, res, app);
      } catch (err) {
        if (err instanceof HttpError) {
          sendError(res, err.status, err.code, err.message, err.details);
          return;
        }
        opts.log?.(`internal error on ${req.method} ${(req.url ?? "").split("?")[0]}: ${(err as Error)?.stack ?? err}`);
        sendError(res, 500, "internal_error", "Internal server error");
      }
    },
  };
}
