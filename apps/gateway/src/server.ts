import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { ApplicationError, StreamQuerySchema, ResumeIdSchema, type RangeApplication, type RequestContext } from "@range/application";
import { ClientAuth, type ClientRecord } from "./auth.js";
import { routes } from "./routes/index.js";
import { StreamSession, type StreamOptions } from "./routes/stream.js";

declare module "fastify" { interface FastifyRequest { rangeContext: RequestContext } }
export interface GatewayOptions {
  application: RangeApplication; pepper: string; clients: readonly ClientRecord[]; now?: () => number;
  log?: (entry: { trace_id: string; client_id: string; operation: string; status_code: number }) => void;
  stream?: Partial<StreamOptions>;
}
export function buildServer(options: GatewayOptions) {
  const auth = new ClientAuth(options.clients, options.pepper, options.now);
  const app = Fastify({ logger: false, genReqId: () => `rng_trace_${randomUUID()}`, requestIdHeader: false,
    bodyLimit: 16_384, routerOptions: { maxParamLength: 200 } });
  app.decorateRequest("rangeContext");
  app.addHook("onRequest", async (request, reply) => {
    request.rangeContext = { traceId: request.id, clientId: "anonymous" };
    reply.header("x-range-trace-id", request.id).header("cache-control", "no-store");
  });
  app.addHook("onResponse", async (request, reply) => {
    // No raw URL/query, authorization, private headers, or exception strings.
    options.log?.({ trace_id: request.id, client_id: request.rangeContext.clientId,
      operation: request.routeOptions.url ?? "unknown", status_code: reply.statusCode });
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
      onClose: () => { streams.delete(stream); options.log?.({ trace_id: request.id, client_id: client.id, operation: "/v1/stream", status_code: 200 }); } });
    streams.add(stream);
    stream.start();
  });
  // Shutdown must close hijacked sockets before Fastify waits for connections.
  app.addHook("preClose", async () => { for (const stream of streams) stream.close(); });
  return app;
}
