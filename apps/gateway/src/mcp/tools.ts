import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ApplicationError, CreateIntentRequestSchema, FundingCompareQuerySchema, InstrumentQuerySchema,
  IntentParamsSchema, MarketQuerySchema, OpportunityParamsSchema, PageQuerySchema, ScanQuerySchema,
  intentResponseSchemas, responseSchemas, type IntentService, type RangeApplication, type RequestContext } from "@range/application";
import type { ClientAuth, ClientRecord, Scope } from "../auth.js";

export interface ToolServices { application: RangeApplication; intents?: IntentService }
type Caller = { client: ClientRecord; auth?: ClientAuth; traceId?: string; capacity?: ToolCapacity };
const toolMeta = { "io.range/schemaVersion": 1 } as const;

export class ToolCapacity {
  private inflight = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) throw new Error("Invalid MCP concurrency limit");
  }
  enter() {
    if (this.inflight >= this.maximum) throw new ApplicationError(503, "MCP_CAPACITY");
    this.inflight += 1;
    let released = false;
    return () => { if (!released) { released = true; this.inflight -= 1; } };
  }
}

/**
 * MCP SDK v2 turns Standard Schema validation failures into an unstructured
 * tool error before the callback runs. Keep the canonical schema for tool
 * discovery, but let the adapter parse inside `execute` so callers receive
 * the same typed rejected envelope as every other Range application error.
 */
function rejectableInput<T extends z.ZodType>(schema: T): T {
  const standard = schema["~standard"];
  return { "~standard": { ...standard, validate: (value: unknown) => ({ value }) } } as unknown as T;
}

export function createRangeMcpServer(services: ToolServices, caller: Caller) {
  const server = new McpServer({ name: "range-intelligence", version: "1.0.0" }, {
    instructions: "Read-only arbitrage and funding analysis. Unsigned intents are constrained previews and require fresh validation before any external handoff. No signing or trading tools are provided.",
  });
  const authorize = (scope: Scope, operation: string) => {
    if (!caller.client.scopes.includes(scope)) throw new ApplicationError(403, "INSUFFICIENT_SCOPE");
    caller.auth?.limit(caller.client, operation);
  };
  const execute = async (scope: Scope, operation: string, run: (context: RequestContext) => Promise<unknown>) => {
    const context: RequestContext = { traceId: caller.traceId ?? `rng_trace_${randomUUID()}`, clientId: caller.client.id };
    let release: (() => void) | undefined;
    try {
      authorize(scope, operation);
      release = caller.capacity?.enter();
      const result = await run(context);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      const code = error instanceof ApplicationError ? error.code : error instanceof z.ZodError ? "INVALID_REQUEST" : "STORAGE_UNAVAILABLE";
      const result = services.application.error(context, code);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
    } finally { release?.(); }
  };
  server.registerTool("list_venues", { description: "List venue capabilities, health, and freshness budgets.", inputSchema: rejectableInput(PageQuerySchema),
    outputSchema: responseSchemas.venues, _meta: toolMeta }, async input => execute("market:read", "listVenues", context => services.application.listVenues(PageQuerySchema.parse(input), context)));
  server.registerTool("find_instruments", { description: "Find canonical instruments and venue mappings.", inputSchema: rejectableInput(InstrumentQuerySchema),
    outputSchema: responseSchemas.instruments, _meta: toolMeta }, async input => execute("market:read", "findInstruments", context => services.application.findInstruments(InstrumentQuerySchema.parse(input), context)));
  server.registerTool("get_market_snapshot", { description: "Read live, source-aligned market observations.", inputSchema: rejectableInput(MarketQuerySchema),
    outputSchema: responseSchemas.markets, _meta: toolMeta }, async input => execute("market:read", "getMarketSnapshot", context => services.application.getMarketSnapshot(MarketQuerySchema.parse(input), context)));
  server.registerTool("compare_funding", { description: "Compare long and short funding cashflows over an explicit settlement horizon, in USD and bps.",
    inputSchema: rejectableInput(FundingCompareQuerySchema), outputSchema: responseSchemas.funding, _meta: toolMeta },
    async input => execute("market:read", "compareFunding", context => services.application.compareFunding(FundingCompareQuerySchema.parse(input), context)));
  server.registerTool("scan_opportunities", { description: "Scan bounded current opportunities with explicit partial coverage.", inputSchema: rejectableInput(ScanQuerySchema),
    outputSchema: responseSchemas.opportunities, _meta: toolMeta }, async input => execute("opportunity:read", "scanOpportunities", context => services.application.scanOpportunities(ScanQuerySchema.parse(input), context)));
  server.registerTool("inspect_opportunity", { description: "Inspect one opportunity, its evidence and rejection history.",
    inputSchema: rejectableInput(z.object({ opportunityId: OpportunityParamsSchema.shape.id }).strict()), outputSchema: responseSchemas.opportunity, _meta: toolMeta },
    async input => execute("opportunity:read", "inspectOpportunity", context => {
      const parsed = z.object({ opportunityId: OpportunityParamsSchema.shape.id }).strict().parse(input);
      return services.application.inspectOpportunity({ id: parsed.opportunityId }, context);
    }));
  server.registerTool("create_unsigned_intent", { description: "Create a constrained, expiring unsigned intent preview; no signing or order submission.",
    inputSchema: rejectableInput(CreateIntentRequestSchema), outputSchema: intentResponseSchemas.create, _meta: toolMeta }, async input => execute("intent:create", "createUnsignedIntent", async context => {
      if (!services.intents) throw new ApplicationError(503, "INTENT_SERVICE_UNAVAILABLE");
      const scoped = { ...context, scopes: caller.client.scopes };
      const intent = await services.intents.createUnsignedIntent(CreateIntentRequestSchema.parse(input), scoped);
      return intentResponseSchemas.create.parse(await services.intents.response(intent, scoped, intent.intentId));
    }));
  server.registerTool("validate_unsigned_intent", { description: "Refresh and validate an unsigned intent before external handoff.",
    inputSchema: rejectableInput(z.object({ intentId: IntentParamsSchema.shape.id }).strict()), outputSchema: intentResponseSchemas.validate, _meta: toolMeta },
    async input => execute("intent:create", "validateUnsignedIntent", async context => {
      if (!services.intents) throw new ApplicationError(503, "INTENT_SERVICE_UNAVAILABLE");
      const parsed = z.object({ intentId: IntentParamsSchema.shape.id }).strict().parse(input);
      const scoped = { ...context, scopes: caller.client.scopes };
      const result = await services.intents.validateUnsignedIntent(parsed.intentId, scoped);
      return intentResponseSchemas.validate.parse(await services.intents.response(result, scoped,
        result.status === "changed" ? result.proposedIntent.intentId : parsed.intentId));
    }));
  return server;
}
