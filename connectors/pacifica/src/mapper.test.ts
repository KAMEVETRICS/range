import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapPacificaBook, mapPacificaFunding, mapPacificaInstruments, PACIFICA_STOCKS } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/pacifica/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1_790_736_500_000;

it("lists the reviewed stock perpetuals only, since Pacifica does not mark asset classes", () => {
  const instruments = mapPacificaInstruments(fixture("info"), observedAtMs);
  expect(instruments.map(item => [item.venueSymbol, item.underlyingId]).sort()).toEqual([["NVDA", "equity:NVDA"], ["TSLA", "equity:TSLA"]]);
  expect(instruments.find(item => item.venueSymbol === "TSLA")).toMatchObject({ instrumentId: "ins_pacifica_TSLA", venue: "pacifica",
    quoteAsset: "USDC", tickSize: "0.01", lotSize: "0.001", minimumNotional: "10", fundingInterval: 3_600_000 });
  expect(PACIFICA_STOCKS.has("BTC")).toBe(false);
});

it("takes the best level on each side of a book, stamped with the book's time", () => {
  const input = fixture("book-tsla");
  expect(mapPacificaBook(input, "TSLA")).toEqual({ sourceTimestampMs: input.data.t,
    bid: { price: input.data.l[0][0].p, quantity: input.data.l[0][0].a }, ask: { price: input.data.l[1][0].p, quantity: input.data.l[1][0].a } });
  expect(() => mapPacificaBook(input, "NVDA")).toThrow();
});

it("reads the predicted hourly rate for listed markets, settling at the next hour", () => {
  const input = fixture("prices");
  const instruments = mapPacificaInstruments(fixture("info"), observedAtMs);
  const funding = mapPacificaFunding(input, instruments);
  const tsla = input.data.find((row: { symbol: string }) => row.symbol === "TSLA");
  expect([...funding.keys()].sort()).toEqual(["NVDA", "TSLA"]);
  expect(funding.get("TSLA")).toEqual({ rate: tsla.next_funding, intervalMs: 3_600_000, rateType: "predicted",
    nextSettlementMs: Math.floor(tsla.timestamp / 3_600_000) * 3_600_000 + 3_600_000, sourceTimestampMs: tsla.timestamp,
    flags: ["hourly_settlement_assumed"] });
});
