import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DashboardApi, DashboardStreamEvent, Opportunity, OpportunityDetailEnvelope, OpportunityFilters, QuoteTimestamp, VenueView } from "../api/client.js";
import { pollWhileIdle } from "../api/poll.js";
import { OpportunityDetail } from "../components/OpportunityDetail.js";
import { OpportunityTable } from "../components/OpportunityTable.js";
import { ReviewedPairs } from "../components/ReviewedPairs.js";
import { VenueHealth } from "../components/VenueHealth.js";

/** Actionable results live a second or two, so the scanner refreshes itself while shown; the live stream only nudges it. */
const SCAN_REFRESH_MS = 2_000;

export function OpportunitiesPage({ api, initialUnderlying = "equity:NVDA", scanRefreshMs = SCAN_REFRESH_MS }: {
  api: DashboardApi; initialUnderlying?: string; /** 0 turns the refresh off. */ scanRefreshMs?: number;
}) {
  // No age limit by default: a result's age counts its funding updates, which arrive tens of seconds apart, so a 5 s
  // limit hid every result. The worker already expires a result once its quotes or funding go stale.
  const [draft, setDraft] = useState({ underlying: initialUnderlying, strategy: "", minEdge: "", notional: "", maxAge: "" });
  const [filters, setFilters] = useState<OpportunityFilters>({ underlying: initialUnderlying });
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [quoteTimestamps, setQuoteTimestamps] = useState<QuoteTimestamp[]>([]);
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [venueWarnings, setVenueWarnings] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  // A result the viewer picked stays selected after it leaves the list, and is shown as it ended; otherwise the first
  // listed result is selected.
  const picked = useRef(false);
  const [detail, setDetail] = useState<OpportunityDetailEnvelope>();
  const [invalidatedIds, setInvalidatedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const loadOpportunities = useCallback(async (query: OpportunityFilters) => {
    try {
      const response = await api.scanOpportunities(query);
      setOpportunities(response.result.items);
      setQuoteTimestamps(response.result.quote_timestamps);
      setWarnings(response.warnings);
      setSelectedId((current) => current && (picked.current || response.result.items.some((item) => item.opportunityId === current))
        ? current : response.result.items[0]?.opportunityId);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Opportunity data is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadOpportunities(filters); }, [filters, loadOpportunities]);
  useEffect(() => scanRefreshMs > 0
    ? pollWhileIdle(() => loadOpportunities(filters), scanRefreshMs, { immediate: false, skip: () => document.hidden })
    : undefined, [filters, loadOpportunities, scanRefreshMs]);
  useEffect(() => {
    let active = true;
    void api.listVenues().then((response) => { if (active) { setVenues(response.result.items); setVenueWarnings(response.warnings); } })
      .catch(() => { if (active) setVenueWarnings(["Venue coverage is unavailable."]); });
    return () => { active = false; };
  }, [api]);

  // The detail is read again once the selected result stops being current (it left the list or the stream invalidated
  // it), when the server shows it as it ended.
  const listed = opportunities.some((item) => item.opportunityId === selectedId);
  const invalidatedSelection = selectedId !== undefined && invalidatedIds.has(selectedId);
  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let active = true;
    void api.inspectOpportunity(selectedId).then((response) => { if (active) setDetail(response); })
      .catch(() => { if (active) setDetail(undefined); });
    return () => { active = false; };
  }, [api, invalidatedSelection, listed, selectedId]);

  // The stream handler reads the latest state through a ref, so it keeps one identity: the stream opens once per
  // underlying, not again on every selection or result change.
  const latest = useRef({ filters, selectedId, opportunities });
  useEffect(() => { latest.current = { filters, selectedId, opportunities }; });
  const onStreamEvent = useCallback(async (event: DashboardStreamEvent) => {
    const { filters: current, selectedId: selected, opportunities: shown } = latest.current;
    const listed = (id: string) => shown.some((item) => item.opportunityId === id);
    if (event.kind === "invalidation") {
      // Most invalidations are rejected results, which the scan never lists; reloading for each (several a second) made
      // one open page scan twice a second. Only a listed or selected result's invalidation changes what is shown.
      if (!listed(event.opportunityId) && selected !== event.opportunityId) return;
      setInvalidatedIds((ids) => new Set(ids).add(event.opportunityId));
      await loadOpportunities(current);
    } else if (event.kind === "opportunity") {
      const updated = event.detail.result.opportunity;
      setInvalidatedIds((ids) => {
        if (!ids.has(updated.opportunityId)) return ids;
        const next = new Set(ids); next.delete(updated.opportunityId); return next;
      });
      if (updated.status === "actionable" || listed(updated.opportunityId)) await loadOpportunities(current);
      if (selected === updated.opportunityId) setDetail(event.detail);
    } else if (event.kind === "health") {
      setVenues((venues) => venues.map((venue) => venue.venue === event.venue.venue ? event.venue : venue));
    }
  }, [loadOpportunities]);

  useEffect(() => api.subscribe(filters.underlying, onStreamEvent), [api, filters.underlying, onStreamEvent]);

  const selected = useMemo(() => opportunities.find((item) => item.opportunityId === selectedId) ??
    (detail?.result.opportunity.opportunityId === selectedId ? detail?.result.opportunity : undefined), [detail, opportunities, selectedId]);
  const select = (id: string) => { picked.current = true; setSelectedId(id); };
  const unpick = () => { picked.current = false; setSelectedId(undefined); };
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    unpick();
    setFilters({
      underlying: draft.underlying.trim(),
      strategy: draft.strategy || undefined,
      min_edge_bps: draft.minEdge || undefined,
      min_capacity_usd: draft.notional || undefined,
      max_age_ms: draft.maxAge ? Number(draft.maxAge) : undefined,
    });
  };

  return (
    <main className="page opportunities">
      <header className="page-head">
        <div>
          <p className="eyebrow">Reviewed pairs · Bitget × trade.xyz</p>
          <h1>Opportunities</h1>
          <p className="page-sub">Every reviewed pair's latest evaluation, and a scanner of the results that clear every cost. Pick a pair to scan its stock.</p>
        </div>
      </header>

      <p className="disclaimer"><strong>Intelligence, not guaranteed profit.</strong> Values are application-service outputs from synchronized source evidence; Range does not submit orders, sign, hold assets, or manage wallets.</p>
      <VenueHealth venues={venues} warnings={venueWarnings} />
      <ReviewedPairs api={api} onSelectUnderlying={(underlying) => {
        unpick();
        setDraft((current) => ({ ...current, underlying }));
        setFilters((current) => ({ ...current, underlying }));
        document.getElementById("results")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }} />

      <section id="results" className="workspace" aria-labelledby="results-heading">
        <div className="panel results-panel">
          <div className="panel-head">
            <div><p className="eyebrow">Scanner · {filters.underlying.replace(/^equity:/, "")}</p><h2 id="results-heading">Current results</h2></div>
            <span className="count">{opportunities.length} returned</span>
          </div>
          <form className="filters" onSubmit={applyFilters}>
            <label><span>Underlying</span><input required value={draft.underlying} onChange={(event) => setDraft({ ...draft, underlying: event.target.value })} /></label>
            <label><span>Strategy</span><select value={draft.strategy} onChange={(event) => setDraft({ ...draft, strategy: event.target.value })}><option value="">All strategies</option><option value="perp_spread">Perpetual spread</option><option value="spot_perp_basis">Spot–perp basis</option><option value="funding_differential">Funding differential</option></select></label>
            <label><span>Minimum net edge</span><div className="input-unit"><input aria-label="Minimum net edge" type="number" step="0.01" value={draft.minEdge} onChange={(event) => setDraft({ ...draft, minEdge: event.target.value })} /><span>bps</span></div></label>
            <label><span>Minimum capacity / notional</span><div className="input-unit"><input aria-label="Minimum capacity / notional" type="number" min="0" step="1" value={draft.notional} onChange={(event) => setDraft({ ...draft, notional: event.target.value })} /><span>USD</span></div></label>
            <label><span>Maximum age</span><div className="input-unit"><input aria-label="Maximum age" type="number" min="0" step="100" value={draft.maxAge} onChange={(event) => setDraft({ ...draft, maxAge: event.target.value })} /><span>ms</span></div></label>
            <button className="button primary apply" type="submit">Apply filters</button>
          </form>
          {warnings.length > 0 && <div className="notice warn" role="status"><strong>Partial coverage</strong> {warnings.join(" · ")}</div>}
          {error && <div className="notice bad" role="alert"><strong>Results unavailable</strong> {error}</div>}
          {loading ? <p className="loading">Loading application-service results…</p> : <OpportunityTable opportunities={opportunities} quoteTimestamps={quoteTimestamps} selectedId={selectedId} invalidatedIds={invalidatedIds} onSelect={select} />}
        </div>
        {selected ? <OpportunityDetail opportunity={selected} quoteTimestamps={quoteTimestamps} detail={detail}
          invalidated={invalidatedIds.has(selected.opportunityId) || (!listed && selected.status === "actionable")} intentPreviewCapability={api.intentPreviewCapability} />
          : <aside className="panel detail-panel placeholder"><p>Select a current result to inspect its economics, depth, freshness, and evidence lineage.</p></aside>}
      </section>
    </main>
  );
}
