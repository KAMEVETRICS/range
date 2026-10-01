import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createLighterVenue } from "./adapter.js";
import { LighterMarketStatsFeed } from "./feed.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/lighter/${name}.json`, import.meta.url),
  "utf8",
));

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.dispatchEvent(new Event("close")); }
  open() { this.dispatchEvent(new Event("open")); }
  emit(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}

it("subscribes on first use, serves the latest stats, and reconnects after the socket closes", async () => {
  const [connected, snapshot, update] = fixture("market-stats-messages");
  const sockets: FakeSocket[] = [];
  let now = 1_000;
  const feed = new LighterMarketStatsFeed(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
    () => now);
  const signal = new AbortController().signal;

  const first = feed.latest(signal);
  sockets[0]!.open();
  sockets[0]!.emit(connected);
  sockets[0]!.emit(snapshot);
  const latest = await first;
  expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: "subscribe", channel: "market_stats/all" });
  expect(latest.asOfMs).toBe(1_000);
  expect([...latest.stats.keys()].sort()).toEqual(["BTC", "NVDA", "S", "TSLA"]);

  now = 2_000;
  sockets[0]!.emit(update);
  expect((await feed.latest(signal)).asOfMs).toBe(2_000);

  sockets[0]!.close();
  const second = feed.latest(signal);
  expect(sockets).toHaveLength(2);
  sockets[1]!.open();
  sockets[1]!.emit(snapshot);
  await second;
});

it("prices listed markets from the stream, with sizes unknown, and funding as an hourly fraction", async () => {
  const [, snapshot] = fixture("market-stats-messages");
  const stats = new Map(Object.values(snapshot.market_stats as Record<string, { symbol: string; best_bid_price: string;
    best_ask_price: string; current_funding_rate: string }>).map(row => [row.symbol, { symbol: row.symbol, bestBid: row.best_bid_price,
    bestAsk: row.best_ask_price, fundingRatePct: row.current_funding_rate }]));
  const asOfMs = Date.parse("2026-09-30T02:47:00.000Z");
  const venue = createLighterVenue({ get: async () => fixture("order-books") }, { latest: async () => ({ stats, asOfMs }) });
  const signal = new AbortController().signal;
  const instruments = await venue.discover(signal);

  const tsla = stats.get("TSLA")!;
  expect((await venue.tops(instruments, signal)).get("TSLA")).toEqual({ sourceTimestampMs: asOfMs,
    flags: ["client_receipt_timestamp", "top_of_book_size_unknown"],
    bid: { price: tsla.bestBid, quantity: "0" }, ask: { price: tsla.bestAsk, quantity: "0" } });
  const funding = await venue.funding(instruments, signal);
  expect([...funding.keys()].sort()).toEqual(["NVDA", "TSLA"]);
  expect(funding.get("TSLA")).toMatchObject({ intervalMs: 3_600_000, nextSettlementMs: Date.parse("2026-09-30T03:00:00.000Z"),
    flags: ["client_receipt_timestamp", "hourly_settlement_assumed"] });
});
