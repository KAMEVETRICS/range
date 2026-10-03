import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import SwaggerParser from "@apidevtools/swagger-parser";
import { responseSchemas, StreamQuerySchema, ResumeIdSchema } from "@range/application";
import { routes } from "./routes/index.js";
import { intentRoutes } from "./routes/intents.js";

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

/** What each operation answers, written for people and for agents choosing a call. */
const TAGS = [
  { name: "Opportunities", description: "Pairs priced after every cost, the results that clear them, and the evidence behind each." },
  { name: "Funding", description: "What a position pays or collects, settlement by settlement." },
  { name: "Markets", description: "Instruments, live observations, and the cross-venue price and funding board." },
  { name: "Venues", description: "Connected venues and their live health." },
  { name: "Streaming", description: "Server-Sent Events for result and venue-health changes." },
  { name: "Intents", description: "Unsigned, expiring trade intents. Range never signs or submits an order." },
];
const OPERATIONS: Record<string, { tag: string; summary: string; description: string }> = {
  listVenues: { tag: "Venues", summary: "List venues and their health",
    description: "Every connected venue with its capabilities, freshness budget and live health: connection state, age of its last event, clock skew, sequence integrity and rate-limit state. A degraded, stale or missing venue is excluded from actionable results." },
  findInstruments: { tag: "Markets", summary: "Find instruments and their mappings",
    description: "Canonical instruments by underlying (for example `equity:NVDA`) or venue, with their venue symbols and the reviewed mappings that join one stock across venues." },
  getMarketSnapshot: { tag: "Markets", summary: "Live books and funding for one stock",
    description: "The latest order-book and funding observations Range holds for an underlying, each with its source time, receive time and freshness budget. Filter by venue." },
  getMarketOverview: { tag: "Markets", summary: "Prices and funding across venues",
    description: "The board behind the dashboard's Markets page: for each ticker, every venue's latest price and funding (rate per settlement, settlement interval, next settlement, and per-hour, per-8-hour and yearly equivalents). Matched by ticker without a reviewed mapping, so it is display data and never produces an opportunity." },
  compareFunding: { tag: "Funding", summary: "Compare funding over a holding window",
    description: "What a long and a short position of `notional_usd` would pay or collect on each venue over the next `holding_horizon_ms`, settlement by settlement, in USD and bps. Bitget settles every 8 hours and trade.xyz every hour, so their headline rates are not comparable; these cashflows are." },
  scanOpportunities: { tag: "Opportunities", summary: "Scan the current actionable results for one stock",
    description: "For each pair and direction of one stock, the newest result while it is actionable and unexpired: both legs' average and worst fills at the evaluated notional, every cost, expected funding, net edge, capacity, freshness and an evidence hash. Usually empty, because most gaps do not clear their costs; `/v1/pairs` says how close each one is. Price-spread results stay valid for about 2 seconds and funding results for up to 30." },
  inspectOpportunity: { tag: "Opportunities", summary: "Inspect one result with its evidence",
    description: "One result by id with its evidence: the exact book and funding updates behind it, their source and receive times, and the history of its rejections. A result that is no longer current comes back as expired, for research. The public deployment keeps results for 48 hours." },
  getPairEvaluations: { tag: "Opportunities", summary: "The latest evaluation of every reviewed pair",
    description: "Every reviewed pair, strategy and direction with its latest evaluation, rejections included: status, gross spread, expected funding, costs, net edge, capacity and rejection reasons such as below costs, stale quote or unsynchronized inputs. The reason nothing is actionable is part of the answer. Refreshed every 2 seconds." },
  createUnsignedIntent: { tag: "Intents", summary: "Create an unsigned, expiring intent",
    description: "Constrained unsigned analysis only: Range derives the legs, and nothing is signed or submitted. Needs the `intent:create` scope, which the public deployment does not grant. Every hand-off requires fresh validation; a changed result returns a separate proposal." },
  validateUnsignedIntent: { tag: "Intents", summary: "Revalidate an intent against current state",
    description: "Checks an unsigned intent against current state before any external hand-off: unchanged, expired, or changed with a separate proposal. Needs the `intent:create` scope, which the public deployment does not grant." },
  streamChanges: { tag: "Streaming", summary: "Stream result and venue-health changes", description: "" },
};
const doc = (operationId: string) => {
  const entry = OPERATIONS[operationId];
  if (!entry) throw new Error(`No documentation for operation ${operationId}`);
  return { tags: [entry.tag], summary: entry.summary, ...(entry.description ? { description: entry.description } : {}) };
};
type Operation = { operationId: string; security: Array<{ rangeToken: string[] }>; parameters: unknown[];
  responses: Record<string, Response>; [key: string]: unknown };
