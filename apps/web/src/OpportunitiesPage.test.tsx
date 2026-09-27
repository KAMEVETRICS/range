// @vitest-environment jsdom
import "./test-setup.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpportunitiesPage } from "./pages/OpportunitiesPage.js";
import type { DashboardApi, Opportunity, OpportunityEnvelope, VenueEnvelope } from "./api/client.js";

const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  opportunityId: "opp_nvda_spread_1",
  stateRevision: 12,
  strategy: "perp_spread",
  underlyingId: "equity:NVDA",
  legs: [
    { legId: "buy", instrumentId: "ins_bitget_NVDAUSDT", side: "buy", executableQuote: { side: "buy", requestedNotional: "10000", averagePrice: "131.10", worstPrice: "131.20", filledQuantity: "76.20", filledNotionalUsd: "9998.20", capacityUsd: "15000", depthUtilization: "0.6667", sourceBookEventId: "evt_book_buy_12", sourceEventIds: ["evt_book_buy_12"], ageMs: 241 } },
    { legId: "sell", instrumentId: "ins_hyperliquid_NVDA", side: "sell", executableQuote: { side: "sell", requestedNotional: "10000", averagePrice: "132.02", worstPrice: "131.94", filledQuantity: "76.20", filledNotionalUsd: "10059.92", capacityUsd: "12500", depthUtilization: "0.8", sourceBookEventId: "evt_book_sell_12", sourceEventIds: ["evt_book_sell_12"], ageMs: 284 } },
  ],
  grossSpreadBps: "70.18",
  expectedFundingBps: "1.20",
  tradingFeesBps: "12.00",
  slippageBps: "3.40",
  financingBps: "0.50",
  gasAndTransferBps: "0",
  fxConversionBps: "0",
  uncertaintyBufferBps: "4.00",
  netEdgeBps: "51.48",
  capacityUsd: "10000",
  freshness: { oldestInputMs: 284, synchronized: true, eligibility: "live", qualityFlags: [] },
  expiresAt: "2026-09-27T18:00:02.000Z",
  rejectionReasons: [],
  status: "actionable",
  evidenceHash: "evh_0123456789abcdef",
  ...overrides,
});

const staleOpportunity = opportunity({
  status: "expired",
  freshness: { oldestInputMs: 12_400, synchronized: false, eligibility: "stale", qualityFlags: ["source age exceeds budget"] },
  rejectionReasons: ["STALE_INPUT"],
});

const opportunities = (items: Opportunity[], warnings: string[] = []): OpportunityEnvelope => ({
  status: warnings.length ? "partial" : "ok",
  as_of: "2026-09-27T18:00:00.000Z",
  freshness: { oldest_input_ms: Math.max(0, ...items.map((item) => item.freshness.oldestInputMs)) },
  result: { items, next_offset: null },
  evidence: items.flatMap((item) => item.evidenceHash ? [{ event_id: `evt_${item.stateRevision}` }] : []),
  warnings,
  trace_id: "rng_trace_dashboard-test",
});

const marketSnapshot = {
  status: "ok" as const,
  as_of: "2026-09-27T17:59:59.716Z",
  freshness: { oldest_input_ms: 284 },
  result: {
    underlying: "equity:NVDA",
    observations: [
      { eventId: "evt_book_buy_12", schemaVersion: 1, venue: "bitget", instrumentId: "ins_bitget_NVDAUSDT", sequence: 812,
        transport: "websocket" as const, freshnessBudgetMs: 2000, qualityFlags: [], eligibility: "live" as const,
        sourceTimestamp: Date.parse("2026-09-27T17:59:59.716Z"), receivedTimestamp: Date.parse("2026-09-27T17:59:59.748Z"),
        payload: { kind: "order_book" as const, bids: [{ price: "131.10", quantity: "76.20" }], asks: [{ price: "131.20", quantity: "76.20" }], capacityUsd: "15000" } },
      { eventId: "evt_book_sell_12", schemaVersion: 1, venue: "hyperliquid_hip3", instrumentId: "ins_hyperliquid_NVDA", sequence: "0x12",
        transport: "websocket" as const, freshnessBudgetMs: 2000, qualityFlags: [], eligibility: "live" as const,
        sourceTimestamp: Date.parse("2026-09-27T17:59:59.700Z"), receivedTimestamp: Date.parse("2026-09-27T17:59:59.735Z"),
        payload: { kind: "order_book" as const, bids: [{ price: "131.94", quantity: "76.20" }], asks: [{ price: "132.02", quantity: "76.20" }], capacityUsd: "12500" } },
    ],
  },
  evidence: [{ event_id: "evt_book_buy_12" }, { event_id: "evt_book_sell_12" }],
  warnings: [],
  trace_id: "rng_trace_market-test",
};

