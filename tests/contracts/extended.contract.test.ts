import { readFileSync } from "node:fs";
import { loadConfig } from "../../packages/config/src/index.js";
import { InMemoryEventBus } from "../../packages/event-bus/src/in-memory.js";
import { ConnectorRuntime } from "../../packages/connector-sdk/src/runtime.js";
import { assertAdapterFixture, type AdapterFixturePorts } from "../../packages/connector-sdk/src/fixture-harness.js";
import { createExtendedAdapter } from "../../connectors/extended/src/adapter.js";
import {
  ExtendedCredentialError,
  ExtendedReadonlyClient,
  createExtendedPublicWebSocket,
  type ExtendedHttpPort,
  type ExtendedStreamRequest,
  type ExtendedWebSocketPort,
} from "../../connectors/extended/src/client.js";
import { expect, it } from "vitest";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/extended/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1770531248000;
const key = "extended-read-only-fixture-key";
const signal = () => new AbortController().signal;

function baseConfig(extendedApiKey?: string) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://range:range@localhost:5432/range",
    REDIS_URL: "redis://localhost:6379",
    REDPANDA_BROKERS: "localhost:9092",
    RANGE_API_TOKEN_PEPPER: "test-pepper-at-least-32-characters",
    ...(extendedApiKey === undefined ? {} : { EXTENDED_API_KEY: extendedApiKey }),
  });
}

function setup(
  ports?: AdapterFixturePorts,
  marketsPayload: unknown = fixture("markets"),
) {
  const requests: { readonly url: URL; readonly init: RequestInit }[] = [];
  const delays: number[] = [];
  const subscriptions: ExtendedStreamRequest[] = [];
  let limited = false;
  let rejectedStatus: 401 | 403 | undefined;
  let frames: unknown[] = [];
  const client = new ExtendedReadonlyClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    ports?.http.recordRequest({
      Accept: "application/json",
      "User-Agent": "range-contract-test/1.0",
      "X-Api-Key": "[REDACTED]",
    });
    if (rejectedStatus !== undefined) return new Response("fixture-secret-rejection", { status: rejectedStatus });
    if (limited) {
      limited = false;
      return new Response("fixture-secret-rate-limit", { status: 429, headers: { "retry-after": "2" } });
    }
    return Response.json(String(url).endsWith("/orderbook") ? fixture("orderbook") : marketsPayload);
  }, {
    nowMs: () => observedAtMs,
    sleep: async delayMs => { delays.push(delayMs); },
    userAgent: "range-contract-test/1.0",
  });
  const ws: ExtendedWebSocketPort = {
    async *stream(requested) {
      subscriptions.push(...requested);
      yield* frames;
    },
  };
  return {
    adapter: createExtendedAdapter(client, ws, key, () => observedAtMs),
    client,
    requests,
    delays,
    subscriptions,
    frames: (values: unknown[]) => { frames = values; },
    limit: () => { limited = true; },
    reject: (status: 401 | 403) => { rejectedStatus = status; },
  };
}

it("requires only the read-only Extended API key", () => {
  const context = setup();
  expect(() => createExtendedAdapter(context.client, { async *stream() {} }, undefined)).toThrow(/EXTENDED_API_KEY/);
  const config = baseConfig("read-only-test-key");
  expect(config.credentials.extendedApiKey).toBe("read-only-test-key");
  expect(Object.keys(config.credentials)).not.toContain("extendedPrivateKey");
  expect(Object.keys(config.credentials)).not.toEqual(expect.arrayContaining(["starkKey", "privateKey", "signature"]));
});

it("discovers only equities backed by the official Extended RWA registry", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  expect(instruments).toHaveLength(1);
  expect(instruments[0]).toMatchObject({
    instrumentId: "ins_extended_TSLA_24_5-USD",
    underlyingId: "equity:TSLA",
    venue: "extended",
    venueFamily: "extended",
    venueSymbol: "TSLA_24_5-USD",
    productType: "perpetual",
    fundingInterval: 3_600_000,
    capabilities: expect.arrayContaining([
      "perpetual",
      "tokenized_stock",
      "orderbook",
      "explicit_equity_evidence",
      "rfq_real_book_stream",
      "market_stats_research_only",
    ]),
    metadata: {
      assetClass: "equity",
      equityEvidenceSource: "extended_official_rwa_markets",
      marketType: "PERPETUAL",
      isRfq: true,
      isOffHours: false,
      tradingHours: "CONTINUOUS",
      researchOnlyMarketStats: {
        fundingRate: "-0.000031",
        providerNextFundingValue: 1770534000000,
        openInterestUsd: "402891.15",
      },
    },
  });
  expect(instruments.some(instrument => instrument.venueSymbol === "BTC-USD")).toBe(false);
  expect(context.adapter.marketEvidence()).toEqual([
    expect.objectContaining({
      venueSymbol: "TSLA_24_5-USD",
      assetClass: "equity",
      evidenceSource: "extended_official_rwa_markets",
      researchOnly: true,
      canonicalBlockReason: "NO_CANONICAL_MARKET_STATS_EVENT_PATH",
      providerNextFundingValue: 1770534000000,
    }),
  ]);
});

