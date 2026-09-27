import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { DashboardApi, DashboardStreamEvent, Opportunity, OpportunityDetailEnvelope, OpportunityFilters, QuoteTimestamp, VenueView } from "../api/client.js";
import { OpportunityDetail } from "../components/OpportunityDetail.js";
import { OpportunityTable } from "../components/OpportunityTable.js";
import { VenueHealth } from "../components/VenueHealth.js";

export function OpportunitiesPage({ api, initialUnderlying = "equity:NVDA" }: { api: DashboardApi; initialUnderlying?: string }) {
  const [draft, setDraft] = useState({ underlying: initialUnderlying, strategy: "", minEdge: "", notional: "", maxAge: "5000" });
  const [filters, setFilters] = useState<OpportunityFilters>({ underlying: initialUnderlying, max_age_ms: 5000 });
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [quoteTimestamps, setQuoteTimestamps] = useState<QuoteTimestamp[]>([]);
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [venueWarnings, setVenueWarnings] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<OpportunityDetailEnvelope>();
  const [invalidatedIds, setInvalidatedIds] = useState<Set<string>>(new Set());
  const [liveMessage, setLiveMessage] = useState("Connecting to live updates…");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const loadOpportunities = useCallback(async (query: OpportunityFilters) => {
    try {
      const response = await api.scanOpportunities(query);
      setOpportunities(response.result.items);
      setQuoteTimestamps(response.result.quote_timestamps);
      setWarnings(response.warnings);
      setSelectedId((current) => current && response.result.items.some((item) => item.opportunityId === current) ? current : response.result.items[0]?.opportunityId);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Opportunity data is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadOpportunities(filters); }, [filters, loadOpportunities]);
  useEffect(() => {
    let active = true;
    void api.listVenues().then((response) => { if (active) { setVenues(response.result.items); setVenueWarnings(response.warnings); } })
      .catch(() => { if (active) setVenueWarnings(["Venue coverage is unavailable."]); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!selectedId || invalidatedIds.has(selectedId)) { setDetail(undefined); return; }
    let active = true;
    void api.inspectOpportunity(selectedId).then((response) => { if (active) setDetail(response); })
      .catch(() => { if (active) setDetail(undefined); });
    return () => { active = false; };
  }, [api, invalidatedIds, selectedId]);

  const onStreamEvent = useCallback(async (event: DashboardStreamEvent) => {
    setLiveMessage(event.message);
    if (event.kind === "invalidation") {
      setInvalidatedIds((current) => new Set(current).add(event.opportunityId));
      await loadOpportunities(filters);
    } else if (event.kind === "opportunity") {
      const updated = event.detail.result.opportunity;
      setInvalidatedIds((current) => { const next = new Set(current); next.delete(updated.opportunityId); return next; });
      await loadOpportunities(filters);
      if (selectedId === updated.opportunityId) setDetail(event.detail);
    } else if (event.kind === "health") {
      setVenues((current) => current.map((venue) => venue.venue === event.venue.venue ? event.venue : venue));
    }
  }, [filters, loadOpportunities, selectedId]);

  useEffect(() => api.subscribe(filters.underlying, onStreamEvent), [api, filters.underlying, onStreamEvent]);

  const selected = useMemo(() => opportunities.find((item) => item.opportunityId === selectedId), [opportunities, selectedId]);
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setFilters({
      underlying: draft.underlying.trim(),
      strategy: draft.strategy || undefined,
      min_edge_bps: draft.minEdge || undefined,
      min_capacity_usd: draft.notional || undefined,
      max_age_ms: draft.maxAge ? Number(draft.maxAge) : undefined,
    });
  };

  return (
    <main>
      <header className="app-header">
        <a className="brand" href="#results" aria-label="Range dashboard home"><span className="brand-mark">R</span><span>Range</span></a>
        <div><p className="eyebrow">Read-only decision support</p><h1>Opportunity intelligence</h1></div>
        <div className="live-state"><span aria-hidden="true" /><p aria-live="polite">{liveMessage}</p></div>
      </header>

      <p className="disclaimer"><strong>Intelligence, not guaranteed profit.</strong> Values are application-service outputs from synchronized source evidence; Range does not submit orders, sign, hold assets, or manage wallets.</p>
      <VenueHealth venues={venues} warnings={venueWarnings} />

      <section id="results" className="workspace" aria-labelledby="results-heading">
        <div className="results-panel">
          <div className="section-heading"><div><p className="eyebrow">Scanner</p><h2 id="results-heading">Current results</h2></div><span className="result-count">{opportunities.length} returned</span></div>
          <form className="filters" onSubmit={applyFilters}>
            <label><span>Underlying</span><input required value={draft.underlying} onChange={(event) => setDraft({ ...draft, underlying: event.target.value })} /></label>
            <label><span>Strategy</span><select value={draft.strategy} onChange={(event) => setDraft({ ...draft, strategy: event.target.value })}><option value="">All strategies</option><option value="perp_spread">Perpetual spread</option><option value="spot_perp_basis">Spot–perp basis</option><option value="funding_differential">Funding differential</option></select></label>
            <label><span>Minimum net edge</span><div className="input-unit"><input aria-label="Minimum net edge" type="number" step="0.01" value={draft.minEdge} onChange={(event) => setDraft({ ...draft, minEdge: event.target.value })} /><span>bps</span></div></label>
            <label><span>Minimum capacity / notional</span><div className="input-unit"><input aria-label="Minimum capacity / notional" type="number" min="0" step="1" value={draft.notional} onChange={(event) => setDraft({ ...draft, notional: event.target.value })} /><span>USD</span></div></label>
            <label><span>Maximum age</span><div className="input-unit"><input aria-label="Maximum age" type="number" min="0" step="100" value={draft.maxAge} onChange={(event) => setDraft({ ...draft, maxAge: event.target.value })} /><span>ms</span></div></label>
            <button className="apply" type="submit">Apply filters</button>
          </form>
          {warnings.length > 0 && <div className="inline-warning" role="status"><strong>Partial coverage</strong><p>{warnings.join(" · ")}</p></div>}
          {error && <div className="error-state" role="alert"><strong>Results unavailable</strong><p>{error}</p></div>}
          {loading ? <p className="loading">Loading application-service results…</p> : <OpportunityTable opportunities={opportunities} quoteTimestamps={quoteTimestamps} selectedId={selectedId} invalidatedIds={invalidatedIds} onSelect={setSelectedId} />}
        </div>
        {selected ? <OpportunityDetail opportunity={selected} quoteTimestamps={quoteTimestamps} detail={detail} invalidated={invalidatedIds.has(selected.opportunityId)} intentPreviewCapability={api.intentPreviewCapability} /> : <aside className="detail-panel placeholder"><p>Select a current result to inspect economics, depth, freshness, and evidence lineage.</p></aside>}
      </section>
    </main>
  );
}
