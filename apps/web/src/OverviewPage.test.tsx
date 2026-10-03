// @vitest-environment jsdom
import "./test-setup.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardApi, PairEvaluation, VenueView } from "./api/client.js";
import { OverviewPage } from "./pages/OverviewPage.js";

const NOW = 1_790_760_000_000;
const side = (venue: string, symbol: string, price: string) => ({ instrumentId: `ins_${venue}_${symbol}`, venue, venueSymbol: symbol, averagePrice: price });
const pair = (underlyingId: string, strategy: PairEvaluation["strategy"], netEdgeBps: string, status = "rejected", costsBps = "17"): PairEvaluation => ({
  underlyingId, strategy, status, rejectionReasons: status === "actionable" ? [] : ["NET_EDGE_BELOW_THRESHOLD"],
  buy: side("bitget", "NVDAUSDT", "228.1"), sell: side("hyperliquid_hip3", "xyz:NVDA", "228.3"),
  grossSpreadBps: "8", expectedFundingBps: "-0.5", costsBps, netEdgeBps, capacityUsd: "2500", requestedNotionalUsd: "2500",
  evaluatedAtMs: NOW - 2_000,
});
const venue = (name: string, connectionState: "connected" | "degraded"): VenueView => ({
  venue: name, capabilities: ["book"], freshnessBudgetMs: 2000, asOfMs: NOW,
  health: { venue: name, connectionState, lastEventAgeMs: 300, clockSkewMs: 5, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" },
    capabilityChanges: [], errorCounters: {} },
});
const envelope = (result: unknown) => ({ status: "ok", as_of: new Date(NOW).toISOString(), freshness: { oldest_input_ms: 0 }, result,
  evidence: [], warnings: [], trace_id: "rng_trace_overview" });
const api = () => ({
  pairEvaluations: vi.fn().mockResolvedValue(envelope({ as_of_ms: NOW - 1_000, pairs: [
    pair("equity:NVDA", "perp_spread", "-4.8"), pair("equity:NVDA", "funding_differential", "-21", "rejected", "18"),
    pair("equity:TSLA", "perp_spread", "2.5", "actionable", "16"),
  ] })),
  listVenues: vi.fn().mockResolvedValue(envelope({ items: [venue("bitget", "connected"), venue("bybit", "degraded")], next_offset: null })),
}) as unknown as DashboardApi;

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("overview", { timeout: 15_000 }, () => {
  it("summarizes the live state and opens the scanner on a clicked pair", async () => {
    render(<OverviewPage api={api()} now={() => NOW} />);
    const summary = await screen.findByLabelText("Live summary");
    // One row per stock, its best trade, closest to actionable first.
    const value = (index: number) => summary.querySelectorAll(".kpi-value")[index]!;
    await waitFor(() => expect(value(0)).toHaveTextContent("1/2"));
    expect(value(0)).toHaveClass("positive");
    expect(summary.querySelectorAll(".kpi:first-child .capsules span")).toHaveLength(2);
    expect(summary.querySelectorAll(".kpi:first-child .capsules .on")).toHaveLength(1);
    expect(value(1)).toHaveTextContent("+2.50 bps");
    expect(value(1)).toHaveClass("positive");
    expect(within(summary).getByText("TSLA · Price spread · buy Bitget")).toBeVisible();
    expect(value(2)).toHaveTextContent("16.5 bps");
    await waitFor(() => expect(value(3)).toHaveTextContent("1/2"));
    expect(screen.getByText("Updated 1 s ago")).toBeVisible();
    const tickers = screen.getAllByRole("rowheader").map(header => header.textContent);
    expect(tickers).toEqual(["TSLA", "NVDA"]);

    const nvda = screen.getAllByRole("row").find(row => row.textContent?.includes("NVDA") && row.textContent.includes("Price spread"))!;
    fireEvent.click(nvda);
    expect(window.location.hash).toBe("#opportunities/equity:NVDA");
  });

  it("links the documentation site in a new tab", async () => {
    render(<OverviewPage api={api()} now={() => NOW} />);
    const docs = await screen.findByRole("link", { name: "Read the docs" });
    expect(docs).toHaveAttribute("href", "https://range-2.gitbook.io/range-docs/");
    expect(docs).toHaveAttribute("target", "_blank");
    await waitFor(() => expect(screen.getAllByRole("rowheader")).toHaveLength(2));
  });
});
