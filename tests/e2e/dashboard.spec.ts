import { expect, test, type Page } from "@playwright/test";

const opportunity = {
  opportunityId: "opp_nvda_spread_1", stateRevision: 12, strategy: "perp_spread", underlyingId: "equity:NVDA",
  legs: [
    { legId: "buy", instrumentId: "ins_bitget_NVDAUSDT", side: "buy", executableQuote: { side: "buy", requestedNotional: "10000", averagePrice: "131.10", worstPrice: "131.20", filledQuantity: "76.20", filledNotionalUsd: "9998.20", capacityUsd: "15000", depthUtilization: "0.6667", sourceBookEventId: "evt_book_buy_12", sourceEventIds: ["evt_book_buy_12"], ageMs: 241 } },
    { legId: "sell", instrumentId: "ins_hyperliquid_NVDA", side: "sell", executableQuote: { side: "sell", requestedNotional: "10000", averagePrice: "132.02", worstPrice: "131.94", filledQuantity: "76.20", filledNotionalUsd: "10059.92", capacityUsd: "12500", depthUtilization: "0.8", sourceBookEventId: "evt_book_sell_12", sourceEventIds: ["evt_book_sell_12"], ageMs: 284 } },
  ],
  grossSpreadBps: "70.18", expectedFundingBps: "1.20", tradingFeesBps: "12.00", slippageBps: "3.40", financingBps: "0.50",
  gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "4.00", netEdgeBps: "51.48", capacityUsd: "10000",
  freshness: { oldestInputMs: 284, synchronized: true, eligibility: "live", qualityFlags: [] }, expiresAt: "2099-09-27T18:00:02.000Z",
  rejectionReasons: [], status: "actionable", evidenceHash: "evh_0123456789abcdef",
};

const envelope = (result: unknown, warnings: string[] = []) => ({
  status: warnings.length ? "partial" : "ok", as_of: "2026-09-27T18:00:00.000Z", freshness: { oldest_input_ms: 284 }, result,
  evidence: [{ event_id: "evt_book_nvda_12" }], warnings, trace_id: "rng_trace_browser-test",
});

async function mockApi(page: Page) {
  await page.route("**/v1/venues**", (route) => route.fulfill({ json: envelope({ items: [
    { venue: "bitget", capabilities: ["book"], freshnessBudgetMs: 2000, asOfMs: 1790532000000, health: { venue: "bitget", connectionState: "connected", lastEventAgeMs: 284, clockSkewMs: 12, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } },
    { venue: "variational", capabilities: ["reference_quote"], freshnessBudgetMs: 60000, asOfMs: null, health: null },
  ], next_offset: null }, ["variational: venue missing"]) }));
  await page.route("**/v1/markets/snapshot**", (route) => route.fulfill({ json: envelope({ underlying: "equity:NVDA", observations: [
    { eventId: "evt_book_buy_12", schemaVersion: 1, venue: "bitget", instrumentId: "ins_bitget_NVDAUSDT", sequence: 812,
      transport: "websocket", freshnessBudgetMs: 2000, qualityFlags: [], eligibility: "live",
      sourceTimestamp: Date.parse("2026-09-27T17:59:59.716Z"), receivedTimestamp: Date.parse("2026-09-27T17:59:59.748Z"),
      payload: { kind: "order_book", bids: [{ price: "131.10", quantity: "76.20" }], asks: [{ price: "131.20", quantity: "76.20" }], capacityUsd: "15000" } },
    { eventId: "evt_book_sell_12", schemaVersion: 1, venue: "hyperliquid_hip3", instrumentId: "ins_hyperliquid_NVDA", sequence: "0x12",
      transport: "websocket", freshnessBudgetMs: 2000, qualityFlags: [], eligibility: "live",
      sourceTimestamp: Date.parse("2026-09-27T17:59:59.700Z"), receivedTimestamp: Date.parse("2026-09-27T17:59:59.735Z"),
      payload: { kind: "order_book", bids: [{ price: "131.94", quantity: "76.20" }], asks: [{ price: "132.02", quantity: "76.20" }], capacityUsd: "12500" } },
  ] }) }));
  await page.route("**/v1/opportunities/opp_nvda_spread_1", (route) => route.fulfill({ json: envelope({ opportunity, rejection_history: [] }) }));
  await page.route(/\/v1\/opportunities(?:\?.*)?$/, (route) => route.fulfill({ json: envelope({ items: [opportunity], next_offset: null }) }));
  await page.route("**/v1/stream**", (route) => route.abort());
}

test("scan, inspect evidence, and explain the safe intent-preview boundary", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Opportunity intelligence" })).toBeVisible();
  const row = page.getByRole("row", { name: /NVDA.*51\.48 bps/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("131.10 avg / 131.20 worst")).toBeVisible();
  await expect(row.getByText("evt_book_buy_12")).toBeVisible();
  await row.click();
  const detail = page.getByRole("complementary", { name: "Selected opportunity detail" });
  await expect(detail.getByRole("heading", { name: "Evidence" })).toBeVisible();
  await expect(detail.getByText("evh_0123456789abcdef")).toBeVisible();
  await expect(detail.getByText("Financing")).toBeVisible();
  await expect(detail.getByText("Gas / transfer")).toBeVisible();
  await expect(detail.getByText("FX conversion")).toBeVisible();
  await expect(detail.getByText("2026-09-27T17:59:59.716Z")).toBeVisible();
  await expect(detail.getByText("2026-09-27T17:59:59.748Z")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create unsigned intent" })).toBeDisabled();
  await expect(page.getByText(/requires a server-side intent:create scope/i)).toBeVisible();
});

test("keeps the dashboard within a 320 px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("cell", { name: /Net edge 51\.48 bps/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
