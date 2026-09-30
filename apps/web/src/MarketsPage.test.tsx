// @vitest-environment jsdom
import "./test-setup.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPercent, MarketsPage } from "./pages/MarketsPage.js";
import type { DashboardApi, MarketCell, MarketOverviewEnvelope, MarketRow } from "./api/client.js";

const NOW = Date.parse("2026-09-29T22:00:00Z");
const HOUR = 3_600_000;

/** A cell whose funding is given per hour, in percent. */
function cell(venue: string, instrumentId: string, options: { market?: "perp" | "spot"; mid?: string; bookLive?: boolean;
  perHourPct?: number; intervalMs?: number; fundingLive?: boolean } = {}): MarketCell {
  const mid = options.mid ?? "100";
  const perHour = options.perHourPct;
  return {
    venue, market: options.market ?? "perp", instrument_id: instrumentId, venue_symbol: instrumentId.toUpperCase(),
    bid: String(Number(mid) - 0.05), ask: String(Number(mid) + 0.05), mid, book_age_ms: options.bookLive === false ? 90_000 : 2_000,
    book_live: options.bookLive ?? true,
    funding: perHour === undefined ? null : {
      rate: String(perHour / 100 * ((options.intervalMs ?? HOUR) / HOUR)), rate_type: "predicted", interval_ms: options.intervalMs ?? HOUR,
      next_settlement_ms: NOW + 20 * 60_000, age_ms: 30_000, live: options.fundingLive ?? true,
      rate_1h_pct: perHour, rate_8h_pct: perHour * 8, apr_pct: perHour * 24 * 365, eligibility: "reference_only",
      flags: ["client_receipt_timestamp"],
    },
  };
}

const row = (ticker: string, cells: MarketCell[]): MarketRow => ({ ticker, cells, price_gap_pct: null, cheapest_instrument_id: null,
  richest_instrument_id: null, funding_gap_8h_pct: null, lowest_funding_instrument_id: null, highest_funding_instrument_id: null });

const rows: MarketRow[] = [
  row("AAPL", [
    cell("bitget", "ins_bg_aapl", { mid: "230.00", perHourPct: 0.00125, intervalMs: 8 * HOUR }),
    cell("hyperliquid_hip3", "ins_hl_aapl", { mid: "231.15", perHourPct: 0.00375 }),
    cell("bybit", "ins_by_aapl", { mid: "230.50", perHourPct: 0.001 }),
  ]),
  row("TSLA", [
    cell("bitget", "ins_bg_tsla", { mid: "400.00", perHourPct: 0.02, intervalMs: 8 * HOUR }),
    cell("bybit", "ins_by_tsla", { mid: "408.00", perHourPct: -0.005, bookLive: false }),
    cell("bitget", "ins_bg_rtsla", { market: "spot", mid: "401.00" }),
  ]),
  row("NFLX", [
    cell("hyperliquid_hip3", "ins_hl_nflx", { mid: "90.00", perHourPct: 0.001 }),
    cell("bybit", "ins_by_nflx", { mid: "90.10", perHourPct: 0.002 }),
  ]),
];

