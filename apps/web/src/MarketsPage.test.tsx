// @vitest-environment jsdom
import "./test-setup.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketsPage } from "./pages/MarketsPage.js";
import type { DashboardApi, MarketCell, MarketOverviewEnvelope, MarketRow } from "./api/client.js";

const NOW = Date.parse("2026-09-29T22:00:00Z");
const HOUR = 3_600_000;

function cell(venue: string, instrumentId: string, options: { market?: "perp" | "spot"; mid?: string; bookLive?: boolean;
  rate8hPct?: number; intervalMs?: number; fundingLive?: boolean } = {}): MarketCell {
  const mid = options.mid ?? "100";
  const perHourPct = (options.rate8hPct ?? 0) / 8;
  return {
    venue, market: options.market ?? "perp", instrument_id: instrumentId, venue_symbol: instrumentId.toUpperCase(),
    bid: String(Number(mid) - 0.05), ask: String(Number(mid) + 0.05), mid, book_age_ms: options.bookLive === false ? 90_000 : 2_000,
    book_live: options.bookLive ?? true,
    funding: options.rate8hPct === undefined ? null : {
      rate: String(perHourPct / 100 * ((options.intervalMs ?? HOUR) / HOUR)), rate_type: "predicted", interval_ms: options.intervalMs ?? HOUR,
      next_settlement_ms: NOW + 20 * 60_000, age_ms: 30_000, live: options.fundingLive ?? true,
      rate_1h_pct: perHourPct, rate_8h_pct: perHourPct * 8, apr_pct: perHourPct * 24 * 365, eligibility: "reference_only",
      flags: ["client_receipt_timestamp"],
    },
  };
}

const rows: MarketRow[] = [
  { ticker: "AAPL", cells: [
    cell("bitget", "ins_bg_aapl", { mid: "230.00", rate8hPct: 0.01, intervalMs: 8 * HOUR }),
    cell("hyperliquid_hip3", "ins_hl_aapl", { mid: "231.15", rate8hPct: 0.03 }),
    cell("extended", "ins_ext_aapl", { mid: "230.50", rate8hPct: -0.02 }),
  ], price_gap_pct: 0.5, cheapest_instrument_id: "ins_bg_aapl", richest_instrument_id: "ins_hl_aapl",
  funding_gap_8h_pct: 0.05, lowest_funding_instrument_id: "ins_ext_aapl", highest_funding_instrument_id: "ins_hl_aapl" },
  { ticker: "TSLA", cells: [
    cell("bitget", "ins_bg_tsla", { mid: "400.00", rate8hPct: 0.01, intervalMs: 8 * HOUR }),
    cell("ondo_perps", "ins_ondo_tsla", { mid: "408.00", rate8hPct: 0.2, bookLive: false }),
    cell("bitget", "ins_bg_rtsla", { market: "spot", mid: "401.00" }),
  ], price_gap_pct: 0.25, cheapest_instrument_id: "ins_bg_tsla", richest_instrument_id: "ins_bg_rtsla",
  funding_gap_8h_pct: 0.19, lowest_funding_instrument_id: "ins_bg_tsla", highest_funding_instrument_id: "ins_ondo_tsla" },
];

const overview = (items = rows, warnings: string[] = []): MarketOverviewEnvelope => ({
  status: warnings.length ? "partial" : "ok", as_of: new Date(NOW).toISOString(), freshness: { oldest_input_ms: 0 },
  result: { board_as_of_ms: NOW - 3_000, matching: "ticker_unreviewed", rows: items }, evidence: [], warnings, trace_id: "rng_trace_markets",
});

function apiWith(...responses: Array<MarketOverviewEnvelope | Error>): DashboardApi & { marketOverview: ReturnType<typeof vi.fn> } {
  const marketOverview = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) marketOverview.mockRejectedValueOnce(response);
    else marketOverview.mockResolvedValueOnce(response);
  }
  marketOverview.mockResolvedValue(responses.at(-1) instanceof Error ? overview() : responses.at(-1) ?? overview());
  return { scanOpportunities: vi.fn(), inspectOpportunity: vi.fn(), listVenues: vi.fn(), marketOverview, subscribe: vi.fn(() => () => undefined),
    intentPreviewCapability: { available: false, reason: "test" } } as never;
}

