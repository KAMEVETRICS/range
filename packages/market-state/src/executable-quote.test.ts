import { describe, expect, it } from "vitest";
import { ExecutableQuoteSchema, FILL_DUST_USD, PartialQuoteSchema } from "@range/domain";
import { Decimal } from "decimal.js";
import { OrderBook } from "./order-book.js";
import { quoteAtNotional } from "./executable-quote.js";
import { observation, T } from "./test-fixtures.js";

const ExactDecimal = Decimal.clone({ precision: 100 });

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

  it("completes a fill short only by quantity-rounding dust, reporting the exact quantity times price", () => {
    const source = book([["3", "1"]], [["4", "1"]]);
    const buy = quoteAtNotional(source, "buy", "1", T + 10);
    const sell = quoteAtNotional(source, "sell", "1", T + 10);
    expect(buy).toMatchObject({ status: "executable", averagePrice: "4", worstPrice: "4" });
    expect(sell).toMatchObject({ status: "executable", averagePrice: "3", worstPrice: "3" });
    if (sell.status === "executable") {
      expect(new ExactDecimal(sell.filledNotionalUsd).equals(new ExactDecimal(sell.filledQuantity).times("3"))).toBe(true);
      expect(new ExactDecimal(sell.filledNotionalUsd).lessThan(sell.requestedNotional)).toBe(true);
      expect(new ExactDecimal(sell.requestedNotional).minus(sell.filledNotionalUsd).lessThanOrEqualTo(FILL_DUST_USD)).toBe(true);
    }
  });

  it("still reports an underfill larger than dust as partial with exact evidence", () => {
    const price = `3${"0".repeat(41)}`;
    const quote = quoteAtNotional(book([], [[price, "1"]]), "buy", "1", T + 10);
    expect(quote).toMatchObject({ status: "partial_fill", remainingNotionalUsd: `0.${"0".repeat(38)}1` });
    expect(PartialQuoteSchema.parse(quote)).toMatchObject({ status: "partial_fill" });
    if (quote.status === "partial_fill") {
      expect(new ExactDecimal(quote.filledNotionalUsd).equals(new ExactDecimal(quote.filledQuantity).times(price))).toBe(true);
      expect(new ExactDecimal(quote.filledNotionalUsd).plus(quote.remainingNotionalUsd).equals("1")).toBe(true);
    }
  });

  it("quotes a real notional that does not divide its prices", () => {
    const source = book([["228.2", "3"]], [["228.37", "8.5"], ["228.41", "20"]]);
    const quote = quoteAtNotional(source, "buy", "2500", T + 10);
    expect(quote).toMatchObject({ status: "executable", requestedNotional: "2500", worstPrice: "228.41" });
    if (quote.status === "executable") {
      expect(new ExactDecimal("2500").minus(quote.filledNotionalUsd).lessThanOrEqualTo(FILL_DUST_USD)).toBe(true);
    }
  });

  it("keeps exactly divisible decimal fills executable", () => {
    const source = book([["3", "1"], ["0.3", "1"]], [["4", "1"], ["5", "1"]]);
    expect(quoteAtNotional(source, "sell", "3", T + 10)).toMatchObject({
      status: "executable", requestedNotional: "3", filledQuantity: "1", filledNotionalUsd: "3",
    });
    expect(quoteAtNotional(source, "buy", "1", T + 10)).toMatchObject({
      status: "executable", requestedNotional: "1", filledQuantity: "0.25", filledNotionalUsd: "1",
    });
    expect(quoteAtNotional(book([["0.1", "10"]], [["0.2", "10"]]), "sell", "0.3", T + 10)).toMatchObject({
      status: "executable", requestedNotional: "0.3", filledQuantity: "3", filledNotionalUsd: "0.3",
    });
  });

  it("does not conceal a low-price fractional overshoot behind decimal context rounding", () => {
    const price = `0.${"0".repeat(39)}7`;
    const source = book([], [[price, `1${"0".repeat(40)}`]]);
    const quote = quoteAtNotional(source, "buy", "1", T + 10);
    expect(quote.status).toBe("executable");
    if (quote.status === "executable") {
      const auditDecimal = Decimal.clone({ precision: 250 });
      const emittedCost = new auditDecimal(quote.filledQuantity).times(price);
      expect(emittedCost.equals(quote.filledNotionalUsd)).toBe(true);
      expect(emittedCost.lessThan(quote.requestedNotional)).toBe(true);
      expect(new auditDecimal(quote.requestedNotional).minus(quote.filledNotionalUsd).lessThanOrEqualTo(FILL_DUST_USD)).toBe(true);
    }
  });

  it("keeps an exactly divisible low-price high-quantity fill executable", () => {
    const price = `0.${"0".repeat(39)}1`;
    expect(quoteAtNotional(book([], [[price, `1${"0".repeat(40)}`]]), "buy", "1", T + 10)).toMatchObject({
      status: "executable", filledQuantity: `1${"0".repeat(40)}`, filledNotionalUsd: "1",
    });
  });

  it("accepts exact arithmetic at the supported 128-digit operand boundary", () => {
    const price = `0.${"0".repeat(126)}1`;
    const quantity = `1${"0".repeat(127)}`;
    expect(quoteAtNotional(book([], [[price, quantity]]), "buy", "1", T + 10)).toMatchObject({
      status: "executable", filledQuantity: quantity, filledNotionalUsd: "1", capacityUsd: "1",
    });
  });

  it("rejects unsupported numeric syntax and book precision", () => {
    const source = book([], [["1", "1"]]);
    expect(quoteAtNotional(source, "buy", "1e1000", T + 10).status).toBe("invalid_request");
    const extreme = book([], [[`0.${"0".repeat(128)}1`, "1"]]);
    expect(quoteAtNotional(extreme, "buy", "1", T + 10).status).toBe("invalid_book");
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
    expect(quoteAtNotional(source, "buy", "101", T + 10)).toMatchObject({
      status: "executable", sourceBookEventId: snapshot.eventId, ageMs: 10,
    });
  });

  it("attributes a quote to the latest applied book event", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]]));
    const delta = observation("2", [], [["101", "2"]]);
    source.applyDelta(delta);
    expect(quoteAtNotional(source, "buy", "101", T + 10)).toMatchObject({
      status: "executable", sourceBookEventId: delta.eventId,
    });
  });

  it("lists the events that supplied the consumed levels", () => {
    const source = new OrderBook();
    const snapshot = observation("1", [["99", "1"]], [["101", "1"], ["102", "1"]]);
    source.applySnapshot(snapshot);
    const delta = observation("2", [], [["102", "2"]]);
    source.applyDelta(delta);
    expect(quoteAtNotional(source, "buy", "203", T + 10)).toMatchObject({
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

  it("measures capacity from fresh contiguous ask depth only", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["100", "1"], ["101", "100"]]));
    source.applyDelta(observation("2", [], [["100", "1"]], {
      sourceTimestamp: T + 1_200, receivedTimestamp: T + 1_210,
    }));
    expect(quoteAtNotional(source, "buy", "50", T + 1_500)).toMatchObject({
      status: "executable", capacityUsd: "100", depthUtilization: "0.5",
    });
    expect(quoteAtNotional(source, "buy", "150", T + 1_500)).toMatchObject({
      status: "insufficient_depth", capacityUsd: "100",
    });
  });

  it("excludes reference-only tail levels from executable capacity", () => {
    const source = new OrderBook();
    source.applySnapshot(observation("1", [["99", "1"]], [["100", "1"], ["101", "100"]], { eligibility: "reference_only" }));
    source.applyDelta(observation("2", [], [["100", "1"]]));
    expect(quoteAtNotional(source, "buy", "50", T + 10)).toMatchObject({
      status: "executable", capacityUsd: "100", depthUtilization: "0.5",
    });
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
      const firstBuy = quoteAtNotional(source, "buy", String(50 * seed), T + 10);
      const nextBuy = quoteAtNotional(source, "buy", String(150 * seed), T + 10);
      const firstSell = quoteAtNotional(source, "sell", String(49 * seed), T + 10);
      const nextSell = quoteAtNotional(source, "sell", String(147 * seed), T + 10);
      for (const quote of [firstBuy, nextBuy, firstSell, nextSell]) {
        expect(["executable", "partial_fill"]).toContain(quote.status);
        if (quote.status === "executable" || quote.status === "partial_fill") {
          const average = new Decimal(quote.averagePrice);
          const worst = new Decimal(quote.worstPrice);
          expect(quote.side === "buy" ? average.lessThanOrEqualTo(worst) : average.greaterThanOrEqualTo(worst)).toBe(true);
          expect(new Decimal(quote.filledNotionalUsd).lessThanOrEqualTo(quote.requestedNotional)).toBe(true);
          expect(new Decimal(quote.filledNotionalUsd).lessThanOrEqualTo(quote.capacityUsd)).toBe(true);
          if (quote.status === "partial_fill") {
            expect(new ExactDecimal(quote.filledNotionalUsd).plus(quote.remainingNotionalUsd).equals(quote.requestedNotional)).toBe(true);
          }
        }
      }
      if ((firstBuy.status === "executable" || firstBuy.status === "partial_fill") &&
          (nextBuy.status === "executable" || nextBuy.status === "partial_fill")) {
        expect(nextBuy.worstPrice).toBe("102");
        expect(new Decimal(nextBuy.averagePrice).greaterThanOrEqualTo(firstBuy.averagePrice)).toBe(true);
        const actualCost = new ExactDecimal(101).times(seed)
          .plus(new ExactDecimal(102).times(new ExactDecimal(nextBuy.filledQuantity).minus(seed)));
        expect(new ExactDecimal(nextBuy.filledNotionalUsd).equals(actualCost)).toBe(true);
      }
      if ((firstSell.status === "executable" || firstSell.status === "partial_fill") &&
          (nextSell.status === "executable" || nextSell.status === "partial_fill")) {
        expect(nextSell.worstPrice).toBe("98");
        expect(new Decimal(nextSell.averagePrice).lessThanOrEqualTo(firstSell.averagePrice)).toBe(true);
        const actualCost = new ExactDecimal(99).times(seed)
          .plus(new ExactDecimal(98).times(new ExactDecimal(nextSell.filledQuantity).minus(seed)));
        expect(new ExactDecimal(nextSell.filledNotionalUsd).equals(actualCost)).toBe(true);
      }
    }
  });
});
