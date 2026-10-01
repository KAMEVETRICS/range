// @vitest-environment jsdom
import "./test-setup.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardApi, PairEvaluation } from "./api/client.js";
import { ReviewedPairs, bestDirections, describeReasons } from "./components/ReviewedPairs.js";

const NOW = 1_790_760_000_000;
const side = (venue: string, symbol: string, price: string | null) => ({ instrumentId: `ins_${venue}_${symbol}`, venue, venueSymbol: symbol, averagePrice: price });
const pair = (underlyingId: string, strategy: PairEvaluation["strategy"], buyVenue: string, netEdgeBps: string, status = "rejected",
  reasons = ["NET_EDGE_BELOW_THRESHOLD"]): PairEvaluation => ({
  underlyingId, strategy, status, rejectionReasons: status === "actionable" ? [] : reasons,
  buy: buyVenue === "bitget" ? side("bitget", "NVDAUSDT", "228.1") : side("hyperliquid_hip3", "xyz:NVDA", "228.0"),
  sell: buyVenue === "bitget" ? side("hyperliquid_hip3", "xyz:NVDA", "228.3") : side("bitget", "NVDAUSDT", "227.9"),
  grossSpreadBps: "8", expectedFundingBps: "-0.5", costsBps: "17", netEdgeBps, capacityUsd: "2500", requestedNotionalUsd: "2500",
  evaluatedAtMs: NOW - 3_000,
});
const pairs = [
  pair("equity:NVDA", "perp_spread", "bitget", "-9.5"),
  pair("equity:NVDA", "perp_spread", "hyperliquid_hip3", "-22"),
  pair("equity:NVDA", "funding_differential", "bitget", "-17", "rejected", ["INSUFFICIENT_DEPTH", "STALE_INPUT"]),
  pair("equity:TSLA", "perp_spread", "hyperliquid_hip3", "3.2", "actionable"),
];
const api = () => ({
  pairEvaluations: vi.fn().mockResolvedValue({ status: "ok", as_of: "2026-09-30T10:00:00.000Z", freshness: { oldest_input_ms: 0 },
    result: { as_of_ms: NOW, pairs }, evidence: [], warnings: [], trace_id: "rng_trace_pairs" }),
}) as unknown as DashboardApi;

afterEach(cleanup);

describe("reviewed pairs", { timeout: 15_000 }, () => {
  it("keeps each stock and strategy's better direction, actionable first", () => {
    expect(bestDirections(pairs).map(item => [item.underlyingId, item.strategy, item.buy.venue])).toEqual([
      ["equity:NVDA", "funding_differential", "bitget"], ["equity:NVDA", "perp_spread", "bitget"], ["equity:TSLA", "perp_spread", "hyperliquid_hip3"]]);
  });

  it("says in plain words why a pair is not actionable", () => {
    expect(describeReasons(["STALE_INPUT", "NET_EDGE_BELOW_THRESHOLD", "SOMETHING_NEW"])).toBe("below costs, stale quote, something new");
  });

  it("shows every reviewed pair's latest result and points the scanner at a clicked stock", async () => {
    const onSelect = vi.fn();
    render(<ReviewedPairs api={api()} onSelectUnderlying={onSelect} now={() => NOW} />);
    const spread = (await screen.findAllByRole("row")).find(row => row.textContent?.includes("NVDA") && row.textContent.includes("Price spread"))!;
    expect(within(spread).getByText("-9.50 bps")).toHaveClass("negative");
    expect(spread).toHaveTextContent("Buy Bitget @ 228.10 · sell trade.xyz @ 228.30");
    expect(spread).toHaveTextContent("below costs");
    expect(spread).toHaveTextContent("3s ago");
    const actionable = screen.getAllByRole("row").find(row => row.textContent?.includes("TSLA"))!;
    expect(actionable).toHaveClass("actionable");
    expect(within(actionable).getByText("Actionable")).toBeVisible();
    expect(screen.getByText("1 actionable of 3")).toBeVisible();
    fireEvent.click(spread);
    expect(onSelect).toHaveBeenCalledWith("equity:NVDA");
  });
});
