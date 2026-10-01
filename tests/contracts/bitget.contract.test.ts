import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { assertAdapterFixture } from "../../packages/connector-sdk/src/fixture-harness.js";
import { createBitgetAdapter } from "../../connectors/bitget/src/adapter.js";
import { BitgetPublicClient, type BitgetWebSocketPort } from "../../connectors/bitget/src/client.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/bitget/${name}.json`, import.meta.url), "utf8"));
const signal = () => new AbortController().signal;

function setup(capture: (headers: unknown) => void = () => {}, clock = { nowMs: () => 1_000 },
  followTicker?: (ticker: string) => boolean) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const delays: number[] = [];
  let limited = false;
  const client = new BitgetPublicClient(async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    capture(init.headers);
    if (limited) { limited = false; return new Response('secret-error-body', { status: 429, headers: { "retry-after": "2" } }); }
    const parsed = new URL(String(url));
    const name = parsed.pathname.split("/").at(-1)!;
    const body = fixture(name);
    if (Array.isArray(body.data)) body.data = body.data.filter((r: {category: string; symbol: string}) => r.category === parsed.searchParams.get("category") && (!parsed.searchParams.has("symbol") || r.symbol === parsed.searchParams.get("symbol")));
    return Response.json(body);
  }, { nowMs: clock.nowMs, sleep: async ms => { delays.push(ms); } });
  let frames: unknown[] = [];
  const subscriptions: unknown[] = [];
  const ws: BitgetWebSocketPort = { async *stream(args) { subscriptions.push(...args); yield* frames; } };
  const adapter = createBitgetAdapter(client, ws, { nowMs: clock.nowMs, ...(followTicker ? { followTicker } : {}) });
  return { adapter, client, requests, delays, subscriptions, limit: () => { limited = true; }, frames: (values: unknown[]) => { frames = values; } };
}

it("discovers response-backed capabilities using public requests and avoids Reality depth", async () => {
  const context = setup();
  expect(await context.adapter.probe(signal())).toMatchObject({available:true, capabilities:expect.arrayContaining(["spot", "perpetual", "tokenized_stock", "orderbook", "funding_current", "open_interest"])});
  const instruments = await context.adapter.discover(signal());
  const observation = await context.adapter.snapshot(instruments[0]!, signal());
  expect(observation).toMatchObject({ eligibility:"reference_only", payload:{kind:"index_price",price:"200.10"} });
  expect(context.requests.every(r => r.url.origin === "https://api.bitget.com" && r.url.pathname.startsWith("/api/v3/market/"))).toBe(true);
  expect(context.requests.map(r => Object.keys(r.init.headers ?? {})).flat()).toEqual(expect.arrayContaining(["Accept"]));
  expect(context.requests.every(r => Object.keys(r.init.headers ?? {}).every(k => !/access|authorization|signature|passphrase/i.test(k)))).toBe(true);
  expect(context.requests.some(r => r.url.pathname.endsWith("orderbook") && r.url.searchParams.get("symbol") === "RAAPLUSDT")).toBe(false);
});

it("advertises current funding from validated REST rate evidence without nextFundingTime", async () => {
  const context = setup();
  expect(fixture("tickers").data[1]).not.toHaveProperty("nextFundingTime");
  expect((await context.adapter.probe(signal())).capabilities).toContain("funding_current");
  expect(context.adapter.tickerEvidence()).toContainEqual(expect.objectContaining({
    instrumentId:"ins_bitget_USDT-FUTURES_AAPLUSDT", fundingRate:"-0.00001234",
  }));
});

it("ingests WS ticker funding and snapshot books with correct public subscriptions", async () => {
  const context = setup();
  const instruments = await context.adapter.discover(signal());
  context.frames([
    fixture("ticker-ws"),
    {arg:{instType:"usdt-futures",symbol:"AAPLUSDT",topic:"books50"}, action:"snapshot", ts:1770531248000, data:[fixture("orderbook").data]},
  ]);
  const events = [];
  for await (const event of context.adapter.stream!(instruments, signal())) events.push(event);
  expect(events.map(e => e.payload.kind)).toEqual(["index_price", "funding", "order_book"]);
  // The reviewed stock perp takes 50-level books; the unreviewed spot listing keeps five.
  expect(context.subscriptions).toContainEqual({instType:"usdt-futures",symbol:"AAPLUSDT",topic:"books50"});
  expect(context.subscriptions).toContainEqual({instType:"spot",symbol:"AAPLXUSDT",topic:"books5"});
  expect(context.subscriptions).not.toContainEqual({instType:"spot",symbol:"RAAPLUSDT",topic:"books5"});
  expect(context.adapter.tickerEvidence().find(e => e.instrumentId === "ins_bitget_USDT-FUTURES_AAPLUSDT")?.openInterest).toBe("12345.6789");
});

