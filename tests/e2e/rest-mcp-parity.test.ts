import { describe, expect, it } from "vitest";
import { IntentService, SqlIntentStore } from "../../packages/application/src/index.js";
import { intentFixture } from "../../packages/application/src/intents.test-fixtures.js";
import { buildServer } from "../../apps/gateway/src/server.js";
import { hashClientToken } from "../../apps/gateway/src/auth.js";

const token = "rng_client_test_only_01234567890123456789";
const pepper = "test-pepper-012345678901234567890123456789";

function withoutTrace<T extends { trace_id: string }>(value: T) { return { ...value, trace_id: "rng_trace_transport" }; }

describe("REST and MCP typed parity", () => {
  it("returns identical typed envelopes from all six read tools and their REST routes", async () => {
    const f = await intentFixture();
    const app = buildServer({ application: f.application, pepper,
      clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes: ["market:read", "opportunity:read", "intent:create"] }], now: f.now });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const cases = [
        ["list_venues", {}, "/v1/venues"],
        ["find_instruments", { underlying: "equity:TSLA" }, "/v1/instruments?underlying=equity:TSLA"],
        ["get_market_snapshot", { underlying: "equity:TSLA" }, "/v1/markets/snapshot?underlying=equity:TSLA"],
        ["compare_funding", { underlying: "equity:TSLA", notional_usd: "10000", holding_horizon_ms: 60_000 },
          "/v1/funding/compare?underlying=equity:TSLA&notional_usd=10000&holding_horizon_ms=60000"],
        ["scan_opportunities", { underlying: "equity:TSLA" }, "/v1/opportunities?underlying=equity:TSLA"],
        ["inspect_opportunity", { opportunityId: "opp_spread" }, "/v1/opportunities/opp_spread"],
      ] as const;
      for (const [index, [name, args, url]] of cases.entries()) {
        const rest = await app.inject({ method: "GET", url, headers });
        expect(rest.statusCode, name).toBe(200);
        const rpc = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers,
          "content-type": "application/json", accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name, arguments: args } } });
        expect(rpc.statusCode, name).toBe(200);
        const wire = rpc.body.startsWith("event:") ? JSON.parse(rpc.body.match(/^data: (.*)$/m)![1]!) : rpc.json();
        expect(wire.result.isError, name).not.toBe(true);
        expect(withoutTrace(wire.result.structuredContent), name).toEqual(withoutTrace(rest.json()));
        expect(JSON.stringify(wire.result.structuredContent), name).not.toContain("private-locator");
      }
    } finally { await app.close(); await f.sql.end(); }
  });

  it("returns identical create and validate intent envelopes from MCP and REST", async () => {
    const f = await intentFixture();
    const intents = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const app = buildServer({ application: f.application, intents, pepper,
      clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes: ["market:read", "opportunity:read", "intent:create"] }], now: f.now });
    const headers = { authorization: `Bearer ${token}` };
    const mcp = async (id: number, name: string, args: Record<string, unknown>) => {
      const rpc = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers,
        "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
      expect(rpc.statusCode).toBe(200);
      const wire = rpc.body.startsWith("event:") ? JSON.parse(rpc.body.match(/^data: (.*)$/m)![1]!) : rpc.json();
      expect(wire.result.isError).not.toBe(true);
      return wire.result.structuredContent;
    };
    try {
      const createRest = await app.inject({ method: "POST", url: "/v1/opportunities/opp_spread/intent",
        headers: { ...headers, "idempotency-key": "idem_parity" }, payload: { requestedNotionalUsd: "5000" } });
      const createMcp = await mcp(1, "create_unsigned_intent", {
        opportunityId: "opp_spread", requestedNotionalUsd: "5000", idempotencyKey: "idem_parity",
      });
      expect(withoutTrace(createMcp)).toEqual(withoutTrace(createRest.json()));
      const intentId = createRest.json().result.intentId;
      const validateRest = await app.inject({ method: "POST", url: `/v1/intents/${intentId}/validate`, headers, payload: {} });
      const validateMcp = await mcp(2, "validate_unsigned_intent", { intentId });
      expect(withoutTrace(validateMcp)).toEqual(withoutTrace(validateRest.json()));
    } finally { await app.close(); await f.sql.end(); }
  });
});