it("does not advertise funding or open-interest capabilities without canonical event paths", async () => {
  const context = setup();
  const probe = await context.adapter.probe(signal());
  expect(probe.available).toBe(true);
  expect(probe.capabilities).not.toEqual(expect.arrayContaining(["funding_current", "funding_history", "open_interest"]));
  expect(context.adapter.marketEvidence()).toEqual([
    expect.objectContaining({ researchOnly: true, canonicalBlockReason: "NO_CANONICAL_MARKET_STATS_EVENT_PATH" }),
  ]);
  const instrument = (await context.adapter.discover(signal()))[0]!;
  const snapshot = await context.adapter.snapshot(instrument, signal());
  expect(snapshot.payload.kind).toBe("order_book");
  expect(JSON.stringify(snapshot.payload)).not.toMatch(/funding|openInterest|nextSettlement/i);
});

it("publishes only the order-book capability implemented by the runtime path", async () => {
  const context = setup();
  const bus = new InMemoryEventBus();
  const observations: unknown[] = [];
  const unsubscribe = await bus.subscribe("market.observation.v1", "extended-contract", async event => {
    observations.push(event);
  });
  const runtime = new ConnectorRuntime({
    adapter: context.adapter,
    eventBus: bus,
    nowMs: () => observedAtMs,
  });
  await runtime.pollOnce(signal());
  await unsubscribe();
  expect(observations).toHaveLength(1);
  expect(observations).toEqual([
    expect.objectContaining({
      venue: "extended",
      eligibility: "reference_only",
      payload: expect.objectContaining({ kind: "order_book" }),
    }),
  ]);
  expect(JSON.stringify(observations)).not.toMatch(/"kind":"funding"|openInterest|nextSettlement/i);
});

it("sends the API key only to the fixed documented host and exposes no action endpoint", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  await context.adapter.snapshot(instruments[0]!, signal());
  expect(context.requests).toHaveLength(2);
  for (const request of context.requests) {
    expect(request.url.origin).toBe("https://api.starknet.extended.exchange");
    expect(request.url.pathname).toMatch(/^\/api\/v1\/info\//);
    expect(request.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(request.init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": "range-contract-test/1.0",
      "X-Api-Key": key,
    });
    expect(request.url.pathname).not.toMatch(/user\/order|withdraw|transfer|signature/i);
    expect(Object.keys(request.init.headers ?? {})).not.toEqual(expect.arrayContaining([
      "Stark-Key",
      "Signature",
      "Authorization",
    ]));
  }
  expect(Object.keys(context.client).join(" ")).not.toMatch(/order|withdraw|transfer|stark|signature/i);
});

it("labels RFQ REST depth as indicative and maps exact decimal levels", async () => {
  const context = setup();
  const instrument = (await context.adapter.discover(signal()))[0]!;
  const event = await context.adapter.snapshot(instrument, signal());
  expect(event).toMatchObject({
    instrumentId: "ins_extended_TSLA_24_5-USD",
    sourceTimestampMs: observedAtMs,
    transport: "rest",
    eligibility: "reference_only",
    qualityFlags: expect.arrayContaining(["rfq_indicative_book", "client_receipt_timestamp", "capacity_usd_uncomputed"]),
    payload: {
      kind: "order_book",
      bids: [{ price: "339.40", quantity: "1.25" }, { price: "339.30", quantity: "2.50" }],
      asks: [{ price: "339.60", quantity: "1.10" }, { price: "339.70", quantity: "3.00" }],
      capacityUsd: "0",
    },
  });
});

