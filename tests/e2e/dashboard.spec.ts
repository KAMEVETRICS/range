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

const quoteTimestamps = [
  { event_id: "evt_book_buy_12", source_timestamp_ms: Date.parse("2026-09-27T17:59:59.716Z"), received_timestamp_ms: Date.parse("2026-09-27T17:59:59.748Z") },
  { event_id: "evt_book_sell_12", source_timestamp_ms: Date.parse("2026-09-27T17:59:59.700Z"), received_timestamp_ms: Date.parse("2026-09-27T17:59:59.735Z") },
];

async function mockApi(page: Page) {
  await page.route("**/v1/venues**", (route) => route.fulfill({ json: envelope({ items: [
    { venue: "bitget", capabilities: ["book"], freshnessBudgetMs: 2000, asOfMs: 1790532000000, health: { venue: "bitget", connectionState: "connected", lastEventAgeMs: 284, clockSkewMs: 12, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } },
    { venue: "variational", capabilities: ["reference_quote"], freshnessBudgetMs: 60000, asOfMs: null, health: null },
  ], next_offset: null }, ["variational: venue missing"]) }));
  await page.route("**/v1/opportunities/opp_nvda_spread_1", (route) => route.fulfill({ json: envelope({ opportunity, rejection_history: [], quote_timestamps: quoteTimestamps }) }));
  await page.route(/\/v1\/opportunities(?:\?.*)?$/, (route) => route.fulfill({ json: envelope({ items: [opportunity], quote_timestamps: quoteTimestamps, next_offset: null }) }));
  await page.route("**/v1/stream**", (route) => route.abort());
}

test("scan, inspect evidence, and explain the safe intent-preview boundary", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await mockApi(page);
  await page.goto("/#opportunities");

  await expect(page.getByRole("heading", { level: 1, name: "Opportunities" })).toBeVisible();
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
  await expect(detail.getByText("17:59:59.716 UTC")).toBeVisible();
  await expect(detail.getByText("17:59:59.748 UTC")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create unsigned intent" })).toBeDisabled();
  await expect(page.getByText(/requires a server-side intent:create scope/i)).toBeVisible();
});

test("keeps a long valid decimal price within a 320 px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockApi(page);
  const longPrice = "0.12345678901234567890123456789012345678901234567890123456789012345678901234567890";
  await page.route(/\/v1\/opportunities(?:\?.*)?$/, (route) => route.fulfill({ json: envelope({ items: [{
    ...opportunity,
    legs: opportunity.legs.map((leg) => ({ ...leg, executableQuote: { ...leg.executableQuote, averagePrice: longPrice, worstPrice: longPrice } })),
  }], quote_timestamps: quoteTimestamps, next_offset: null }) }));
  await page.goto("/#opportunities");
  await expect(page.getByRole("cell", { name: /Net edge 51\.48 bps/ })).toBeVisible();
  const price = page.getByRole("row", { name: /NVDA/ }).getByText("0.1235 avg / 0.1235 worst").first();
  const bounds = await price.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("shows every page tab within a 320 px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await mockApi(page);
  await page.goto("/#overview");
  const nav = page.getByRole("navigation", { name: "Dashboard pages" });
  for (const name of ["Overview", "Opportunities", "Markets"]) {
    const bounds = (await nav.getByRole("link", { name, exact: true }).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
  expect(await nav.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("keeps a reviewed pair's long status clear of its strategy within a 320 px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockApi(page);
  const side = (venue: string, venueSymbol: string, averagePrice: string) => ({ instrumentId: `ins_${venue}_${venueSymbol}`, venue, venueSymbol, averagePrice });
  await page.route("**/v1/pairs", (route) => route.fulfill({ json: envelope({ as_of_ms: Date.now(), pairs: [{
    underlyingId: "equity:NVDA", strategy: "perp_spread", status: "rejected",
    rejectionReasons: ["NET_EDGE_BELOW_THRESHOLD", "INSUFFICIENT_DEPTH", "STALE_INPUT", "UNSYNCHRONIZED_INPUTS"],
    buy: side("hyperliquid_hip3", "xyz:NVDA", "234.46"), sell: side("bitget", "NVDAUSDT", "234.58"),
    grossSpreadBps: "5.03", expectedFundingBps: "-0.06", costsBps: "8.90", netEdgeBps: "-3.94", capacityUsd: "2500",
    requestedNotionalUsd: "2500", evaluatedAtMs: Date.now() - 2_000,
  }] }) }));
  await page.goto("/#overview");
  const row = page.getByRole("row", { name: /NVDA/ });
  await expect(row.getByText("below costs, not enough depth, stale quote, unsynchronized inputs")).toBeVisible();
  const strategy = (await row.locator('td[data-label="Strategy"]').boundingBox())!;
  const status = (await row.locator('td[data-label="Status"]').boundingBox())!;
  expect(status.y).toBeGreaterThanOrEqual(strategy.y + strategy.height);
  expect(status.x + status.width).toBeLessThanOrEqual(320);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
