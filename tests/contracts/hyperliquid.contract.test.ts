import { readFileSync } from "node:fs";
import { assertAdapterFixture } from "../../packages/connector-sdk/src/fixture-harness.js";
import { createHyperliquidAdapter } from "../../connectors/hyperliquid/src/adapter.js";
import {
  HyperliquidPublicClient,
  type HyperliquidInfoRequest,
  type HyperliquidWebSocketPort,
} from "../../connectors/hyperliquid/src/client.js";
import { expect, it } from "vitest";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/hyperliquid/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1770531248000;
const signal = () => new AbortController().signal;

function setup(capture: (headers: unknown) => void = () => {}) {
  const requests: { readonly url: URL; readonly init: RequestInit; readonly body: HyperliquidInfoRequest }[] = [];
  const delays: number[] = [];
  const subscriptions: string[] = [];
  let limited = false;
  let frames: unknown[] = [];
  const client = new HyperliquidPublicClient(async (url, init) => {
    const body = JSON.parse(String(init.body)) as HyperliquidInfoRequest;
    requests.push({ url: new URL(String(url)), init, body });
    capture(init.headers);
    if (limited) {
      limited = false;
      return new Response("fixture-secret-error-body", {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    const response = body.type === "perpDexs"
      ? fixture("perp-dexs")
      : body.type === "perpCategories"
        ? fixture("perp-categories")
        : body.type === "metaAndAssetCtxs"
          ? fixture("meta-and-contexts")
          : body.type === "l2Book"
            ? fixture("l2-book")
            : fixture("funding-history");
    return Response.json(response);
  }, {
    nowMs: () => observedAtMs,
    sleep: async ms => { delays.push(ms); },
  });
  const ws: HyperliquidWebSocketPort = {
    async *stream(coins) {
      subscriptions.push(...coins);
      yield* frames;
    },
  };
  const adapter = createHyperliquidAdapter(client, ws, () => observedAtMs);
  return {
    adapter,
    client,
    requests,
    delays,
    subscriptions,
    limit: () => { limited = true; },
    frames: (values: unknown[]) => { frames = values; },
  };
}

it("discovers only explicitly categorized HIP-3 equities with public-only info requests", async () => {
  const context = setup();
  const probe = await context.adapter.probe(signal());
  expect(probe).toMatchObject({
    available: true,
    capabilities: expect.arrayContaining(["perpetual", "orderbook"]),
  });
  expect(probe.capabilities).not.toEqual(expect.arrayContaining(["funding_current", "funding_history", "open_interest"]));
  const instruments = await context.adapter.discover(signal());
  expect(instruments).toHaveLength(1);
  expect(instruments[0]).toMatchObject({
    instrumentId: "ins_hyperliquid_hip3_xyz:TSLA",
    underlyingId: "equity:TSLA",
    venueFamily: "hyperliquid",
    venueSymbol: "xyz:TSLA",
    metadata: {
      dex: "xyz",
      category: "equities",
      evidenceSource: "perpCategories",
      collateralTokenIndex: 0,
    },
  });
  expect(context.requests.every(request => request.url.href === "https://api.hyperliquid.xyz/info")).toBe(true);
  expect(context.requests.every(request => request.init.method === "POST")).toBe(true);
  expect(context.requests.flatMap(request => Object.keys(request.init.headers ?? {}))).toEqual(
    expect.arrayContaining(["Content-Type"]),
  );
  expect(context.requests.every(request => Object.keys(request.init.headers ?? {}).every(
    key => !/api.?key|authorization|signature|wallet|private/i.test(key),
  ))).toBe(true);
  expect(context.requests.every(request => !/action|signature|wallet|privateKey|apiKey/i.test(JSON.stringify(request.body)))).toBe(true);
});

it("keeps current and realized funding explicitly research-only and out of runtime capabilities", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  expect(context.adapter.researchContextEvidence()).toContainEqual(expect.objectContaining({
    venueSymbol: "xyz:TSLA",
    markPx: "465.130000000000001",
    oraclePx: "450.780000000000001",
    midPx: "464.920000000000001",
    impactPxs: ["464.810000000000001", "465.040000000000001"],
    currentFunding: "0.000012500000000001",
    openInterest: "12.208000000000001",
    timestampProvenance: "client_receipt",
    researchOnly: true,
    canonicalBlockReason: "SETTLEMENT_SCHEDULE_UNAVAILABLE",
  }));
  expect(context.adapter.researchFundingEvidence()).toHaveLength(0);
  const history = await context.adapter.fetchResearchFundingHistory(
    instruments[0]!,
    observedAtMs - 86_400_000,
    observedAtMs,
    signal(),
  );
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    rateType: "realized",
    sourceTimestampMs: 1770526800076,
    timestampProvenance: "venue_source",
    researchOnly: true,
    canonicalBlockReason: "PENDING_FUNDING_NORMALIZER",
  });
  expect(context.adapter.researchFundingEvidence()).toEqual(history);
  const book = await context.adapter.snapshot(instruments[0]!, signal());
  expect(book.payload.kind).toBe("order_book");
  expect(book.payload).toMatchObject({ capacityUsd: expect.stringMatching(/^\d+(?:\.\d{1,2})?$/) });
  expect(JSON.stringify(book.payload)).not.toContain("impactPxs");
  expect(JSON.stringify(book.payload)).not.toContain("midPx");
  expect(instruments[0]?.capabilities).not.toEqual(expect.arrayContaining(["funding_current", "funding_history", "open_interest"]));
});