export function generateOpenApi() {
  const paths: Record<string, { get?: Operation; post?: Operation }> = {};
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 429, 503].map(status => [String(status), {
    description: "Rejected request; no current result is implied", content: { "application/json": { schema: json(responseSchemas.error) } },
  }]));
  for (const route of routes) {
    paths[route.path.replace(":id", "{id}")] = { get: { operationId: route.operationId, ...doc(route.operationId), security: [{ rangeToken: [] }],
      "x-required-scopes": [route.scope], parameters: [...parameters(route.query, "query"), ...parameters(route.params, "path")],
      responses: { "200": { description: "Source-aligned Range response", content: { "application/json": { schema: json(route.response) } } }, ...errors } } };
  }
  for (const route of intentRoutes) paths[route.path.replace(":id", "{id}")] = { post: {
    operationId: route.operationId, ...doc(route.operationId), security: [{ rangeToken: [] }], "x-required-scopes": [route.scope], parameters: [...parameters(route.params, "path"),
      ...(route.idempotencyKey ? [{ name: "Idempotency-Key", in: "header", required: true, schema: json(route.idempotencyKey, "input") }] : [])],
    requestBody: { required: true, content: { "application/json": { schema: json(route.body, "input") } } },
    responses: { "200": { description: "Immutable unsigned intent or explicit validation outcome", content: { "application/json": { schema: json(route.response) } } }, ...errors },
  } };
  paths["/v1/stream"] = { get: { operationId: "streamChanges", ...doc("streamChanges"), security: [{ rangeToken: [] }], "x-required-scopes": ["market:read", "opportunity:read"],
    description: "SSE opportunity and health changes. IDs are evt_<durable ordinal>; Last-Event-ID resumes strictly after that cursor. No cursor starts at the current tail. Heartbeat comments every 15 seconds. Replay rechecks currentness (each pair and direction's newest actionable result, until it expires) and emits explicit invalidations for replaced or expired opportunities. Slow clients disconnect at a bounded queue; reconnect with the last received event ID.",
    parameters: [...parameters(StreamQuerySchema, "query"), { name: "Last-Event-ID", in: "header", required: false, schema: json(ResumeIdSchema) }],
    responses: { "200": { description: "SSE frames; JSON data always validates against one of the Range event envelopes",
      content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors },
    "x-event-envelopes": { opportunity: json(responseSchemas.opportunity), invalidation: json(responseSchemas.invalidation), health: json(responseSchemas.health) },
  } };
  return { openapi: "3.1.0",
    info: { title: "Range read API", version: "1.0.0",
      description: "Read-only intelligence for tokenized-stock perpetuals on Bitget and trade.xyz: every reviewed pair priced in both directions against executable order-book depth, fees, slippage and funding, with the evidence behind every number. Range holds no keys and places no orders. Every response is an envelope with `status`, `as_of`, `freshness`, `result`, `evidence`, `warnings` and `trace_id`." },
    servers: [
      { url: "https://range.datatides.xyz", description: "Public deployment. Read operations need no token: its proxy adds a read-only one, so any value or none works. Intent operations are refused." },
      { url: "http://127.0.0.1:8080", description: "A self-hosted gateway. Every call needs a bearer token with the operation's scope." },
    ],
    tags: TAGS, paths,
    components: { securitySchemes: { rangeToken: { type: "http", scheme: "bearer", description: "Scoped Range client token, stored as a peppered HMAC hash. Not needed on the public deployment, whose proxy supplies a read-only one. intent:create permits constrained unsigned analysis and validation only." } } } };
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