it("reconstructs a real RFQ stream only across contiguous sequence numbers", async () => {
  const context = setup();
  const instrument = (await context.adapter.discover(signal()))[0]!;
  context.frames([
    {
      ts: observedAtMs,
      type: "SNAPSHOT",
      data: {
        m: "TSLA_24_5-USD",
        b: [{ p: "339.40", q: "1.25", c: "1.25" }],
        a: [{ p: "339.60", q: "1.10", c: "1.10" }],
      },
      seq: 1,
    },
    {
      ts: observedAtMs + 100,
      type: "DELTA",
      data: {
        m: "TSLA_24_5-USD",
        b: [{ p: "339.40", q: "0.25", c: "1.50" }],
        a: [{ p: "339.60", q: "-1.10", c: "0" }, { p: "339.70", q: "2", c: "2" }],
      },
      seq: 2,
    },
  ]);
  const events = [];
  for await (const event of context.adapter.stream!([instrument], signal())) events.push(event);
  expect(context.subscriptions).toEqual([{ market: "TSLA_24_5-USD", book: "rfq_real" }]);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    sequence: 2,
    eligibility: "live",
    qualityFlags: expect.arrayContaining(["rfq_real_book"]),
    payload: {
      kind: "order_book",
      bids: [{ price: "339.40", quantity: "1.50" }],
      asks: [{ price: "339.70", quantity: "2" }],
    },
  });
});

it("keeps a non-continuous market reference-only after stale open-session discovery", async () => {
  const source = fixture("markets") as { status: "OK"; data: Record<string, unknown>[] };
  const tsla = source.data[0]!;
  const shop = {
    ...tsla,
    name: "SHOP-USD",
    assetName: "SHOP",
    tradingHours: "NO_OVERNIGHT",
    isOffHours: false,
  };
  const context = setup(undefined, { status: "OK", data: [shop] });
  const instrument = (await context.adapter.discover(signal()))[0]!;
  expect(instrument.capabilities).toEqual(expect.arrayContaining([
    "trading_hours=NO_OVERNIGHT",
    "session_state_requires_refresh",
  ]));
  context.frames([{
    ts: observedAtMs + 8 * 3_600_000,
    type: "SNAPSHOT",
    data: {
      m: "SHOP-USD",
      b: [{ p: "98.10", q: "1", c: "1" }],
      a: [{ p: "98.20", q: "1", c: "1" }],
    },
    seq: 1,
  }]);
  const events = [];
  for await (const event of context.adapter.stream!([instrument], signal())) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eligibility: "reference_only",
    qualityFlags: expect.arrayContaining(["non_continuous_schedule", "session_state_requires_refresh"]),
  });
});

