import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createNadoVenue } from "./adapter.js";
import { fromX18 } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/nado/${name}.json`, import.meta.url),
  "utf8",
));
const now = Date.parse("2026-09-30T04:31:20.000Z");

it("reads x18-scaled values exactly", () => {
  expect(["354420000000000000000", "10000000000000000", "5000000000000000", "-32468287934252", "0", "1000000000000000000"].map(fromX18))
    .toEqual(["354.42", "0.01", "0.005", "-0.000032468287934252", "0", "1"]);
});

it("lists reviewed stock perpetuals, prices them in one query, and converts 24-hour funding to hourly", async () => {
  const http = { post: vi.fn(async (path: string, body: { type?: string }) =>
    path === "/archive/v1" ? fixture("funding-rates") : fixture(body.type === "symbols" ? "symbols" : "market-prices")) };
  const venue = createNadoVenue(http, () => now);
  const signal = new AbortController().signal;

  const instruments = await venue.discover(signal);
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId, item.metadata?.productId]).sort()).toEqual([
    ["BBX-PERP", "equity:BBX", 164], ["NVDA-PERP", "equity:NVDA", 112], ["TSLA-PERP", "equity:TSLA", 114],
  ]);
  expect(instruments.find(item => item.venueSymbol === "TSLA-PERP")).toMatchObject({ instrumentId: "ins_nado_TSLA-PERP", tickSize: "0.01",
    lotSize: "0.005", fundingInterval: 3_600_000 });

  const tops = await venue.tops(instruments, signal);
  const tsla = fixture("market-prices").data.market_prices.find((row: { product_id: number }) => row.product_id === 114);
  expect(tops.get("TSLA-PERP")).toEqual({ sourceTimestampMs: now, flags: ["client_receipt_timestamp", "top_of_book_size_unknown"],
    bid: { price: fromX18(tsla.bid_x18), quantity: "0" }, ask: { price: fromX18(tsla.ask_x18), quantity: "0" } });
  expect(http.post.mock.calls[1]![1]).toEqual({ type: "market_prices", product_ids: expect.arrayContaining([112, 114, 164]) });

  const funding = await venue.funding(instruments, signal);
  const rate = fixture("funding-rates")["114"];
  expect(funding.get("TSLA-PERP")).toEqual({ rate: fromX18((BigInt(rate.funding_rate_x18) / 24n).toString()), intervalMs: 3_600_000,
    rateType: "predicted", sourceTimestampMs: Number(rate.update_time) * 1_000,
    nextSettlementMs: Math.floor(Number(rate.update_time) / 3_600) * 3_600_000 + 3_600_000, flags: ["rate_from_24h", "hourly_settlement_assumed"] });
  expect(funding.has("BTC-PERP")).toBe(false);
});
