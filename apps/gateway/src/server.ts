import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { ApplicationError, StreamQuerySchema, ResumeIdSchema, type RangeApplication, type RequestContext, type IntentService } from "@range/application";
import { intentRoutes } from "./routes/intents.js";
import { ClientAuth, type ClientRecord } from "./auth.js";
import { routes } from "./routes/index.js";
import { StreamSession, type StreamOptions } from "./routes/stream.js";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createRangeMcpHandler } from "./mcp/server.js";

declare module "fastify" { interface FastifyRequest { rangeContext: RequestContext } }
export interface GatewayOptions {
  application: RangeApplication; pepper: string; clients: readonly ClientRecord[]; now?: () => number;
  log?: (entry: { trace_id: string; client_id: string; operation: string; status_code: number }) => void;
  observeLatency?: (entry: { operation: string; duration_ms: number }) => void;
  onIntentExpiry?: () => void;
  stream?: Partial<StreamOptions>;
  intents?: IntentService;
  mcpAllowedHosts?: readonly string[];
  mcpMaxConcurrent?: number;
}
export function buildServer(options: GatewayOptions) {
  const mcpMaxConcurrent = options.mcpMaxConcurrent ?? 100;
  if (!Number.isSafeInteger(mcpMaxConcurrent) || mcpMaxConcurrent < 1 || mcpMaxConcurrent > 1000) {
    throw new Error("Invalid MCP concurrency limit");
  }
  const auth = new ClientAuth(options.clients, options.pepper, options.now);
  const requestStartedAt = new WeakMap<object, number>();
  const app = Fastify({ logger: false, genReqId: () => `rng_trace_${randomUUID()}`, requestIdHeader: false,
    bodyLimit: 16_384, routerOptions: { maxParamLength: 200 } });
  app.decorateRequest("rangeContext");
  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, Date.now());
    request.rangeContext = { traceId: request.id, clientId: "anonymous" };
    reply.header("x-range-trace-id", request.id).header("cache-control", "no-store");
  });
  app.addHook("onResponse", async (request, reply) => {
    // No raw URL/query, authorization, private headers, or exception strings.
    options.log?.({ trace_id: request.id, client_id: request.rangeContext.clientId,
      operation: request.routeOptions.url ?? "unknown", status_code: reply.statusCode });
    options.observeLatency?.({ operation: request.routeOptions.url ?? "unknown",
      duration_ms: Math.max(0, Date.now() - (requestStartedAt.get(request) ?? Date.now())) });
  });
  app.setErrorHandler((error, request, reply) => {
    const applicationError = error instanceof ApplicationError;
    const invalid = error instanceof z.ZodError || (error as { statusCode?: number }).statusCode === 400;
    const code = applicationError ? error.code : invalid ? "INVALID_REQUEST" : "STORAGE_UNAVAILABLE";
    reply.code(applicationError ? error.statusCode : invalid ? 400 : 503).send(options.application.error(request.rangeContext, code));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(options.application.error(request.rangeContext, "NOT_FOUND")));
  for (const route of routes) app.get(route.path, async (request, reply) => {
    const client = auth.authorize(request.headers.authorization, [route.scope]);
    request.rangeContext.clientId = client.id;
    auth.limit(client, route.operationId);
    // A single Zod contract drives input validation and the OpenAPI document.
    const input = route.params ? route.params.parse(request.params) : route.query!.parse(request.query);
    if (route.params) z.object({}).strict().parse(request.query);
    const response = route.response.parse(await route.execute(options.application, input, request.rangeContext));
    return reply.send(response);
  });
  for (const route of intentRoutes) app.post(route.path, async (request, reply) => {
    const client = auth.authorize(request.headers.authorization, [route.scope]);
    request.rangeContext.clientId = client.id;
    auth.limit(client, route.operationId);
    z.object({}).strict().parse(request.query);
    const body = route.body.parse(request.body ?? {});
    if (!options.intents) throw new ApplicationError(503, "INTENT_SERVICE_UNAVAILABLE");
    const caller = { ...request.rangeContext, scopes: client.scopes };
    const id = route.params.parse(request.params).id;
    const result = route.idempotencyKey ? await options.intents.createUnsignedIntent({ ...body, opportunityId: id,
      idempotencyKey: route.idempotencyKey.parse(request.headers["idempotency-key"]) }, caller) : await options.intents.validateUnsignedIntent(id, caller);
    const envelope = await options.intents.response(result, caller, "intentId" in result ? result.intentId :
      result.status === "changed" ? result.proposedIntent.intentId : id!);
    if (result.status === "expired" || envelope.warnings?.includes("intent_expired_no_handoff")) options.onIntentExpiry?.();
    return reply.send(route.response.parse(envelope));
  });
  const mcp = createRangeMcpHandler(options, auth);
  const nodeMcp = toNodeHandler(mcp);
  let mcpInflight = 0;
  app.all("/mcp", async (request, reply) => {
    let host: string;
    try { host = new URL(`http://${request.headers.host ?? ""}`).hostname.toLowerCase(); }
    catch { return reply.code(403).send(options.application.error(request.rangeContext, "ORIGIN_NOT_ALLOWED")); }
    const allowedHosts = (options.mcpAllowedHosts ?? ["localhost", "127.0.0.1", "[::1]"]).map(item => item.toLowerCase());
    const origin = request.headers.origin;
    let originHost: string | undefined;
    try { originHost = origin ? new URL(origin).hostname.toLowerCase() : undefined; }
    catch { return reply.code(403).send(options.application.error(request.rangeContext, "ORIGIN_NOT_ALLOWED")); }
    if (!allowedHosts.includes(host) || (originHost && originHost !== host)) {
      return reply.code(403).send(options.application.error(request.rangeContext, "ORIGIN_NOT_ALLOWED"));
    }
    const client = auth.authorize(request.headers.authorization, []);
    request.rangeContext.clientId = client.id;
    if (mcpInflight >= mcpMaxConcurrent) throw new ApplicationError(503, "MCP_CAPACITY");
    mcpInflight += 1;
    (request.raw as typeof request.raw & { auth?: { token: string; clientId: string; scopes: string[]; extra: Record<string, unknown> } }).auth = {
      token: "redacted", clientId: client.id, scopes: [...client.scopes], extra: { rangeTraceId: request.id },
    };
    reply.raw.setHeader("x-range-trace-id", request.id);
    reply.hijack();
    try { await nodeMcp(request.raw, reply.raw, request.body); }
    finally { mcpInflight -= 1; }
  });
  const streams = new Set<StreamSession>();
  app.get("/v1/stream", async (request, reply) => {
    const client = auth.authorize(request.headers.authorization, ["market:read", "opportunity:read"]);
    request.rangeContext.clientId = client.id;
    auth.limit(client, "stream");
    if (streams.size >= (options.stream?.maxClients ?? 100)) throw new ApplicationError(503, "STREAM_CAPACITY");
    const query = StreamQuerySchema.parse(request.query);
    const resume = request.headers["last-event-id"];
    const latest = await options.application.queries.latestEventOrdinal(request.rangeContext);
    const after = resume === undefined ? latest : Number(ResumeIdSchema.parse(resume).slice(4));
    if (after > latest) throw new ApplicationError(400, "INVALID_EVENT_CURSOR");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive",
      "X-Range-Trace-Id": request.id, "X-Accel-Buffering": "no" });
    const stream = new StreamSession(options.application, request.rangeContext, reply.raw, { ...options.stream, afterOrdinal: after,
      underlying: query.underlying, expiresAtMs: client.expiresAtMs, now: options.now,
      onClose: () => { streams.delete(stream); options.log?.({ trace_id: request.id, client_id: client.id, operation: "/v1/stream", status_code: 200 });
        options.observeLatency?.({ operation: "/v1/stream", duration_ms: Math.max(0, Date.now() - (requestStartedAt.get(request) ?? Date.now())) }); } });
    streams.add(stream);
    stream.start();
  });
  // Shutdown must close hijacked sockets before Fastify waits for connections.
  app.addHook("preClose", async () => { for (const stream of streams) stream.close(); await mcp.close(); });
  return app;
}
