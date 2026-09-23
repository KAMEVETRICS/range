import { describe, expect, it } from "vitest";
import { ExecutableQuoteSchema } from "@range/domain";
import { OrderBook } from "./order-book.js";
import { quoteAtNotional } from "./executable-quote.js";
import { observation, T } from "./test-fixtures.js";

function book(bids: [string, string][], asks: [string, string][], overrides: Record<string, unknown> = {}) {
  const result = new OrderBook();
  result.applySnapshot(observation("1", bids, asks, overrides));
  return result;
}

describe("quoteAtNotional", () => {
  it("fills a buy across asks using exact notional, VWAP, and worst price", () => {
    const source = book([["99", "5"]], [["100", "1"], ["110", "2"]]);
    const quote = quoteAtNotional(source, "buy", "155", T + 100);
    expect(quote).toMatchObject({
      status: "executable", requestedNotional: "155", filledQuantity: "1.5",
      averagePrice: "103.3333333333333333333333333333333333333333",
      worstPrice: "110", capacityUsd: "320", depthUtilization: "0.484375", ageMs: 100,
    });
    if (quote.status === "executable") {
      const { status: _status, ...value } = quote;
      expect(ExecutableQuoteSchema.parse(value)).toMatchObject({ side: "buy" });
    }
  });

  it("fills a sell against descending bids", () => {
    const quote = quoteAtNotional(book([["100", "1"], ["90", "2"]], [["110", "1"]]), "sell", "145", T + 10);
    expect(quote).toMatchObject({
      status: "executable", filledQuantity: "1.5", averagePrice: "96.6666666666666666666666666666666666666667",
      worstPrice: "90", capacityUsd: "280", depthUtilization: "0.5178571428571428571428571428571428571429",
    });
  });

  it("keeps a fractional one-level fill VWAP at its actual price", () => {
    const source = book([["3", "1"]], [["4", "1"]]);
    const buy = quoteAtNotional(source, "buy", "1", T + 10);
    const sell = quoteAtNotional(source, "sell", "1", T + 10);
    expect(buy).toMatchObject({ status: "executable", averagePrice: "4", worstPrice: "4" });
    expect(sell).toMatchObject({ status: "executable", averagePrice: "3", worstPrice: "3" });
  });

  it("reports insufficient depth without an executable fill", () => {
    const quote = quoteAtNotional(book([], [["100", "1"]]), "buy", "250", T + 10);
    expect(quote).toEqual(expect.objectContaining({ status: "insufficient_depth", capacityUsd: "100" }));
    expect("filledQuantity" in quote).toBe(false);
  });

  it("quotes a fresh live snapshot-only feed without inventing a sequence", () => {
    const source = new OrderBook();
    const snapshot = observation(undefined, [["99", "1"]], [["101", "1"]]);
    source.applySnapshot(snapshot);
    expect(source.status()).toBe("snapshot_only");
    expect(quoteAtNotional(source, "buy", "50", T + 10)).toMatchObject({
      status: "executable", sourceBookEventId: snapshot.eventId, ageMs: 10,
    });
  });

  it("attributes a quote to the latest applied book event", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]]));
    const delta = observation("2", [], [["101", "2"]]);
    source.applyDelta(delta);
    expect(quoteAtNotional(source, "buy", "50", T + 10)).toMatchObject({
      status: "executable", sourceBookEventId: delta.eventId,
    });
  });

  it("lists the events that supplied the consumed levels", () => {
    const source = new OrderBook();
    const snapshot = observation("1", [["99", "1"]], [["101", "1"], ["102", "1"]]);
    source.applySnapshot(snapshot);
    const delta = observation("2", [], [["102", "2"]]);
    source.applyDelta(delta);
    expect(quoteAtNotional(source, "buy", "150", T + 10)).toMatchObject({
      status: "executable", sourceBookEventId: delta.eventId,
      sourceEventIds: [snapshot.eventId, delta.eventId],
    });
  });

  it("does not freshen untouched ask liquidity when a bid delta arrives", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]]));
    source.applyDelta(observation("2", [["99", "2"]], [], {
      sourceTimestamp: T + 1_200, receivedTimestamp: T + 1_210,
    }));
    expect(quoteAtNotional(source, "buy", "50", T + 1_500).status).toBe("stale_input");
  });

  it("does not make untouched reference liquidity executable with a live delta", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]], { eligibility: "reference_only" }));
    source.applyDelta(observation("2", [["99", "2"]], []));
    expect(quoteAtNotional(source, "buy", "50", T + 10).status).toBe("reference_only");
  });

  it("rejects stale, reference-only, and invalid books", () => {
    expect(quoteAtNotional(book([["99", "1"]], [["101", "1"]]), "buy", "50", T + 1_001).status).toBe("stale_input");
    expect(quoteAtNotional(book([["99", "1"]], [["101", "1"]], { eligibility: "reference_only" }), "buy", "50", T + 10).status).toBe("reference_only");
    expect(quoteAtNotional(book([["102", "1"]], [["101", "1"]]), "buy", "50", T + 10).status).toBe("invalid_book");
  });

  it.each(["0", "-1", "NaN", "Infinity"])("rejects invalid requested notional %s", value => {
    const source = book([["99", "1"]], [["101", "1"]]);
    expect(quoteAtNotional(source, "buy", value, T + 10).status).toBe("invalid_request");
  });

  it("keeps generated VWAP within best/worst and worsens monotonically with size", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const source = book([["99", String(seed)], ["98", String(seed)]], [["101", String(seed)], ["102", String(seed)]]);
      const firstBuy = quoteAtNotional(source, "buy", "101", T + 10);
      const nextBuy = quoteAtNotional(source, "buy", "202", T + 10);
      const firstSell = quoteAtNotional(source, "sell", "98", T + 10);
      const nextSell = quoteAtNotional(source, "sell", "196", T + 10);
      for (const quote of [firstBuy, nextBuy, firstSell, nextSell]) {
        expect(quote.status).toBe("executable");
        if (quote.status === "executable") {
          const average = Number(quote.averagePrice);
          const worst = Number(quote.worstPrice);
          expect(quote.side === "buy" ? average <= worst : average >= worst).toBe(true);
        }
      }
      if (firstBuy.status === "executable" && nextBuy.status === "executable") expect(Number(nextBuy.averagePrice)).toBeGreaterThanOrEqual(Number(firstBuy.averagePrice));
      if (firstSell.status === "executable" && nextSell.status === "executable") expect(Number(nextSell.averagePrice)).toBeLessThanOrEqual(Number(firstSell.averagePrice));
    }
  });
});
