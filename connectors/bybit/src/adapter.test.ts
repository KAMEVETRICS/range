import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createBybitAdapter } from "./adapter.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/bybit/${name}.json`, import.meta.url),
  "utf8",
));

it("discovers stock perpetuals, snapshots them from one tickers read, and reuses it for funding", async () => {
  const tickers = fixture("tickers");
  const http = { get: vi.fn(async (path: string) => path === "/v5/market/tickers" ? tickers : fixture("instruments-info")) };
  const adapter = createBybitAdapter(http, { nowMs: () => tickers.time });
  const signal = new AbortController().signal;

  expect(await adapter.probe(signal)).toMatchObject({ available: true });
  const instruments = await adapter.discover(signal);
  const books = [];
  for (const instrument of instruments) books.push(await adapter.snapshot(instrument, signal));
  const funding = await adapter.supplement!(instruments, signal);

  expect(instruments.map(item => item.venueSymbol)).toEqual(["AAPLUSDT", "BRKBUSDT", "TSLAUSDT"]);
  expect(http.get.mock.calls.map(call => call[0])).toEqual(["/v5/market/instruments-info", "/v5/market/tickers"]);
  expect(books.map(book => [book.instrumentId, book.eligibility, book.sourceTimestampMs])).toEqual([
    ["ins_bybit_AAPLUSDT", "reference_only", tickers.time],
    ["ins_bybit_BRKBUSDT", "reference_only", tickers.time],
    ["ins_bybit_TSLAUSDT", "reference_only", tickers.time],
  ]);
  expect(funding.map(event => [event.instrumentId, event.payload.kind])).toEqual([
    ["ins_bybit_AAPLUSDT", "funding"], ["ins_bybit_BRKBUSDT", "funding"], ["ins_bybit_TSLAUSDT", "funding"],
  ]);
});