for (const badSequence of [1, 3] as const) {
  it(`rejects a sequence discontinuity at ${badSequence} so the runtime reconnects and resnapshots`, async () => {
    const context = setup();
    const instrument = (await context.adapter.discover(signal()))[0]!;
    context.frames([
      { ts: observedAtMs, type: "SNAPSHOT", data: { m: instrument.venueSymbol, b: [], a: [] }, seq: 1 },
      { ts: observedAtMs + 100, type: "DELTA", data: { m: instrument.venueSymbol, b: [], a: [] }, seq: badSequence },
    ]);
    const consume = async () => {
      for await (const _event of context.adapter.stream!([instrument], signal())) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject({ code: "ADAPTER_FAILURE", message: "Connector adapter operation failed" });
  });
}

it("reports 401 and 403 without retaining the credential or response body", async () => {
  for (const status of [401, 403] as const) {
    const context = setup();
    context.reject(status);
    let error: unknown;
    try { await context.adapter.probe(signal()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ExtendedCredentialError);
    expect(error).toMatchObject({ status, message: "Extended read-only credential rejected" });
    expect(JSON.stringify(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain("fixture-secret-rejection");
  }
});

it("satisfies the SDK harness through the adapter's real credential paths", async () => {
  await assertAdapterFixture({
    factory: ports => {
      const context = setup(ports);
      let firstRateLimit = true;
      return {
        ...context.adapter,
        async parseFixtureMessage(input, parseSignal) {
          context.frames([input]);
          const instrument = (await context.adapter.discover(parseSignal))[0]!;
          for await (const event of context.adapter.stream!([instrument], parseSignal)) return event;
          throw new Error("Expected an Extended book event");
        },
        async exerciseFixtureRateLimit(probeSignal) {
          if (firstRateLimit) {
            context.limit();
            firstRateLimit = false;
          }
          try { await context.adapter.probe(probeSignal); }
          catch (error) {
            ports.diagnostics.error({ code: "extended_probe_failed" });
            throw error;
          }
        },
      };
    },
    expected: {
      probe: { available: true },
      instrumentIds: ["ins_extended_TSLA_24_5-USD"],
      snapshots: [{ instrumentId: "ins_extended_TSLA_24_5-USD", sourceTimestampMs: observedAtMs }],
      retryAfterMs: 2_000,
      malformedMessage: { type: "SNAPSHOT", data: { secret: "fixture-secret" }, seq: 1 },
    },
    credentialValues: [key, "fixture-secret", "fixture-secret-rate-limit", "fixture-secret-rejection"],
  });
});

it("paces requests and aborts before transport", async () => {
  const context = setup();
  await Promise.all([context.client.markets(key, signal()), context.client.markets(key, signal())]);
  expect(context.delays.some(delay => delay >= 60)).toBe(true);
  const aborted = new AbortController();
  aborted.abort();
  const requestCount = context.requests.length;
  await expect(context.client.markets(key, aborted.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(context.requests).toHaveLength(requestCount);
});

it("rejects oversized REST bodies before and during consumption without retaining secrets", async () => {
  const secretBody = `{"status":"OK","data":"${"fixture-secret-body".repeat(16)}"}`;
  const beforeRead = new ExtendedReadonlyClient(async () => new Response(secretBody, {
    headers: { "content-length": String(Buffer.byteLength(secretBody)) },
  }), { maxResponseBytes: 64 });
  let headerError: unknown;
  try { await beforeRead.markets(key, signal()); } catch (error) { headerError = error; }
  expect(headerError).toMatchObject({ code: "ADAPTER_FAILURE", message: "Connector adapter operation failed" });
  expect(JSON.stringify(headerError)).not.toContain(key);
  expect(JSON.stringify(headerError)).not.toContain("fixture-secret-body");

  let cancelled = false;
  const encoder = new TextEncoder();
  let chunk = 0;
  const chunkedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(chunk++ === 0 ? "fixture-secret-chunk" : "x".repeat(128)));
    },
    cancel() { cancelled = true; },
  });
  const duringRead = new ExtendedReadonlyClient(async () => new Response(chunkedBody), { maxResponseBytes: 32 });
  let streamError: unknown;
  try { await duringRead.markets(key, signal()); } catch (error) { streamError = error; }
  expect(streamError).toMatchObject({ code: "ADAPTER_FAILURE", message: "Connector adapter operation failed" });
  expect(JSON.stringify(streamError)).not.toContain(key);
  expect(JSON.stringify(streamError)).not.toContain("fixture-secret-chunk");
  expect(cancelled).toBe(true);
});

class SocketDouble {
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  close() { this.closed = true; }
}

for (const payload of [
  JSON.stringify({ padding: "fixture-secret-ws".repeat(16) }),
  new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(256) })).buffer,
] as const) {
  it(`rejects oversized WebSocket ${typeof payload === "string" ? "strings" : "bytes"} before JSON parsing and cleans up`, async () => {
    const socket = new SocketDouble();
    const transport = createExtendedPublicWebSocket(
      () => socket as unknown as WebSocket,
      { maxMessageBytes: 32 },
    );
    const iterator = transport.stream([{ market: "TSLA_24_5-USD", book: "rfq_real" }], signal())[Symbol.asyncIterator]();
    const outcome = iterator.next().then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    socket.emit("open");
    socket.emit("message", payload);
    const result = await outcome;
    expect(result.error).toMatchObject({ code: "ADAPTER_FAILURE", message: "Connector adapter operation failed" });
    expect(JSON.stringify(result.error)).not.toContain("fixture-secret-ws");
    expect(socket.closed).toBe(true);
    expect([...socket.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });
}

it.skipIf(process.env.RUN_LIVE_EXTENDED_PROBE !== "1")(
  "runs a redacted live read-only credential probe",
  async () => {
    const apiKey = process.env.EXTENDED_API_KEY;
    expect(apiKey).toBeTruthy();
    const adapter = createExtendedAdapter(
      new ExtendedReadonlyClient(),
      { async *stream() { /* REST-only probe */ } },
      apiKey,
    );
    const result = await adapter.probe(AbortSignal.timeout(60_000));
    const summary = {
      venue: adapter.venue,
      credentialScope: "read-only-by-protocol",
      providerSideScope: "not-queryable-without-a-write-attempt",
      available: result.available,
      stockLinkedInstrumentCount: adapter.marketEvidence().length,
    };
    console.log(JSON.stringify(summary));
    expect(summary.available).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(apiKey);
  },
  70_000,
);
