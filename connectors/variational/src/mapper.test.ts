import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapVariationalFunding, mapVariationalInstruments, mapVariationalTops } from "./mapper.js";

const fixture = () => JSON.parse(readFileSync(
  new URL("../../../tests/contracts/fixtures/variational/stats.json", import.meta.url),
  "utf8",
));
const tsla = (input: { listings: { ticker: string }[] }) => input.listings.find(row => row.ticker === "TSLA") as unknown as {
  funding_rate: string; quotes: { updated_at: string; base: { bid: string; ask: string } } };
const receivedAtMs = Date.parse("2026-09-30T02:47:00.000Z");

it("lists the reviewed stocks and funds only, never crypto listings named like funds", () => {
  const instruments = mapVariationalInstruments(fixture(), receivedAtMs);
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId]).sort()).toEqual([
    ["BBX", "equity:BBX"], ["NVDA", "equity:NVDA"], ["TSLA", "equity:TSLA"],
  ]);
  expect(instruments.find(item => item.venueSymbol === "TSLA")).toMatchObject({ instrumentId: "ins_variational_TSLA",
    fundingInterval: 28_800_000, metadata: { name: "Tesla, Inc." } });
});

it("takes indicative base quotes, current at receipt when refreshed within five minutes", () => {
  const input = fixture();
  const quote = tsla(input).quotes;
  expect(mapVariationalTops(input, receivedAtMs).get("TSLA")).toEqual({ sourceTimestampMs: receivedAtMs,
    flags: ["top_of_book_size_unknown", "rfq_indicative_quote", "client_receipt_timestamp"],
    bid: { price: quote.base.bid, quantity: "0" }, ask: { price: quote.base.ask, quantity: "0" } });

  const later = receivedAtMs + 600_000;
  expect(mapVariationalTops(input, later).get("TSLA")).toMatchObject({ sourceTimestampMs: Date.parse(quote.updated_at.slice(0, 23) + "Z"),
    flags: ["top_of_book_size_unknown", "rfq_indicative_quote"] });
});

it("converts the annual funding fraction to the rate for one interval", () => {
  const input = fixture();
  tsla(input).funding_rate = "0.1095";
  const funding = mapVariationalFunding(input, mapVariationalInstruments(input, receivedAtMs), receivedAtMs);
  expect(funding.get("TSLA")).toEqual({ rate: "0.0001", intervalMs: 28_800_000, rateType: "predicted", sourceTimestampMs: receivedAtMs,
    nextSettlementMs: Date.parse("2026-09-30T08:00:00.000Z"), flags: ["client_receipt_timestamp", "funding_rate_from_annual", "settlement_time_assumed"] });
  expect(funding.has("BTC")).toBe(false);
});
