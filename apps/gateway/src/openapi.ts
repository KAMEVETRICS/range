import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import SwaggerParser from "@apidevtools/swagger-parser";
import { responseSchemas, StreamQuerySchema, ResumeIdSchema } from "@range/application";
import { routes } from "./routes/index.js";

function json(schema: z.ZodType, io: "input" | "output" = "output") {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { target: "draft-2020-12", io });
  return document;
}
function parameters(schema: z.ZodType | undefined, location: "query" | "path") {
  if (!schema) return [];
  const document = json(schema, "input");
  return Object.entries(document.properties ?? {}).map(([name, schema]) => ({ name, in: location,
    required: location === "path" || (document.required ?? []).includes(name), schema }));
}
type Response = { description: string; content: Record<string, { schema: Record<string, unknown> }> };
type Operation = { operationId: string; security: Array<{ rangeToken: string[] }>; parameters: unknown[];
  responses: Record<string, Response>; [key: string]: unknown };
export function generateOpenApi() {
  const paths: Record<string, { get: Operation }> = {};
  const errors = Object.fromEntries([400, 401, 403, 404, 429, 503].map(status => [String(status), {
    description: "Rejected request; no current result is implied", content: { "application/json": { schema: json(responseSchemas.error) } },
  }]));
  for (const route of routes) {
    paths[route.path.replace(":id", "{id}")] = { get: { operationId: route.operationId, security: [{ rangeToken: [] }],
      "x-required-scopes": [route.scope], parameters: [...parameters(route.query, "query"), ...parameters(route.params, "path")],
      responses: { "200": { description: "Source-aligned Range response", content: { "application/json": { schema: json(route.response) } } }, ...errors } } };
  }
  paths["/v1/stream"] = { get: { operationId: "streamChanges", security: [{ rangeToken: [] }], "x-required-scopes": ["market:read", "opportunity:read"],
    description: "SSE opportunity and health changes. IDs are evt_<durable ordinal>; Last-Event-ID resumes strictly after that cursor. No cursor starts at the current tail. Heartbeat comments every 15 seconds. Replay rechecks authoritative currentness and emits explicit invalidations for historical opportunities. Slow clients disconnect at a bounded queue; reconnect with the last received event ID.",
    parameters: [...parameters(StreamQuerySchema, "query"), { name: "Last-Event-ID", in: "header", required: false, schema: json(ResumeIdSchema) }],
    responses: { "200": { description: "SSE frames; JSON data always validates against one of the Range event envelopes",
      content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors },
    "x-event-envelopes": { opportunity: json(responseSchemas.opportunity), invalidation: json(responseSchemas.invalidation), health: json(responseSchemas.health) },
  } };
  return { openapi: "3.1.0", info: { title: "Range read API", version: "1.0.0" }, paths,
    components: { securitySchemes: { rangeToken: { type: "http", scheme: "bearer", description: "Scoped Range client token. Stored as a peppered HMAC hash. intent:create is reserved for the later unsigned-intent API." } } } };
}
export async function validateOpenApi(document: ReturnType<typeof generateOpenApi>) {
  await SwaggerParser.validate(structuredClone(document) as SwaggerParser["api"]);
}
async function main() {
  const document = generateOpenApi();
  await validateOpenApi(document);
  const expected = `${JSON.stringify(document, null, 2)}\n`;
  const file = new URL("../openapi.json", import.meta.url);
  if (process.argv.includes("--write")) await writeFile(file, expected);
  else if (await readFile(file, "utf8") !== expected) throw new Error("OpenAPI artifact is stale; run openapi:generate");
  process.stdout.write("OpenAPI validated; route contracts and generated artifact agree.\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("OpenAPI validation or artifact check failed.\n"); process.exitCode = 1; });
}
