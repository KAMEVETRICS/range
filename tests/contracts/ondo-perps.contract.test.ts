import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../../packages/event-bus/src/index.js";
import { ConnectorRuntime } from "../../packages/connector-sdk/src/index.js";
import { OndoPerpsCredentialRequiredError, OndoPerpsPublicClient, type OndoPerpsHttpPort } from "../../connectors/ondo-perps/src/client.js";
import { createOndoPerpsAdapter } from "../../connectors/ondo-perps/src/adapter.js";
import { mapOndoPerpsMarket, mapFundingEvidence } from "../../connectors/ondo-perps/src/mapper.js";

const nowMs = Date.parse("2025-03-05T15:30:00Z");
const signal = () => new AbortController().signal;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ondo-perps/${name}.json`, import.meta.url), "utf8")) as {
  provenance: { kind: string; source: string; accessibleAtCapture: boolean };
  response: unknown;
  marketInfoResponse?: unknown;
};
const contracts = fixture("markets").response;
const marketInfo = fixture("markets").marketInfoResponse;
const funding = fixture("funding-rates").response;
const history = { success: true, result: [
  { market: "AAPL-USD.P", time: "2025-03-05T12:00:00Z", fundingRate: "0.0000125" },
  { market: "AAPL-USD.P", time: "2025-03-05T08:00:00Z", fundingRate: "0.0000110" },
  { market: "AAPL-USD.P", time: "2025-03-05T04:00:00Z", fundingRate: "0.0000100" },
] };
const oi = { success: true, result: [{ market: "AAPL-USD.P", openInterest: "2394.23", notionalValue: "544683.50" }] };
const candles = { success: true, result: [{ startTime: "2025-03-05T15:00:00Z", open: "226.80", high: "228.10", low: "226.50", close: "227.50", volume: "12345.67" }] };
const depth = { success: true, result: { market: "AAPL-USD.P", time: "2025-03-05T15:30:00Z", bids: [["227.40", "100.0"]], asks: [["227.60", "80.0"]] } };

function fixtureHttp(): OndoPerpsHttpPort {
  return {
    markets: async () => marketInfo,
    contracts: async () => contracts,
    fundingRates: async () => funding,
    fundingHistory: async () => history,
    openInterest: async () => oi,
    candles: async () => candles,
    depth: async () => depth,
  };
}

describe("Ondo Perps public connector", () => {
  it("keeps Ondo Perps separate from Ondo Stocks and does not claim tokenized spot", () => {
    const row = (contracts as { result: unknown[] }).result[0];
    const pair = (marketInfo as { result: { perps: { tradingPairs: unknown[] } } }).result.perps.tradingPairs[0];
    const instrument = mapOndoPerpsMarket(row, pair, 14_400_000, nowMs);
    expect(instrument).toMatchObject({ venue: "ondo_perps", venueFamily: "ondo", productType: "perpetual", fundingInterval: 14_400_000 });
    expect(instrument.capabilities).not.toContain("tokenized_stock");
  });

  it("keeps estimated rate, next settlement, realized history, and open interest distinct", () => {
    const evidence = mapFundingEvidence(funding, history, oi, "AAPL-USD.P", nowMs);
    expect(evidence).toMatchObject({
      current: { rateType: "predicted", rate: "0.0000125", nextSettlementMs: Date.parse("2025-03-05T16:00:00Z") },
      history: [{ rateType: "realized", rate: "0.0000125", settledAtMs: Date.parse("2025-03-05T12:00:00Z") }, {}, {}],
      openInterest: { contracts: "2394.23", notionalUsd: "544683.50" },
      observedIntervalMs: 14_400_000,
    });
  });

  it("discovers only supported reference instruments and advertises only runtime output", async () => {
    const adapter = createOndoPerpsAdapter(fixtureHttp(), () => nowMs);
    const probe = await adapter.probe(signal());
    expect(probe).toMatchObject({ available: true, capabilities: ["perpetual", "orderbook_reference_only"] });
    expect(probe.capabilities).not.toEqual(expect.arrayContaining(["funding_current", "funding_history", "open_interest"]));
    const instruments = await adapter.discover(signal());
    expect(instruments).toHaveLength(1);
    expect(adapter.researchFundingEvidence()).toHaveLength(1);
    const bus = new InMemoryEventBus();
    const observations: unknown[] = [];
    const unsubscribe = await bus.subscribe("market.observation.v1", "ondo-contract", event => { observations.push(event); });
    await new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => nowMs }).pollOnce(signal());
    await unsubscribe();
    expect(observations).toEqual([expect.objectContaining({
      venue: "ondo_perps", eligibility: "reference_only", payload: { kind: "order_book", bids: [{ price: "227.40", quantity: "100.0" }], asks: [{ price: "227.60", quantity: "80.0" }], capacityUsd: "0" },
    })]);
  });

  it("does not infer a funding interval from irregular history", async () => {
    const adapter = createOndoPerpsAdapter({ ...fixtureHttp(), fundingHistory: async () => ({ success: true, result: [
      history.result[0], { ...history.result[1], time: "2025-03-05T09:30:00Z" }, history.result[2],
    ] }) }, () => nowMs);
    expect(await adapter.discover(signal())).toEqual([]);
  });

  it("sends fixed-host GET requests with no auth or action methods", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const client = new OndoPerpsPublicClient(async (url, init) => {
      requests.push({ url: new URL(url), init });
      const path = new URL(url).pathname;
      return Response.json(path === "/v1/markets" ? marketInfo : path.endsWith("/contracts") ? contracts : path.endsWith("/funding_rates") ? funding : path.endsWith("/funding_rate_history") ? history : path.endsWith("/open_interest") ? oi : path.endsWith("/depth") ? depth : candles);
    }, { nowMs: () => nowMs, sleep: async () => undefined });
    await createOndoPerpsAdapter(client, () => nowMs).probe(signal());
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.url.origin).toBe("https://api.ondoperps.xyz");
      expect(request.url.pathname).toMatch(/^\/v1\/(markets|perps\/(contracts|funding_rates|funding_rate_history|open_interest|depth))$/);
      expect(request.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(Object.keys(request.init.headers ?? {})).not.toEqual(expect.arrayContaining(["Authorization", "X-Api-Key", "Cookie"]));
    }
  });

  it("marks a public 401 or 403 as credential required without exposing provider text", async () => {
    for (const status of [401, 403]) {
      const client = new OndoPerpsPublicClient(async () => new Response("private-provider-detail", { status }));
      let error: unknown;
      try { await client.contracts(signal()); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(OndoPerpsCredentialRequiredError);
      expect(JSON.stringify(error)).not.toContain("private-provider-detail");
      expect(String(error)).not.toContain("private-provider-detail");
    }
  });

  it("honors public rate limits and rejects oversized payloads with static diagnostics", async () => {
    const limited = new OndoPerpsPublicClient(async () => new Response("private-provider-detail", { status: 429, headers: { "retry-after": "2" } }));
    await expect(limited.contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 });
    const oversized = new OndoPerpsPublicClient(async () => new Response("private-provider-detail", { headers: { "content-length": "2000001" } }));
    let error: unknown;
    try { await oversized.contracts(signal()); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "ADAPTER_FAILURE" });
    expect(JSON.stringify(error)).not.toContain("private-provider-detail");
  });
});