const bodyRows = () => screen.getAllByRole("row").slice(1);
const rowFor = (ticker: string) => screen.getAllByRole("row").find(row => within(row).queryByText(ticker, { selector: "th" }))!;

afterEach(() => { cleanup(); vi.useRealTimers(); });

// The first render pays jsdom and React start-up, which on a busy host has exceeded the default 5 s.
describe("markets overview", { timeout: 15_000 }, () => {
  it("shows funding per venue for 8 hours, widest gap first, marking where to go long and short", async () => {
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);

    await screen.findByText("AAPL", { selector: "th" });
    expect(bodyRows().map(row => within(row).getByRole("rowheader").textContent)).toEqual(["TSLA", "AAPL"]);
    const aapl = rowFor("AAPL");
    expect(within(aapl).getByText("0.0100%")).toBeVisible();
    expect(within(aapl).getByText("0.0300%")).toBeVisible();
    expect(within(aapl).getByText("-0.0200%")).toBeVisible();
    expect(within(aapl).getByText("0.0500%")).toBeVisible();
    expect(within(within(aapl).getByTestId("cell-extended-perp")).getByText("Long")).toBeVisible();
    expect(within(within(aapl).getByTestId("cell-hyperliquid_hip3-perp")).getByText("Short")).toBeVisible();
    expect(screen.getByText(/matched by ticker/i)).toBeVisible();
  });

  it("switches the funding period and to prices, marking the cheapest and richest market", async () => {
    const user = userEvent.setup();
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByText("AAPL", { selector: "th" });

    await user.click(screen.getByRole("button", { name: "APR" }));
    expect(within(rowFor("AAPL")).getByText(`${(0.03 / 8 * 24 * 365).toFixed(2)}%`)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Price" }));
    const aapl = rowFor("AAPL");
    expect(within(aapl).getByText("231.15")).toBeVisible();
    expect(within(aapl).getByText("0.500%")).toBeVisible();
    expect(within(within(aapl).getByTestId("cell-bitget-perp")).getByText("Buy")).toBeVisible();
    expect(within(within(aapl).getByTestId("cell-hyperliquid_hip3-perp")).getByText("Sell")).toBeVisible();
    expect(bodyRows().map(row => within(row).getByRole("rowheader").textContent)).toEqual(["AAPL", "TSLA"]);
  });

  it("filters by ticker and sorts by symbol on request", async () => {
    const user = userEvent.setup();
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByText("AAPL", { selector: "th" });

    await user.click(screen.getByRole("button", { name: /Symbol/ }));
    expect(bodyRows().map(row => within(row).getByRole("rowheader").textContent)).toEqual(["AAPL", "TSLA"]);
    await user.type(screen.getByRole("searchbox", { name: "Search symbol" }), "ts");
    expect(bodyRows().map(row => within(row).getByRole("rowheader").textContent)).toEqual(["TSLA"]);
  });

  it("marks stale values and explains each cell in its details", async () => {
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByText("TSLA", { selector: "th" });
    const ondo = within(rowFor("TSLA")).getByTestId("cell-ondo_perps-perp");
    expect(ondo).toHaveClass("stale-book");
    const details = within(rowFor("AAPL")).getByTestId("cell-bitget-perp");
    expect(within(details).getByText("Funding every 8 h")).toBeInTheDocument();
    expect(within(details).getByText("INS_BG_AAPL")).toBeInTheDocument();
    expect(within(details).getByText(/next settlement in 20 min/i)).toBeInTheDocument();
  });

  it("refreshes every 5 seconds and keeps the last data when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiWith(overview(), new Error("REQUEST_FAILED"), overview(rows.slice(0, 1)));
    render(<MarketsPage api={api} now={() => NOW} />);
    await screen.findByText("TSLA", { selector: "th" });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.marketOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(/refresh failed/i);
    expect(screen.getByText("TSLA", { selector: "th" })).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.marketOverview).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("TSLA", { selector: "th" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
