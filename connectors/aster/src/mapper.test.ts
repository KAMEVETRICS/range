import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapBookTickers, mapPremiumIndexFunding, mapFuturesInstruments } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/aster/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1_790_735_900_000;

it("lists trading USDT stock perpetuals tagged STOCK, with their funding interval", () => {
  const instruments = mapFuturesInstruments(fixture("exchange-info"), fixture("funding-info"), observedAtMs);

  expect(instruments.map(item => [item.venueSymbol, item.underlyingId])).toEqual([
    ["AAPLUSDT", "equity:AAPL"], ["TSLAUSDT", "equity:TSLA"], ["BBXUSDT", "equity:BBX"],
  ]);
  expect(instruments[1]).toMatchObject({
    instrumentId: "ins_aster_TSLAUSDT", venue: "aster", productType: "perpetual", quoteAsset: "USDT", tickSize: "0.010000",
    lotSize: "0.01", minimumNotional: "5", fundingInterval: 28_800_000, effectiveFrom: new Date(observedAtMs).toISOString(),
  });
});

it("assumes eight-hour funding, flagged, for a market without funding info", () => {
  const instruments = mapFuturesInstruments(fixture("exchange-info"), [], observedAtMs);
  expect(instruments[0]).toMatchObject({ fundingInterval: 28_800_000 });
  expect(instruments[0]!.capabilities).toContain("funding_interval_assumed");
});

it("reads every book ticker, stamped with receipt time while its last change is recent", () => {
  const input = fixture("book-ticker");
  const tops = mapBookTickers(input, observedAtMs);
  const tsla = input.find((row: { symbol: string }) => row.symbol === "TSLAUSDT");
  expect(tops.get("TSLAUSDT")).toEqual({ sourceTimestampMs: observedAtMs, flags: ["client_receipt_timestamp"],
    bid: { price: tsla.bidPrice, quantity: tsla.bidQty }, ask: { price: tsla.askPrice, quantity: tsla.askQty } });
  expect(mapBookTickers(input, tsla.time + 600_000).get("TSLAUSDT")).toEqual({ sourceTimestampMs: tsla.time,
    bid: { price: tsla.bidPrice, quantity: tsla.bidQty }, ask: { price: tsla.askPrice, quantity: tsla.askQty } });
});

it("reads funding for listed markets from the premium index", () => {
  const instruments = mapFuturesInstruments(fixture("exchange-info"), fixture("funding-info"), observedAtMs);
  const input = fixture("premium-index");
  const funding = mapPremiumIndexFunding(input, instruments);
  const tsla = input.find((row: { symbol: string }) => row.symbol === "TSLAUSDT");
  expect([...funding.keys()].sort()).toEqual(["AAPLUSDT", "BBXUSDT", "TSLAUSDT"]);
  expect(funding.get("TSLAUSDT")).toEqual({ rate: tsla.lastFundingRate, intervalMs: 28_800_000, nextSettlementMs: tsla.nextFundingTime,
    rateType: "predicted", sourceTimestampMs: tsla.time });
});
