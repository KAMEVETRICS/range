import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapLighterInstruments, mapLighterStatsMessage, percentToFraction } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/lighter/${name}.json`, import.meta.url),
  "utf8",
));

it("lists the reviewed stock perpetuals only, with steps from the supported decimals", () => {
  const instruments = mapLighterInstruments(fixture("order-books"), 1_790_736_500_000);
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId]).sort()).toEqual([["NVDA", "equity:NVDA"], ["TSLA", "equity:TSLA"]]);
  expect(instruments.find(item => item.venueSymbol === "TSLA")).toMatchObject({ instrumentId: "ins_lighter_TSLA", tickSize: "0.01",
    lotSize: "0.0001", minimumNotional: "10.000000", fundingInterval: 3_600_000, metadata: { marketId: 112 } });
});

it("reads best prices and funding from stats snapshots and updates, ignoring other messages", () => {
  const [connected, snapshot, update] = fixture("market-stats-messages");
  expect(mapLighterStatsMessage(connected)).toEqual([]);
  const rows = mapLighterStatsMessage(snapshot);
  expect(rows.map(row => row.symbol).sort()).toEqual(["BTC", "NVDA", "S", "TSLA"]);
  const tsla = Object.values(snapshot.market_stats as Record<string, { symbol: string; best_bid_price: string;
    best_ask_price: string; current_funding_rate: string }>).find(row => row.symbol === "TSLA")!;
  expect(rows.find(row => row.symbol === "TSLA")).toEqual({ symbol: "TSLA", bestBid: tsla.best_bid_price, bestAsk: tsla.best_ask_price,
    fundingRatePct: tsla.current_funding_rate });
  expect(mapLighterStatsMessage(update).map(row => row.symbol)).toEqual(["BTC"]);
});

it("converts percentages to fractions exactly", () => {
  expect(["0.0017", "-0.0020", "12.5", "150", "0", "-0.0"].map(percentToFraction))
    .toEqual(["0.000017", "-0.00002", "0.125", "1.5", "0", "0"]);
  expect(percentToFraction("1e-5")).toBeUndefined();
});
