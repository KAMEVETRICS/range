// @vitest-environment jsdom
import "./test-setup.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, parseRoute } from "./App.js";
import type { DashboardApi } from "./api/client.js";

const envelope = (result: unknown) => ({ status: "ok", as_of: "2026-09-29T22:00:00.000Z", freshness: { oldest_input_ms: 0 }, result,
  evidence: [], warnings: [], trace_id: "rng_trace_app" });
const api = () => ({
  marketOverview: vi.fn().mockResolvedValue(envelope({ board_as_of_ms: null, matching: "ticker_unreviewed", rows: [] })),
  pairEvaluations: vi.fn().mockResolvedValue(envelope({ as_of_ms: null, pairs: [] })),
  scanOpportunities: vi.fn().mockResolvedValue(envelope({ items: [], quote_timestamps: [], next_offset: null })),
  inspectOpportunity: vi.fn(),
  listVenues: vi.fn().mockResolvedValue(envelope({ items: [], next_offset: null })),
  subscribe: vi.fn(() => () => undefined),
  intentPreviewCapability: { available: false, reason: "test" },
}) as unknown as DashboardApi;
const navigate = (hash: string) => act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("routes", () => {
  it("reads a page and the underlying it opens on, and ignores other anchors", () => {
    expect(parseRoute("#markets")).toEqual({ page: "markets" });
    expect(parseRoute("#opportunities/equity:NVDA")).toEqual({ page: "opportunities", underlying: "equity:NVDA" });
    expect(parseRoute("#results")).toBeUndefined();
    expect(parseRoute("")).toBeUndefined();
  });
});

// The first render pays jsdom and React start-up, which on a busy host has exceeded the default 5 s.
describe("dashboard pages", { timeout: 15_000 }, () => {
  it("opens on the overview and switches pages by their links, ignoring other in-page anchors", async () => {
    const dashboard = api();
    render(<App api={dashboard} />);
    expect(await screen.findByRole("heading", { level: 1, name: /cross-venue stock arbitrage/i })).toBeVisible();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(document.body.dataset.page).toBe("overview");
    expect(document.title).toBe("Range — Overview");
    expect(dashboard.subscribe).not.toHaveBeenCalled();

    navigate("#opportunities");
    expect(await screen.findByRole("heading", { level: 1, name: "Opportunities" })).toBeVisible();
    expect(document.body.dataset.page).toBe("opportunities");
    expect(document.title).toBe("Range — Opportunities");
    navigate("#results");
    expect(screen.getByRole("heading", { level: 1, name: "Opportunities" })).toBeVisible();
    navigate("#markets");
    expect(await screen.findByRole("heading", { level: 1, name: "Markets" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Markets" })).toHaveAttribute("aria-current", "page");
  });

  it("opens the scanner on the stock a link names", async () => {
    const dashboard = api();
    window.location.hash = "#opportunities/equity:TSLA";
    render(<App api={dashboard} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Opportunities" })).toBeVisible();
    expect(dashboard.scanOpportunities).toHaveBeenCalledWith(expect.objectContaining({ underlying: "equity:TSLA" }));
  });
});