it("streams only public l2Book snapshots for discovered instruments", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  context.frames([
    { channel: "subscriptionResponse", data: { method: "subscribe" } },
    { channel: "pong" },
    { channel: "l2Book", data: fixture("l2-book") },
  ]);
  const events = [];
  for await (const event of context.adapter.stream!(instruments, signal())) events.push(event);
  expect(context.subscriptions).toEqual(["xyz:TSLA"]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    instrumentId: "ins_hyperliquid_hip3_xyz:TSLA",
    sourceTimestampMs: 1770531248000,
    transport: "websocket",
    payload: { kind: "order_book" },
  });
});

it("satisfies the SDK harness through factory-owned capture ports and real adapter paths", async () => {
  await assertAdapterFixture({
    factory: ports => {
      const context = setup(ports.http.recordRequest);
      let firstRateLimit = true;
      return {
        ...context.adapter,
        async parseFixtureMessage(input, parseSignal) {
          context.frames([input]);
          for await (const event of context.adapter.stream!(await context.adapter.discover(parseSignal), parseSignal)) return event;
          throw new Error("Expected a market event");
        },
        async exerciseFixtureRateLimit(probeSignal) {
          if (firstRateLimit) {
            context.limit();
            firstRateLimit = false;
          }
          try { await context.adapter.probe(probeSignal); }
          catch (error) {
            ports.diagnostics.error({ code: "public_probe_failed" });
            throw error;
          }
        },
      };
    },
    expected: {
      probe: { available: true },
      instrumentIds: ["ins_hyperliquid_hip3_xyz:TSLA"],
      snapshots: [{ instrumentId: "ins_hyperliquid_hip3_xyz:TSLA", sourceTimestampMs: 1770531248000 }],
      retryAfterMs: 2_000,
      malformedMessage: { channel: "l2Book", data: { secret: "fixture-secret" } },
    },
    credentialValues: ["fixture-secret", "fixture-secret-error-body"],
  });
});

it("paces weighted info requests, honors Retry-After, and aborts before transport", async () => {
  const context = setup();
  await Promise.all([context.client.perpDexs(signal()), context.client.perpCategories(signal())]);
  expect(context.delays.some(delay => delay >= 1_000)).toBe(true);
  context.limit();
  await expect(context.client.perpDexs(signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 });
  const aborted = new AbortController();
  aborted.abort();
  const requestCount = context.requests.length;
  await expect(context.client.perpDexs(aborted.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(context.requests).toHaveLength(requestCount);
});

it("reserves fundingHistory response-size weight before the next info request", async () => {
  const context = setup();
  await context.client.fundingHistory("xyz:TSLA", observedAtMs - 86_400_000, signal(), observedAtMs);
  await context.client.l2Book("xyz:TSLA", signal());
  expect(context.delays.some(delay => delay >= 2_250)).toBe(true);
});

it.skipIf(process.env.RUN_LIVE_HYPERLIQUID_PROBE !== "1")(
  "runs a redacted public HIP-3 live probe without credentials",
  async () => {
    const adapter = createHyperliquidAdapter(
      new HyperliquidPublicClient(),
      { async *stream() { /* REST probe only */ } },
    );
    const result = await adapter.probe(AbortSignal.timeout(60_000));
    const instruments = await adapter.discover(AbortSignal.timeout(60_000));
    const endTime = Date.now();
    const history = instruments[0]
      ? await adapter.fetchResearchFundingHistory(instruments[0], endTime - 86_400_000, endTime, AbortSignal.timeout(60_000))
      : [];
    const summary = {
      venue: adapter.venue,
      credentialMode: "public",
      available: result.available,
      hip3DexCount: adapter.dexEvidence().length,
      stockLinkedInstrumentCount: adapter.researchContextEvidence().length,
      realizedFundingRows: history.length,
    };
    console.log(JSON.stringify(summary));
    expect(summary.available).toBe(true);
    expect(summary.stockLinkedInstrumentCount).toBeGreaterThan(0);
  },
  70_000,
);

it("supplements followed markets with one context request per dex, every minute", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  expect(context.adapter.supplementIntervalMs).toBe(60_000);
  context.requests.length = 0;

  const events = await context.adapter.supplement!(instruments, signal());

  expect(context.requests.map(request => request.body)).toEqual([{ type: "metaAndAssetCtxs", dex: "xyz" }]);
  expect(events.map(event => [event.instrumentId, event.payload.kind, event.eligibility])).toEqual([
    // xyz:TSLA is a reviewed market, so its funding is executable (funding review of 2026-09-30).
    ["ins_hyperliquid_hip3_xyz:TSLA", "funding", "live"],
  ]);
});
