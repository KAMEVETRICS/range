import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createBinanceAdapter } from "./adapter.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/binance/${name}.json`, import.meta.url),
  "utf8",
));
const responses: Record<string, string> = {
  "/fapi/v1/exchangeInfo": "exchange-info", "/fapi/v1/fundingInfo": "funding-info",
  "/fapi/v1/ticker/bookTicker": "book-ticker", "/fapi/v1/premiumIndex": "premium-index",
};

it("reads Binance's TradFi equity perpetuals through the same futures API", async () => {
  const now = fixture("exchange-info").serverTime as number;
  const http = { get: vi.fn(async (path: string) => fixture(responses[path]!)) };
  const adapter = createBinanceAdapter(http, { nowMs: () => now });
  const signal = new AbortController().signal;

  const instruments = await adapter.discover(signal);
  expect(instruments.map(item => [item.instrumentId, item.venue, item.underlyingId, item.productType === "perpetual" && item.fundingInterval]))
    .toEqual([
      ["ins_binance_TSLAUSDT", "binance", "equity:TSLA", 28_800_000],
      ["ins_binance_NVDAUSDT", "binance", "equity:NVDA", 28_800_000],
      ["ins_binance_MINIMAXUSDT", "binance", "equity:MINIMAX", 14_400_000],
    ]);
  expect(instruments[0]!.capabilities).toContain("stock_underlying_evidence=underlying_type");

  const funding = await adapter.supplement!(instruments, signal);
  expect(funding.map(event => [event.instrumentId, event.payload.kind === "funding" && event.payload.rate])).toEqual([
    ["ins_binance_TSLAUSDT", "0.00028180"], ["ins_binance_NVDAUSDT", "0.00014895"], ["ins_binance_MINIMAXUSDT", "0.00000000"],
  ]);
});
