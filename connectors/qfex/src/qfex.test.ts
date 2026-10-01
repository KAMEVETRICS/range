import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createQfexVenue } from "./adapter.js";
import { QfexMarketDataFeed } from "./feed.js";
import { mapQfexFunding, mapQfexInstruments } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/qfex/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = Date.parse("2026-09-30T03:46:00.000Z");

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.dispatchEvent(new Event("close")); }
  open() { this.dispatchEvent(new Event("open")); }
  emit(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}

it("lists active USD-quoted equity perpetuals only", () => {
  const instruments = mapQfexInstruments(fixture("refdata"), observedAtMs);
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId]).sort()).toEqual([
    ["BRK.B-USD", "equity:BRK.B"], ["NVDA-USD", "equity:NVDA"], ["TSLA-USD", "equity:TSLA"],
  ]);
  expect(instruments.find(item => item.venueSymbol === "TSLA-USD")).toMatchObject({ instrumentId: "ins_qfex_TSLA-USD", venue: "qfex",
    quoteAsset: "USD", settlementAsset: "USDC", fundingInterval: 3_600_000 });
});

it("derives the hourly funding rate from the annual one, settling when the countdown ends", () => {
  expect(mapQfexFunding({ type: "funding", symbol: "ZM-USD", time: "2026-09-30T03:40:57.328473217Z", funding_rate: "0.00001",
    annualised_funding_rate: "0.0876", time_remaining: 1143 })).toEqual({ symbol: "ZM-USD", rate: "0.00001",
    sourceTimestampMs: Date.parse("2026-09-30T03:40:57.328Z"), nextSettlementMs: Date.parse("2026-09-30T04:00:00.000Z") });
  expect(mapQfexFunding({ type: "bbo", symbol: "ZM-USD" })).toBeUndefined();
});

it("subscribes to every market's best prices and funding, then serves them as listed markets' tops and funding", async () => {
  const [subscribed, ...messages] = fixture("market-data-messages");
  const sockets: FakeSocket[] = [];
  const feed = new QfexMarketDataFeed(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
    () => observedAtMs);
  const venue = createQfexVenue({ get: async () => fixture("refdata") }, feed, () => observedAtMs);
  const signal = new AbortController().signal;
  const instruments = await venue.discover(signal);

  const pending = venue.tops(instruments, signal);
  sockets[0]!.open();
  sockets[0]!.emit(subscribed);
  for (const message of messages) sockets[0]!.emit(message);
  const tops = await pending;
  expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: "subscribe", channels: ["bbo", "funding"], symbols: ["*"] });

  const tsla = messages.find((m: { type: string; symbol: string }) => m.type === "bbo" && m.symbol === "TSLA-USD");
  expect(tops.get("TSLA-USD")).toEqual({ sourceTimestampMs: observedAtMs, flags: ["client_receipt_timestamp"],
    bid: { price: tsla.bid[0][0], quantity: tsla.bid[0][1] }, ask: { price: tsla.ask[0][0], quantity: tsla.ask[0][1] } });
  const funding = await venue.funding(instruments, signal);
  expect([...funding.keys()].sort()).toEqual(["NVDA-USD", "TSLA-USD"]);
  expect(funding.get("TSLA-USD")).toMatchObject({ intervalMs: 3_600_000, rateType: "predicted", flags: ["funding_rate_from_annual"] });
  expect(funding.get("TSLA-USD")!.nextSettlementMs % 3_600_000).toBe(0);
});
