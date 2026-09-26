import { randomUUID } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { ApplicationError, type IntentService, type RangeApplication } from "@range/application";
import { ClientAuth, type ClientRecord } from "../auth.js";
import { createRangeMcpServer } from "./tools.js";

export interface RangeMcpOptions { application: RangeApplication; intents?: IntentService; pepper: string;
  clients: readonly ClientRecord[]; now?: () => number }

export function createRangeMcpHandler(options: RangeMcpOptions, auth = new ClientAuth(options.clients, options.pepper, options.now)) {
  const handler = createMcpHandler(({ authInfo }) => {
    if (!authInfo) throw new ApplicationError(401, "UNAUTHORIZED");
    const client = options.clients.find(item => item.id === authInfo.clientId);
    if (!client) throw new ApplicationError(401, "UNAUTHORIZED");
    const suppliedTrace = authInfo.extra?.rangeTraceId;
    const traceId = typeof suppliedTrace === "string" && /^rng_trace_[A-Za-z0-9-]+$/.test(suppliedTrace)
      ? suppliedTrace : `rng_trace_${randomUUID()}`;
    return createRangeMcpServer(options, { client, auth, traceId });
  }, { responseMode: "json", maxRequestBodySize: 16_384 });
  return {
    ...handler,
    fetch: async (request: Request, settings?: { parsedBody?: unknown; authInfo?: AuthInfo }) => {
      try {
        const client = settings?.authInfo
          ? options.clients.find(item => item.id === settings.authInfo!.clientId)
          : auth.authorize(request.headers.get("authorization") ?? undefined, []);
        if (!client) throw new ApplicationError(401, "UNAUTHORIZED");
        return handler.fetch(request, { ...settings, authInfo: { token: "redacted", clientId: client.id,
          scopes: [...client.scopes], extra: settings?.authInfo?.extra } });
      } catch (error) {
        const code = error instanceof ApplicationError ? error.code : "UNAUTHORIZED";
        return Response.json(options.application.error({ traceId: `rng_trace_${randomUUID()}`, clientId: "anonymous" }, code),
          { status: error instanceof ApplicationError ? error.statusCode : 401 });
      }
    },
  };
}
