import { describe, expect, it } from "vitest";
import { RangeApplication, type ApplicationQueries } from "@range/application";
import { hashClientToken } from "../auth.js";
import { buildServer } from "../server.js";
import { createRangeMcpHandler } from "./server.js";

const now = Date.parse("2026-09-23T12:00:00Z");
const token = "rng_client_test_only_01234567890123456789";
const pepper = "test-pepper-012345678901234567890123456789";
const queries: ApplicationQueries = {
  listVenues: async () => [], findInstruments: async () => [], getMarketSnapshot: async () => [],
  scanOpportunities: async () => [], inspectOpportunity: async () => undefined,
  getEvidence: async () => undefined, getSourceTimestamps: async () => [], getOpportunityHistory: async () => [],
  getAcceptedRevision: async () => undefined, readEvents: async () => [], latestEventOrdinal: async () => 0,
};
let requestId = 0;
async function call(method: string, params: unknown, scopes = ["market:read", "opportunity:read", "intent:create"]) {
  const handler = createRangeMcpHandler({ application: new RangeApplication(queries, () => now), pepper,
    clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes }], now: () => now });
  try {
    const response = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) }));
    expect(response.status).toBe(200);
    const body = await response.text();
    const payload = body.startsWith("event:") ? JSON.parse(body.match(/^data: (.*)$/m)![1]!) : JSON.parse(body);
    return payload.result;
  } finally { await handler.close(); }
}

describe("MCP tool contract", () => {
  it("discovers exactly the eight approved analysis and unsigned-intent tools", async () => {
    const result = await call("tools/list", {});
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "compare_funding", "create_unsigned_intent", "find_instruments", "get_market_snapshot",
      "inspect_opportunity", "list_venues", "scan_opportunities", "validate_unsigned_intent",
    ]);
    expect(result.tools.every((tool: { _meta?: Record<string, unknown> }) =>
      tool._meta?.["io.range/schemaVersion"] === 1)).toBe(true);
    const scan = result.tools.find((tool: { name: string }) => tool.name === "scan_opportunities");
    expect(scan.inputSchema.properties.limit.maximum).toBe(100);
  });

  it("preserves partial envelope fields for missing market coverage", async () => {
    const result = await call("tools/call", { name: "get_market_snapshot", arguments: { underlying: "equity:TSLA" } });
    expect(result.structuredContent).toMatchObject({ status: "partial", result: { underlying: "equity:TSLA", observations: [] },
      freshness: { oldest_input_ms: 0 }, evidence: [], warnings: ["venue coverage unavailable"], trace_id: expect.stringMatching(/^rng_trace_/) });
  });

  it("enforces intent:create on both intent tools with rejected envelopes", async () => {
    for (const [name, args] of [["create_unsigned_intent", { opportunityId: "opp_1", requestedNotionalUsd: "100", idempotencyKey: "key_1" }],
      ["validate_unsigned_intent", { intentId: `intent_${"a".repeat(64)}` }]] as const) {
      const result = await call("tools/call", { name, arguments: args }, ["market:read", "opportunity:read"]);
      expect(result.structuredContent).toMatchObject({ status: "rejected", result: { code: "INSUFFICIENT_SCOPE" } });
    }
  });

  it("rejects oversized scan input through the published schema", async () => {
    const result = await call("tools/call", { name: "scan_opportunities", arguments: { underlying: "equity:TSLA", limit: 101 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "rejected", result: { code: "INVALID_REQUEST" } });
  });

  it("authenticates before protocol handling and rejects invalid Host or Origin values", async () => {
    const app = buildServer({ application: new RangeApplication(queries, () => now), pepper,
      clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes: ["market:read"] }], now: () => now });
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    try {
      expect((await app.inject({ method: "POST", url: "/mcp", payload })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, host: "evil.example" }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, origin: "not a url" }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, host: "[::1]" }, payload })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("bounds concurrent MCP work before starting another tool call", async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => release = resolve);
    const started = new Promise<void>(resolve => entered = resolve);
    const slowQueries = { ...queries, listVenues: async () => { entered(); await blocked; return []; } };
    const app = buildServer({ application: new RangeApplication(slowQueries, () => now), pepper, mcpMaxConcurrent: 1,
      clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes: ["market:read"] }], now: () => now });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_venues", arguments: {} } };
    try {
      const first = app.inject({ method: "POST", url: "/mcp", headers, payload });
      await started;
      const rejected = await app.inject({ method: "POST", url: "/mcp", headers, payload: { ...payload, id: 2 } });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json()).toMatchObject({ status: "rejected", result: { code: "MCP_CAPACITY" } });
      release();
      expect((await first).statusCode).toBe(200);
    } finally { release(); await app.close(); }
  });
});
