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
    capabilities: expect.arrayContaining(["perpetual", "orderbook", "funding_current", "funding_history", "open_interest"]),
  });
  const instruments = await context.adapter.discover(signal());
  expect(instruments).toHaveLength(1);
  expect(instruments[0]).toMatchObject({
    instrumentId: "ins_hyperliquid_hip3_xyz:TSLA",
    underlyingId: "equity:TSLA",
    venueFamily: "xyz",
    venueSymbol: "xyz:TSLA",
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

it("preserves context and realized funding evidence separately from executable book depth", async () => {
  const context = setup();
  await context.adapter.probe(signal());
  expect(context.adapter.marketEvidence()).toContainEqual(expect.objectContaining({
    venueSymbol: "xyz:TSLA",
    markPx: "465.130000000000001",
    oraclePx: "450.780000000000001",
    midPx: "464.920000000000001",
    impactPxs: ["464.810000000000001", "465.040000000000001"],
    currentFunding: "0.000012500000000001",
    openInterest: "12.208000000000001",
    timestampProvenance: "client_receipt",
  }));
  expect(context.adapter.fundingEvidence()).toHaveLength(2);
  expect(context.adapter.fundingEvidence()[0]).toMatchObject({
    rateType: "realized",
    sourceTimestampMs: 1770526800076,
  });
  const instrument = (await context.adapter.discover(signal()))[0]!;
  const book = await context.adapter.snapshot(instrument, signal());
  expect(book.payload.kind).toBe("order_book");
  expect(book.payload).toMatchObject({ capacityUsd: "0" });
  expect(JSON.stringify(book.payload)).not.toContain("impactPxs");
  expect(JSON.stringify(book.payload)).not.toContain("midPx");
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

it.skipIf(process.env.RUN_LIVE_HYPERLIQUID_PROBE !== "1")(
  "runs a redacted public HIP-3 live probe without credentials",
  async () => {
    const adapter = createHyperliquidAdapter(
      new HyperliquidPublicClient(),
      { async *stream() { /* REST probe only */ } },
    );
    const result = await adapter.probe(AbortSignal.timeout(60_000));
    const summary = {
      venue: adapter.venue,
      credentialMode: "public",
      available: result.available,
      hip3DexCount: adapter.dexEvidence().length,
      stockLinkedInstrumentCount: adapter.marketEvidence().length,
      realizedFundingRows: adapter.fundingEvidence().length,
    };
    console.log(JSON.stringify(summary));
    expect(summary.available).toBe(true);
    expect(summary.stockLinkedInstrumentCount).toBeGreaterThan(0);
  },
  70_000,
);