const venues: VenueEnvelope = {
  status: "partial",
  as_of: "2026-09-27T18:00:00.000Z",
  freshness: { oldest_input_ms: 611 },
  result: {
    items: [
      { venue: "bitget", capabilities: ["book", "funding"], freshnessBudgetMs: 2000, asOfMs: 1790532000000, health: { venue: "bitget", connectionState: "connected", lastEventAgeMs: 284, clockSkewMs: 12, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } },
      { venue: "hyperliquid_hip3", capabilities: ["book"], freshnessBudgetMs: 2000, asOfMs: 1790532000000, health: { venue: "hyperliquid_hip3", connectionState: "degraded", lastEventAgeMs: 611, clockSkewMs: 25, sequenceIntegrity: "unknown", rateLimit: { state: "limited", retryAfterMs: 400 }, capabilityChanges: [], errorCounters: { reconnect: 1 } } },
      { venue: "variational", capabilities: ["reference_quote"], freshnessBudgetMs: 60000, asOfMs: null, health: null },
    ],
    next_offset: null,
  },
  evidence: [],
  warnings: ["hyperliquid_hip3: venue degraded", "variational: venue missing"],
  trace_id: "rng_trace_venues-test",
};

function apiWith(items: Opportunity[], detail = items[0], warnings: string[] = []): DashboardApi {
  const api = {
    scanOpportunities: vi.fn().mockResolvedValue(opportunities(items, warnings)),
    inspectOpportunity: vi.fn().mockResolvedValue({
      ...opportunities([detail!]),
      result: {
        opportunity: detail!,
        rejection_history: detail?.rejectionReasons.length ? [{ state_revision: detail.stateRevision, status: "rejected", rejection_reasons: detail.rejectionReasons }] : [],
      },
    }),
    getMarketSnapshot: vi.fn().mockResolvedValue(marketSnapshot),
    listVenues: vi.fn().mockResolvedValue(venues),
    subscribe: vi.fn(() => () => undefined),
    intentPreviewCapability: { available: false as const, reason: "Intent preview requires a server-side intent:create scope; no privileged token is exposed to this browser." },
  };
  return api;
}

afterEach(cleanup);

