import { describe, expect, it, vi } from "vitest";
import { StorageQueries, type RequestContext } from "./queries.js";

const context: RequestContext = { traceId: "rng_trace_adapter", clientId: "reader" };

describe("storage query adapter", () => {
  it("uses public venue manifests and passes the request trace through every storage read", async () => {
    const get = vi.fn(async () => undefined);
    const getOpportunity = vi.fn(async () => undefined);
    const readPage = vi.fn(async () => []);
    const query = vi.fn(async (statement: string) => ({ rows: statement.includes("MAX(ordinal)") ? [{ ordinal: "7" }] : [] }));
    const trace = vi.fn();
    const adapter = new StorageQueries(
      { get, query: vi.fn(async () => []), queryOpportunities: vi.fn(async () => []), getOpportunity },
      { getEvidence: vi.fn(async () => undefined), readPage },
      { query },
      [{ venue: "extended", capabilities: ["orderbook"], freshnessBudgetMs: 1000 }], trace,
    );

    expect(await adapter.listVenues(context)).toEqual([{ venue: "extended", capabilities: ["orderbook"],
      freshnessBudgetMs: 1000, health: null, asOfMs: null }]);
    expect(get).toHaveBeenCalledWith("health:extended");
    expect(await adapter.inspectOpportunity(context, "opp_1")).toBeUndefined();
    expect(getOpportunity).toHaveBeenCalledWith("opp_1");
    expect(await adapter.getSourceTimestamps(context, ["evt_book", "evt_funding"])).toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("GROUP BY event_id"), [["evt_book", "evt_funding"]]);
    expect(await adapter.latestEventOrdinal(context)).toBe(7);
    expect(await adapter.readEvents(context, 2, 3)).toEqual([]);
    expect(readPage).toHaveBeenCalledWith({ afterOrdinal: 2, limit: 3 });
    expect(trace.mock.calls.length).toBe(5);
    expect(trace.mock.calls.every(([entry]) => entry.trace_id === context.traceId)).toBe(true);
    expect(JSON.stringify(trace.mock.calls)).not.toContain("reader");
  });

  it("selects the latest instrument version before applying filters and page bounds", async () => {
    const query = vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [] }));
    const adapter = new StorageQueries(
      { get: vi.fn(async () => undefined), query: vi.fn(async () => []), queryOpportunities: vi.fn(async () => []), getOpportunity: vi.fn(async () => undefined) },
      { getEvidence: vi.fn(async () => undefined), readPage: vi.fn(async () => []) },
      { query }, [],
    );
    expect(await adapter.findInstruments(context, { underlying: "equity:TSLA", venue: "extended", limit: 10, offset: 20 })).toEqual([]);
    const [statement, values] = query.mock.calls[0]!;
    expect(statement).toContain("DISTINCT ON (instrument_id)");
    expect(statement).toContain("metadata_version DESC");
    expect(statement.indexOf("DISTINCT ON")).toBeLessThan(statement.indexOf("WHERE ($1"));
    expect(values).toEqual(["equity:TSLA", "extended", 10, 20]);
  });

  it("reads the final accepted revision from the durable authority", async () => {
    const query = vi.fn(async () => ({ rows: [{ revision: "8" }] }));
    const adapter = new StorageQueries(
      { get: vi.fn(async () => undefined), query: vi.fn(async () => []), queryOpportunities: vi.fn(async () => []), getOpportunity: vi.fn(async () => undefined) },
      { getEvidence: vi.fn(async () => undefined), readPage: vi.fn(async () => []) },
      { query }, [],
    );
    expect(await adapter.getAcceptedRevision(context, "equity:TSLA")).toBe(8);
    expect(query).toHaveBeenCalledWith("SELECT revision FROM accepted_revisions WHERE underlying_id=$1", ["equity:TSLA"]);
  });
});