const overview = (items = rows): MarketOverviewEnvelope => ({
  status: "ok", as_of: new Date(NOW).toISOString(), freshness: { oldest_input_ms: 0 },
  result: { board_as_of_ms: NOW - 3_000, matching: "ticker_unreviewed", rows: items }, evidence: [], warnings: [], trace_id: "rng_trace_markets",
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

const tickers = () => screen.getAllByRole("rowheader").map(header => header.getAttribute("aria-label"));
const rowFor = (ticker: string) => screen.getAllByRole("row").find(item => within(item).queryByRole("rowheader")?.getAttribute("aria-label") === ticker)!;
const cellIn = (ticker: string, column: string) => within(rowFor(ticker)).getByTestId(`cell-${column}`);

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("formatPercent", () => {
  it("keeps about four significant digits without trailing zeros", () => {
    expect([0.00125, 0.000262, -0.0199164, 0.0025, 32.85, 100, 0].map(formatPercent))
      .toEqual(["0.00125%", "0.000262%", "-0.01992%", "0.0025%", "32.85%", "100%", "0%"]);
  });
});

// The first render pays jsdom and React start-up, which on a busy host has exceeded the default 5 s.
describe("markets overview", { timeout: 15_000 }, () => {
  it("puts Bitget first and follows each venue with its spread against Bitget, per hour by default", async () => {
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /AAPL/ });

    expect(screen.getAllByRole("columnheader").map(header => header.textContent?.trim()))
      .toEqual(["Market", "Bitget", "Hyperliquid", "Bitget / Hyperliquid", "Bybit", "Bitget / Bybit"]);
    expect(cellIn("AAPL", "bitget")).toHaveTextContent("0.00125%");
    expect(cellIn("AAPL", "hyperliquid_hip3")).toHaveTextContent("0.00375%");
    expect(cellIn("AAPL", "spread-hyperliquid_hip3")).toHaveTextContent("-0.0025%");
    expect(cellIn("AAPL", "spread-hyperliquid_hip3")).toHaveClass("negative");
    expect(cellIn("AAPL", "spread-bybit")).toHaveTextContent("0.00025%");
    expect(cellIn("AAPL", "spread-bybit")).toHaveClass("positive");
    expect(cellIn("NFLX", "bitget")).toHaveTextContent("-");
    expect(cellIn("NFLX", "spread-bybit")).toHaveTextContent("-");
    expect(screen.getByText(/matched by ticker/i)).toBeVisible();
  });

  it("orders by the widest Bitget spread and sorts by any column on request", async () => {
    const user = userEvent.setup();
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /AAPL/ });
    expect(tickers()).toEqual(["TSLA", "AAPL", "NFLX"]);

    await user.click(screen.getByRole("button", { name: "Market" }));
    expect(tickers()).toEqual(["AAPL", "NFLX", "TSLA"]);
    await user.click(screen.getByRole("button", { name: "Bybit" }));
    expect(tickers()).toEqual(["NFLX", "AAPL", "TSLA"]);
  });

  it("shows only markets with a Bitget spread when arbitrage-only is on, and filters by symbol", async () => {
    const user = userEvent.setup();
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /AAPL/ });

    await user.click(screen.getByRole("switch", { name: "Arb only" }));
    expect(tickers()).toEqual(["TSLA", "AAPL"]);
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "aa");
    expect(tickers()).toEqual(["AAPL"]);
  });

  it("converts to the chosen period and shows price spreads in the price view", async () => {
    const user = userEvent.setup();
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /AAPL/ });

    await user.click(screen.getByRole("button", { name: "8H" }));
    expect(cellIn("AAPL", "bitget")).toHaveTextContent("0.01%");
    expect(cellIn("AAPL", "spread-hyperliquid_hip3")).toHaveTextContent("-0.02%");

    await user.click(screen.getByRole("button", { name: "Price" }));
    expect(cellIn("AAPL", "bitget")).toHaveTextContent("230.00");
    expect(cellIn("AAPL", "hyperliquid_hip3")).toHaveTextContent("231.15");
    expect(cellIn("AAPL", "spread-hyperliquid_hip3")).toHaveTextContent(formatPercent((230 / 231.15 - 1) * 100));
  });

  it("dims stale values and explains each cell in its details", async () => {
    render(<MarketsPage api={apiWith(overview())} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /TSLA/ });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Price" }));
    expect(cellIn("TSLA", "bybit")).toHaveClass("stale");
    await user.click(screen.getByRole("button", { name: "Funding" }));
    const details = cellIn("AAPL", "bitget");
    expect(within(details).getByText("Funding every 8 h")).toBeInTheDocument();
    expect(within(details).getByText("INS_BG_AAPL")).toBeInTheDocument();
    expect(within(details).getByText(/next settlement in 20 min/i)).toBeInTheDocument();
  });

  it("refreshes every 5 seconds and keeps the last data when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiWith(overview(), new Error("REQUEST_FAILED"), overview(rows.slice(0, 1)));
    render(<MarketsPage api={api} now={() => NOW} />);
    await screen.findByRole("rowheader", { name: /TSLA/ });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.marketOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(/refresh failed/i);
    expect(screen.getByRole("rowheader", { name: /TSLA/ })).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.marketOverview).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("rowheader", { name: /TSLA/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