describe("Range opportunities dashboard", () => {
  it("shows stale age and disables intent creation", async () => {
    render(<OpportunitiesPage api={apiWith([staleOpportunity])} initialUnderlying="equity:NVDA" />);

    expect((await screen.findAllByText("Stale input"))[0]).toBeVisible();
    expect(screen.getAllByText("12.4 s old")[0]).toBeVisible();
    expect(screen.getByRole("button", { name: "Create unsigned intent" })).toBeDisabled();
  });

  it("shows gross edge, costs, net edge, capacity, and evidence", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const detail = await screen.findByRole("complementary", { name: "Selected opportunity detail" });
    for (const label of ["Gross edge", "Fees", "Slippage", "Net edge", "Capacity", "Evidence"]) {
      expect(await within(detail).findByText(label)).toBeVisible();
    }
    expect(within(detail).getByText("51.48 bps")).toBeVisible();
    expect(within(detail).getByText("evh_0123456789abcdef")).toBeVisible();
    expect(screen.getByText(/not guaranteed profit/i)).toBeVisible();
  });

  it("shows server-returned cost components without calculating a browser-side total", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const row = await screen.findByRole("row", { name: /NVDA/ });
    expect(within(row).getByText("Fees 12.00 · slip 3.40 bps")).toBeVisible();
    expect(within(row).queryByText("19.90 bps")).not.toBeInTheDocument();
  });

  it("shows every returned cost component including zero values", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const detail = await screen.findByRole("complementary", { name: "Selected opportunity detail" });
    const financing = within(detail).getByText("Financing").closest("div")!;
    const transfer = within(detail).getByText("Gas / transfer").closest("div")!;
    const fx = within(detail).getByText("FX conversion").closest("div")!;
    expect(within(financing).getByText("−0.50 bps")).toBeVisible();
    expect(within(transfer).getByText("−0 bps")).toBeVisible();
    expect(within(fx).getByText("−0 bps")).toBeVisible();
  });

  it("shows source and receive timestamps for executable quote events", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const detail = await screen.findByRole("complementary", { name: "Selected opportunity detail" });
    expect(within(detail).getAllByText("Source time")).toHaveLength(2);
    expect(within(detail).getByText("2026-09-27T17:59:59.716Z")).toBeVisible();
    expect(within(detail).getAllByText("Received time")).toHaveLength(2);
    expect(within(detail).getByText("2026-09-27T17:59:59.748Z")).toBeVisible();
    expect(within(detail).getByText("Envelope as of")).toBeVisible();
  });

  it("shows executable prices and evidence lineage on every result row", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const row = await screen.findByRole("row", { name: /NVDA/ });
    expect(within(row).getByText("131.10 avg / 131.20 worst")).toBeVisible();
    expect(within(row).getByText("evt_book_buy_12")).toBeVisible();
    expect(within(row).getByText("evh_0123456789abcdef")).toBeVisible();
  });

  it("shows current rejection reasons and historical revision provenance", async () => {
    render(<OpportunitiesPage api={apiWith([staleOpportunity])} initialUnderlying="equity:NVDA" />);

    const provenance = await screen.findByRole("region", { name: "Rejection provenance" });
    expect(within(provenance).getByText("Current reasons")).toBeVisible();
    expect(within(provenance).getAllByText("STALE INPUT").length).toBeGreaterThan(0);
    expect(await within(provenance).findByText("Revision 12 · rejected")).toBeVisible();
  });

  it("preserves filters and refetches after a streamed invalidation", async () => {
    const api = apiWith([opportunity()]);
    let streamHandler: Parameters<DashboardApi["subscribe"]>[1] | undefined;
    vi.mocked(api.subscribe).mockImplementation((_underlying, handler) => { streamHandler = handler; return () => undefined; });
    const user = userEvent.setup();
    render(<OpportunitiesPage api={api} initialUnderlying="equity:NVDA" />);
    await screen.findAllByText("51.48 bps");
    await user.selectOptions(screen.getByLabelText("Strategy"), "perp_spread");
    await user.clear(screen.getByLabelText("Minimum net edge"));
    await user.type(screen.getByLabelText("Minimum net edge"), "25");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    vi.mocked(api.scanOpportunities).mockResolvedValueOnce(opportunities([]));

    await streamHandler?.({ kind: "invalidation", opportunityId: "opp_nvda_spread_1", message: "Opportunity invalidated by live update." });

    expect(await screen.findByText("Opportunity invalidated by live update.")).toBeVisible();
    expect(screen.getByLabelText("Minimum net edge")).toHaveValue(25);
    expect(api.scanOpportunities).toHaveBeenLastCalledWith(expect.objectContaining({ strategy: "perp_spread", min_edge_bps: "25" }));
  });

  it("refetches when a streamed opportunity is absent from the current scan", async () => {
    const current = opportunity();
    const incoming = opportunity({ opportunityId: "opp_nvda_spread_2", stateRevision: 13, netEdgeBps: "44.00", evidenceHash: "evh_fedcba9876543210" });
    const api = apiWith([current]);
    let streamHandler: Parameters<DashboardApi["subscribe"]>[1] | undefined;
    vi.mocked(api.subscribe).mockImplementation((_underlying, handler) => { streamHandler = handler; return () => undefined; });
    render(<OpportunitiesPage api={api} initialUnderlying="equity:NVDA" />);
    await screen.findByRole("row", { name: /opp_nvda_spread_1|NVDA/ });
    vi.mocked(api.scanOpportunities).mockResolvedValueOnce(opportunities([current, incoming]));

    await streamHandler?.({ kind: "opportunity", message: "New opportunity published.", detail: {
      ...opportunities([incoming]), result: { opportunity: incoming, rejection_history: [] },
    } });

    expect(await screen.findByText("44.00 bps")).toBeVisible();
    expect(api.scanOpportunities).toHaveBeenCalledTimes(2);
  });

  it("labels degraded and missing venues without implying they are actionable", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    const health = await screen.findByRole("region", { name: "Venue health" });
    expect(within(health).getByText("Degraded")).toBeVisible();
    expect(within(health).getByText("Missing")).toBeVisible();
    expect(within(health).getByText(/excluded from actionable results/i)).toBeVisible();
  });

  it("explains why unsigned intent preview is unavailable in the browser", async () => {
    render(<OpportunitiesPage api={apiWith([opportunity()])} initialUnderlying="equity:NVDA" />);

    expect(await screen.findByRole("button", { name: "Create unsigned intent" })).toBeDisabled();
    expect(screen.getByText(/requires a server-side intent:create scope/i)).toBeVisible();
  });
});
