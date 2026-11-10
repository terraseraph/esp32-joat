import type { TObject, TSchema } from "@sinclair/typebox";
import { ErrorResponseSchema } from "../types/api";
import type { Route } from "./router";

/**
 * Builds an OpenAPI **3.1.0** document from the route table (3.1 because TypeBox emits
 * JSON Schema 2020-12 constructs such as `const` and `anyOf` with `type: "null"`).
 */

const WS_DESCRIPTION = `Local manager for de-esp32 devices.

**Browser WebSocket** (not expressible in OpenAPI): connect to \`/api/ws\` (ws:// or wss://, same origin rules and token
as the HTTP API). The server sends JSON text frames \`{ "t": "<type>", ... }\`. On connect: \`{ "t": "hello", "server": { "version", "lan" } }\`.
Later milestones add \`devices\`, \`device\`, \`scan\` and \`job\` messages. The browser may send JSON frames with a \`t\`; unknown types are ignored.`;

/** JSON-schema-clean copy (drops TypeBox symbol keys and the `$id` we hoist into components). */
function clean<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema)) as T;
}

function errorRef() {
  return { $ref: "#/components/schemas/Error" };
}

function parameters(where: "path" | "query", schema: TObject | undefined, pathNames: string[]) {
  const props = (schema?.properties ?? {}) as Record<string, TSchema>;
  const required = new Set<string>((schema?.required as string[] | undefined) ?? []);
  const out = Object.entries(props).map(([name, s]) => ({
    name,
    in: where,
    required: where === "path" ? true : required.has(name),
    ...(s.description ? { description: s.description } : {}),
    schema: clean(s),
  }));
  if (where === "path") {
    for (const name of pathNames) {
      if (!(name in props)) out.push({ name, in: "path", required: true, schema: { type: "string" } as unknown as TSchema });
    }
  }
  return out;
}

export function buildOpenApi(routes: readonly Route[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const r of routes) {
    // ":id" -> "{id}", trailing "*" -> "{wildcard}"
    const pathNames: string[] = [];
    const oaPath = r.path
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          pathNames.push(seg.slice(1));
          return `{${seg.slice(1)}}`;
        }
        if (seg === "*") {
          pathNames.push("wildcard");
          return "{wildcard}";
        }
        return seg;
      })
      .join("/");

    const params = [...parameters("path", r.params, pathNames), ...parameters("query", r.query, [])];
    const responses: Record<string, unknown> = {
      "200": { description: "OK", content: { "application/json": { schema: clean(r.response) } } },
    };
    for (const [status, def] of Object.entries(r.responses ?? {})) {
      responses[status] = {
        description: def.description,
        ...(def.schema ? { content: { "application/json": { schema: clean(def.schema) } } } : {}),
      };
    }
    responses.default = { description: "Error", content: { "application/json": { schema: errorRef() } } };

    const op: Record<string, unknown> = {
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      tags: r.tags,
      operationId: `${r.method.toLowerCase()}${oaPath.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
      ...(params.length ? { parameters: params } : {}),
      responses,
    };
    if (r.rawBody) {
      op.requestBody = { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } };
    } else if (r.body) {
      op.requestBody = { required: !r.optionalBody, content: { "application/json": { schema: clean(r.body) } } };
    }
    (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
  }

  return {
    openapi: "3.1.0",
    info: { title: "de-esp32 Manager API", version, description: WS_DESCRIPTION },
    "x-websocket": { path: "/api/ws", hello: { t: "hello", server: { version: "string", lan: "boolean" } } },
    security: [{ bearerAuth: [] }, { cookieAuth: [] }, {}],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "LAN mode access token (not needed on localhost)." },
        cookieAuth: { type: "apiKey", in: "cookie", name: "dem_token", description: "Set automatically after opening /?token=<token>." },
      },
      schemas: { Error: clean(ErrorResponseSchema) },
    },
  };
}
