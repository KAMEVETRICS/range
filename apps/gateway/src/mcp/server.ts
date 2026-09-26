import { randomUUID } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
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
    return createRangeMcpServer(options, { client, auth, traceId: `rng_trace_${randomUUID()}` });
  }, { responseMode: "json", maxRequestBodySize: 16_384 });
  return {
    ...handler,
    fetch: async (request: Request, settings?: { parsedBody?: unknown }) => {
      try {
        const client = auth.authorize(request.headers.get("authorization") ?? undefined, []);
        return handler.fetch(request, { ...settings, authInfo: { token: "redacted", clientId: client.id, scopes: [...client.scopes] } });
      } catch (error) {
        const code = error instanceof ApplicationError ? error.code : "UNAUTHORIZED";
        return Response.json(options.application.error({ traceId: `rng_trace_${randomUUID()}`, clientId: "anonymous" }, code),
          { status: error instanceof ApplicationError ? error.statusCode : 401 });
      }
    },
  };
}
