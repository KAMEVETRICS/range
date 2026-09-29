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
  provenance: { kind: string; accessibleAtCapture: boolean };
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
const depth = { success: true, result: { market: "AAPL-USD.P", time: "2025-03-05T15:30:00Z", bids: [["227.40", "100.0"]], asks: [["227.60", "80.0"]] } };

function fixtureHttp(): OndoPerpsHttpPort {
  return {
    markets: async () => marketInfo,
    contracts: async () => contracts,
    fundingRates: async () => funding,
    fundingHistory: async () => history,
    openInterest: async () => oi,
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

  it("supplements polling with reference-only funding every five minutes, one request per market", async () => {
    const requested: string[] = [];
    const adapter = createOndoPerpsAdapter({ ...fixtureHttp(), fundingRates: async market => { requested.push(market); return funding; } },
      () => nowMs);
    const instruments = await adapter.discover(signal());
    requested.length = 0;
    expect(adapter.supplementIntervalMs).toBe(300_000);

    const events = await adapter.supplement!(instruments, signal());

    expect(requested).toEqual(["AAPL-USD.P"]);
    expect(events).toEqual([expect.objectContaining({
      instrumentId: instruments[0]!.instrumentId, sourceTimestampMs: nowMs, transport: "rest", freshnessBudgetMs: 600_000,
      eligibility: "reference_only", qualityFlags: ["client_receipt_timestamp", "interval_from_history"],
      payload: { kind: "funding", rateType: "predicted", rate: "0.0000125", positiveRatePayer: "long",
        intervalMs: 14_400_000, nextSettlementMs: Date.parse("2025-03-05T16:00:00Z") },
    })]);
    expect(events[0]!.eventId).toMatch(new RegExp(`^evt_ondo_perps_${instruments[0]!.instrumentId}_funding_${nowMs}_[0-9a-f]{16}$`));
  });

  it("skips funding whose interval has already ended", async () => {
    let clock = nowMs;
    const adapter = createOndoPerpsAdapter(fixtureHttp(), () => clock);
    const instruments = await adapter.discover(signal());
    clock = Date.parse("2025-03-05T16:00:00Z");
    expect(await adapter.supplement!(instruments, signal())).toEqual([]);
  });

  it("does not infer a funding interval from irregular history", async () => {
    const adapter = createOndoPerpsAdapter({ ...fixtureHttp(), fundingHistory: async () => ({ success: true, result: [
      history.result[0], { ...history.result[1], time: "2025-03-05T09:30:00Z" }, history.result[2],
    ] }) }, () => nowMs);
    expect(await adapter.discover(signal())).toEqual([]);
  });

  it("skips untagged contracts without dropping a tagged stock in the same catalog", async () => {
    const tagged = (contracts as { result: Record<string, unknown>[] }).result[0]!;
    const untagged = { ...tagged, market: "MSFT-USD.P", baseCurrency: "MSFT" };
    delete untagged.tags;
    const requestedFundingMarkets: string[] = [];
    const adapter = createOndoPerpsAdapter({
      ...fixtureHttp(),
      contracts: async () => ({ success: true, result: [untagged, tagged] }),
      fundingRates: async market => { requestedFundingMarkets.push(market); return funding; },
    }, () => nowMs);
    const instruments = await adapter.discover(signal());
    expect(instruments.map(instrument => instrument.venueSymbol)).toEqual(["AAPL-USD.P"]);
    expect(requestedFundingMarkets).toEqual(["AAPL-USD.P"]);
  });

  it("sends fixed-host GET requests with no auth or action methods", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    let requestClock = nowMs;
    const client = new OndoPerpsPublicClient(async (url, init) => {
      requests.push({ url: new URL(url), init });
      const path = new URL(url).pathname;
      if (path === "/v1/markets") return Response.json(marketInfo);
      if (path.endsWith("/contracts")) return Response.json(contracts);
      if (path.endsWith("/funding_rates")) return Response.json(funding);
      if (path.endsWith("/funding_rate_history")) return Response.json(history);
      if (path.endsWith("/open_interest")) return Response.json(oi);
      if (path.endsWith("/depth")) return Response.json(depth);
      throw new Error("Unexpected public path");
    }, { nowMs: () => requestClock, sleep: async delay => { requestClock += delay; } });
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

  it("honors an HTTP-date Retry-After using the injected clock", async () => {
    const clock = Date.parse("2026-09-22T10:00:00Z");
    let currentTime = clock;
    const delays: number[] = [];
    let calls = 0;
    const client = new OndoPerpsPublicClient(async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": new Date(clock + 12_000).toUTCString() } })
        : Response.json(contracts);
    }, { nowMs: () => currentTime, sleep: async delay => { delays.push(delay); currentTime += delay; } });
    await expect(client.contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 12_000 });
    await client.contracts(signal());
    expect(delays).toContain(12_000);
  });

  it("uses a bounded fallback for invalid or overflowing Retry-After values", async () => {
    const clientWith = (value: string) => new OndoPerpsPublicClient(async () => new Response("rate limited", {
      status: 429, headers: { "retry-after": value },
    }), { nowMs: () => Date.parse("2026-09-22T10:00:00Z") });
    await expect(clientWith("999999999999999999999").contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 10_000 });
    await expect(clientWith("-120").contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 10_000 });
    await expect(clientWith("not-a-date").contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 10_000 });
  });

  for (const [name, header, expectedMs] of [
    ["120-second delta", "120", 120_000],
    ["next-day HTTP date", new Date(Date.parse("2026-09-22T10:00:00Z") + 86_400_000).toUTCString(), 86_400_000],
    ["30-day HTTP date", new Date(Date.parse("2026-09-22T10:00:00Z") + 30 * 86_400_000).toUTCString(), 30 * 86_400_000],
  ] as const) {
    it(`does not send another request before a valid ${name} Retry-After deadline`, async () => {
      const startedAt = Date.parse("2026-09-22T10:00:00Z");
      let currentTime = startedAt;
      const requestTimes: number[] = [];
      const sleeps: number[] = [];
      const client = new OndoPerpsPublicClient(async () => {
        requestTimes.push(currentTime);
        return requestTimes.length === 1
          ? new Response("rate limited", { status: 429, headers: { "retry-after": header } })
          : Response.json(contracts);
      }, { nowMs: () => currentTime, sleep: async delay => { sleeps.push(delay); currentTime += delay; } });
      await expect(client.contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expectedMs });
      await client.contracts(signal());
      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]).toBeGreaterThanOrEqual(startedAt + expectedMs);
      expect(sleeps.every(delay => delay <= 2_147_483_647)).toBe(true);
    });
  }

  it("cancels a long Retry-After wait before any second request", async () => {
    const startedAt = Date.parse("2026-09-22T10:00:00Z");
    let requests = 0;
    let sleepStarted!: () => void;
    const enteredSleep = new Promise<void>(resolve => { sleepStarted = resolve; });
    const client = new OndoPerpsPublicClient(async () => {
      requests += 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
    }, { nowMs: () => startedAt, sleep: async delay => {
      if (delay > 0) { sleepStarted(); await new Promise<void>(() => undefined); }
    } });
    await expect(client.contracts(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 120_000 });
    const controller = new AbortController();
    const pending = client.contracts(controller.signal);
    await enteredSleep;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(requests).toBe(1);
  });
});
