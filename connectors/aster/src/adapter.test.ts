import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createAsterAdapter } from "./adapter.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/aster/${name}.json`, import.meta.url),
  "utf8",
));
const responses: Record<string, string> = {
  "/fapi/v1/exchangeInfo": "exchange-info", "/fapi/v1/fundingInfo": "funding-info",
  "/fapi/v1/ticker/bookTicker": "book-ticker", "/fapi/v1/premiumIndex": "premium-index",
};

it("discovers stock perpetuals, snapshots them from one book ticker read, and supplements funding", async () => {
  const now = 1_790_735_900_000;
  const http = { get: vi.fn(async (path: string) => fixture(responses[path]!)) };
  const adapter = createAsterAdapter(http, { nowMs: () => now });
  const signal = new AbortController().signal;

  const instruments = await adapter.discover(signal);
  const books = [];
  for (const instrument of instruments) books.push(await adapter.snapshot(instrument, signal));
  const funding = await adapter.supplement!(instruments, signal);

  expect(http.get.mock.calls.map(call => call[0]))
    .toEqual(["/fapi/v1/exchangeInfo", "/fapi/v1/fundingInfo", "/fapi/v1/ticker/bookTicker", "/fapi/v1/premiumIndex"]);
  expect(books.map(book => [book.instrumentId, book.sourceTimestampMs, book.qualityFlags])).toEqual([
    ["ins_aster_AAPLUSDT", now, ["top_of_book_only", "client_receipt_timestamp"]],
    ["ins_aster_TSLAUSDT", now, ["top_of_book_only", "client_receipt_timestamp"]],
    ["ins_aster_BBXUSDT", now, ["top_of_book_only", "client_receipt_timestamp"]],
  ]);
  expect(funding.map(event => event.instrumentId)).toEqual(["ins_aster_AAPLUSDT", "ins_aster_TSLAUSDT", "ins_aster_BBXUSDT"]);
});