it("satisfies the SDK harness through factory-owned capture ports and real adapter operations", async () => {
  await assertAdapterFixture({
    factory: ports => {
      const c = setup(ports.http.recordRequest, ports.clock);
      let firstRateLimit = true;
      return { ...c.adapter,
        async parseFixtureMessage(input, signal) {
          c.frames([input]);
          for await (const event of c.adapter.stream!(await c.adapter.discover(signal), signal)) return event;
          throw new Error("Expected a market event");
        },
        async exerciseFixtureRateLimit(signal) {
          if (firstRateLimit) { c.limit(); firstRateLimit = false; }
          try { await c.adapter.probe(signal); }
          catch (error) { ports.diagnostics.error({code:"public_probe_failed"}); throw error; }
        },
      };
    },
    expected: { probe:{available:true}, instrumentIds:["ins_bitget_SPOT_RAAPLUSDT","ins_bitget_SPOT_AAPLXUSDT","ins_bitget_USDT-FUTURES_AAPLUSDT"],
      snapshots:[{instrumentId:"ins_bitget_SPOT_RAAPLUSDT",sourceTimestampMs:1770531248000},{instrumentId:"ins_bitget_SPOT_AAPLXUSDT",sourceTimestampMs:1770531248000},{instrumentId:"ins_bitget_USDT-FUTURES_AAPLUSDT",sourceTimestampMs:1770531248000}], retryAfterMs:2000, malformedMessage:{secret:"fixture-secret"} },
    credentialValues:["fixture-secret","secret-error-body"],
  });
});

it("paces concurrent public requests, honors exhausted quota and redacts failures", async () => {
  const c = setup();
  await Promise.all([c.client.market("instruments", "SPOT", signal()), c.client.market("instruments", "SPOT", signal())]);
  expect(c.delays.some(ms => ms >= 50)).toBe(true);
  c.limit();
  await expect(c.client.market("tickers", "SPOT", signal())).rejects.toMatchObject({code:"RATE_LIMITED",retryAfterMs:2000});
  const blocked = new AbortController(); blocked.abort();
  const count = c.requests.length;
  await expect(c.client.market("tickers", "SPOT", blocked.signal)).rejects.toMatchObject({code:"ABORTED"});
  expect(c.requests).toHaveLength(count);
});

it("serves Reality snapshots from one bulk ticker request per freshness window", async () => {
  let now = 1_000;
  const context = setup(() => {}, { nowMs: () => now });
  const instruments = await context.adapter.discover(signal());
  const reality = instruments.find(i => i.venueSymbol === "RAAPLUSDT")!;
  const tickerRequests = () => context.requests.filter(r => r.url.pathname.endsWith("tickers"));

  const first = await context.adapter.snapshot(reality, signal());
  await context.adapter.snapshot(reality, signal());
  expect(first).toMatchObject({ instrumentId: reality.instrumentId, payload: { kind: "index_price", price: "200.10" } });
  expect(tickerRequests()).toHaveLength(1);
  expect(tickerRequests()[0]!.url.searchParams.has("symbol")).toBe(false);

  now += 1_001;
  await context.adapter.snapshot(reality, signal());
  expect(tickerRequests()).toHaveLength(2);
});

it("follows only instruments whose stock ticker another venue lists", async () => {
  const listedElsewhere = new Set<string>();
  const context = setup(() => {}, { nowMs: () => 1_000 }, ticker => listedElsewhere.has(ticker));
  expect(await context.adapter.probe(signal())).toMatchObject({ available: false });

  listedElsewhere.add("AAPL");

  expect((await context.adapter.discover(signal())).map(instrument => instrument.venueSymbol)).toEqual(["RAAPLUSDT", "AAPLUSDT"]);
});
