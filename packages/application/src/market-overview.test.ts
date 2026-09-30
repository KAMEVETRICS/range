import { describe, expect, it } from "vitest";
import { MarketBoardSnapshotSchema, type MarketBoardEntry } from "@range/domain";
import { buildMarketOverview, displayTicker } from "./market-overview.js";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;

function entry(instrumentId: string, venue: string, underlyingId: string, productType: string, options: {
  bid?: string; ask?: string; bookAgeMs?: number; rate?: string; intervalMs?: number; fundingAgeMs?: number;
} = {}): MarketBoardEntry {
  const timing = (ageMs: number, freshnessBudgetMs: number) => ({ sourceTimestamp: NOW - ageMs, receivedTimestamp: NOW - ageMs,
    freshnessBudgetMs, eligibility: "reference_only" as const, qualityFlags: [] });
  return MarketBoardSnapshotSchema.shape.entries.element.parse({
    instrumentId, venue, venueSymbol: instrumentId.toUpperCase(), underlyingId, productType,
    ...(options.bid && options.ask ? { book: { bid: { price: options.bid, quantity: "1" }, ask: { price: options.ask, quantity: "1" },
      ...timing(options.bookAgeMs ?? 1_000, 5_000) } } : {}),
    ...(options.rate ? { funding: { rate: options.rate, rateType: "predicted", intervalMs: options.intervalMs ?? HOUR,
      nextSettlementMs: NOW + HOUR, positiveRatePayer: "long", ...timing(options.fundingAgeMs ?? 30_000, 120_000) } } : {}),
  });
}

describe("displayTicker", () => {
  it("reads equity underlyings and Bitget's venue-local stock names", () => {
    expect(displayTicker({ venue: "extended", underlyingId: "equity:AAPL", productType: "perpetual" })).toBe("AAPL");
    expect(displayTicker({ venue: "bitget", underlyingId: "bitget:rAAPL", productType: "tokenized_spot" })).toBe("AAPL");
    expect(displayTicker({ venue: "bitget", underlyingId: "bitget:AAPL", productType: "perpetual" })).toBe("AAPL");
    expect(displayTicker({ venue: "hyperliquid_hip3", underlyingId: "crypto:BTC", productType: "perpetual" })).toBeUndefined();
  });

  it("files a venue's suffixed or punctuated name for a share under its listed ticker", () => {
    expect(displayTicker({ venue: "aster", underlyingId: "equity:BBX", productType: "perpetual" })).toBe("BB");
    expect(displayTicker({ venue: "extended", underlyingId: "equity:STXX", productType: "perpetual" })).toBe("STX");
    expect(displayTicker({ venue: "bybit", underlyingId: "equity:BRK.B", productType: "perpetual" })).toBe("BRKB");
    expect(displayTicker({ venue: "variational", underlyingId: "equity:VISA", productType: "perpetual" })).toBe("V");
  });
});

describe("buildMarketOverview", () => {
  it("groups listings by ticker and keeps only tickers that trade on two or more venues", () => {
    const overview = buildMarketOverview({ asOfMs: NOW, entries: [
      entry("ins_bg_raapl", "bitget", "bitget:rAAPL", "tokenized_spot", { bid: "229.0", ask: "229.4" }),
      entry("ins_bg_aapl", "bitget", "bitget:AAPL", "perpetual", { bid: "229.1", ask: "229.3" }),
      entry("ins_ext_aapl", "extended", "equity:AAPL", "perpetual", { bid: "230.0", ask: "230.2" }),
      entry("ins_ext_tsla", "extended", "equity:TSLA", "perpetual", { bid: "400.0", ask: "400.4" }),
    ] }, NOW);

    expect(overview.map(row => row.ticker)).toEqual(["AAPL"]);
    expect(overview[0]!.cells.map(cell => [cell.venue, cell.market, cell.mid])).toEqual([
      ["bitget", "spot", "229.2"], ["bitget", "perp", "229.2"], ["extended", "perp", "230.1"],
    ]);
  });

  it("normalizes each venue's funding by its own interval and finds the widest 8-hour gap", () => {
    const [row] = buildMarketOverview({ asOfMs: NOW, entries: [
      entry("ins_bg_aapl", "bitget", "bitget:AAPL", "perpetual", { rate: "0.0001", intervalMs: 8 * HOUR }),
      entry("ins_hl_aapl", "hyperliquid_hip3", "equity:AAPL", "perpetual", { rate: "0.0000125" }),
      entry("ins_ondo_aapl", "ondo_perps", "equity:AAPL", "perpetual", { rate: "-0.00005" }),
    ] }, NOW);

    const funding = Object.fromEntries(row!.cells.map(cell => [cell.venue, cell.funding]));
    expect(funding.bitget).toMatchObject({ rate: "0.0001", interval_ms: 8 * HOUR, live: true });
    expect(funding.bitget!.rate_1h_pct).toBeCloseTo(0.00125, 10);
    expect(funding.bitget!.rate_8h_pct).toBeCloseTo(0.01, 10);
    expect(funding.hyperliquid_hip3!.rate_8h_pct).toBeCloseTo(0.01, 10);
    expect(funding.hyperliquid_hip3!.apr_pct).toBeCloseTo(0.0000125 * 24 * 365 * 100, 8);
    expect(funding.ondo_perps!.rate_8h_pct).toBeCloseTo(-0.04, 10);
    expect(row!.funding_gap_8h_pct).toBeCloseTo(0.05, 10);
    expect([row!.lowest_funding_instrument_id, row!.highest_funding_instrument_id]).toEqual(["ins_ondo_aapl", "ins_bg_aapl"]);
  });

  it("measures the price gap between mid prices of live books", () => {
    const [row] = buildMarketOverview({ asOfMs: NOW, entries: [
      entry("ins_bg_aapl", "bitget", "bitget:AAPL", "perpetual", { bid: "229.9", ask: "230.1" }),
      entry("ins_ext_aapl", "extended", "equity:AAPL", "perpetual", { bid: "231.9", ask: "232.1" }),
    ] }, NOW);
    expect(row!.price_gap_pct).toBeCloseTo((232 - 230) / 230 * 100, 10);
    expect([row!.cheapest_instrument_id, row!.richest_instrument_id]).toEqual(["ins_bg_aapl", "ins_ext_aapl"]);
  });

  it("shows stale values but leaves them out of the gaps", () => {
    const [row] = buildMarketOverview({ asOfMs: NOW, entries: [
      entry("ins_bg_aapl", "bitget", "bitget:AAPL", "perpetual", { bid: "229.9", ask: "230.1", rate: "0.0001", intervalMs: 8 * HOUR }),
      entry("ins_ext_aapl", "extended", "equity:AAPL", "perpetual", { bid: "300.0", ask: "300.2", bookAgeMs: 61_000,
        rate: "0.01", fundingAgeMs: 16 * 60_000 }),
    ] }, NOW);
    const stale = row!.cells.find(cell => cell.venue === "extended")!;
    expect([stale.book_live, stale.book_age_ms, stale.funding!.live]).toEqual([false, 61_000, false]);
    expect([row!.price_gap_pct, row!.funding_gap_8h_pct]).toEqual([null, null]);
  });
});
