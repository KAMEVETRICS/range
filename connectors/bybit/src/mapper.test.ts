import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapBybitInstruments, mapBybitTickers } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/bybit/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1_790_735_687_594;

it("lists only trading stock perpetuals, keyed to the venue's underlying ticker", () => {
  const { instruments, nextCursor } = mapBybitInstruments(fixture("instruments-info"), observedAtMs);

  expect(nextCursor).toBeUndefined();
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId])).toEqual([
    ["AAPLUSDT", "equity:AAPL"], ["BRKBUSDT", "equity:BRK.B"], ["TSLAUSDT", "equity:TSLA"],
  ]);
  expect(instruments[2]).toMatchObject({
    instrumentId: "ins_bybit_TSLAUSDT", venue: "bybit", productType: "perpetual", quoteAsset: "USDT", settlementAsset: "USDT",
    tickSize: "0.01", fundingInterval: 28_800_000, effectiveFrom: new Date(observedAtMs).toISOString(),
    metadata: { underlyingTicker: "TSLA", marketRegion: "US" },
  });
  expect(instruments[2]!.capabilities).toContain("stock_underlying_evidence=symbol_type");
});

it("names an Asian listing by its base coin, since its underlying ticker is an exchange code", () => {
  const input = fixture("instruments-info");
  Object.assign(input.result.list[0], { symbol: "SAMSUNGUSDT", baseCoin: "SAMSUNG", underlyingTicker: "005930", marketRegion: "KR" });
  expect(mapBybitInstruments(input, observedAtMs).instruments[0]).toMatchObject({ venueSymbol: "SAMSUNGUSDT", underlyingId: "equity:SAMSUNG",
    metadata: { underlyingTicker: "005930", marketRegion: "KR" } });
});

it("skips a malformed listing rather than failing discovery", () => {
  const input = fixture("instruments-info");
  input.result.list[0].priceFilter.tickSize = "0";
  expect(mapBybitInstruments(input, observedAtMs).instruments.map(item => item.venueSymbol)).toEqual(["BRKBUSDT", "TSLAUSDT"]);
  expect(() => mapBybitInstruments({ retCode: 10001, result: {} }, observedAtMs)).toThrow();
});

it("reads every market's top of book and funding from one tickers response, stamped with its time", () => {
  const input = fixture("tickers");
  const { tops, funding } = mapBybitTickers(input);

  expect(tops.get("TSLAUSDT")).toEqual({ sourceTimestampMs: input.time,
    bid: { price: expect.any(String), quantity: expect.any(String) }, ask: { price: expect.any(String), quantity: expect.any(String) } });
  const tsla = input.result.list.find((row: { symbol: string }) => row.symbol === "TSLAUSDT");
  expect(tops.get("TSLAUSDT")?.bid).toEqual({ price: tsla.bid1Price, quantity: tsla.bid1Size });
  expect(funding.get("TSLAUSDT")).toEqual({ rate: tsla.fundingRate, intervalMs: 28_800_000,
    nextSettlementMs: Number(tsla.nextFundingTime), rateType: "predicted", sourceTimestampMs: input.time });
});

it("leaves out an empty side and a missing funding rate", () => {
  const input = fixture("tickers");
  const row = input.result.list.find((item: { symbol: string }) => item.symbol === "AAPLUSDT");
  Object.assign(row, { bid1Price: "", bid1Size: "", fundingRate: "", nextFundingTime: "0" });
  const { tops, funding } = mapBybitTickers(input);
  expect(tops.get("AAPLUSDT")).toEqual({ sourceTimestampMs: input.time, ask: { price: row.ask1Price, quantity: row.ask1Size } });
  expect(funding.has("AAPLUSDT")).toBe(false);
});
