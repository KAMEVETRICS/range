import type { DashboardApi, MarketObservation, Opportunity, OpportunityDetailEnvelope } from "../api/client.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { formatAge, formatTimestamp } from "./OpportunityTable.js";

const money = (value: string) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const reasonLabel = (reason: string) => reason.replaceAll("_", " ");

export function OpportunityDetail({ opportunity, observations, detail, invalidated, intentPreviewCapability }: {
  opportunity: Opportunity;
  observations: MarketObservation[];
  detail?: OpportunityDetailEnvelope;
  invalidated: boolean;
  intentPreviewCapability: DashboardApi["intentPreviewCapability"];
}) {
  const stale = invalidated || opportunity.status !== "actionable" || opportunity.freshness.eligibility !== "live" || !opportunity.freshness.synchronized;
  const warning = invalidated ? "This result was invalidated by the live stream and is being refreshed." : stale ? "This result is research-only because its currentness or input eligibility failed." : "Current application-service result. Revalidate before any external execution decision.";
  return (
    <aside className="detail-panel" aria-label="Selected opportunity detail">
      <div className="detail-header">
        <div><p className="eyebrow">Selected result</p><h2>{opportunity.underlyingId.split(":").at(-1)} · {opportunity.strategy.replaceAll("_", " ")}</h2><p>{opportunity.opportunityId}</p></div>
        <span className={`freshness ${stale ? "stale" : "live"}`}>{stale ? "Stale input" : "Current"}</span>
      </div>
      <p className={`state-callout ${stale ? "warning" : "neutral"}`}>{warning}</p>
      <section aria-labelledby="economics-heading">
        <div className="section-heading compact"><div><p className="eyebrow">Application truth</p><h3 id="economics-heading">Economics</h3></div><span>{formatAge(opportunity.freshness.oldestInputMs)}</span></div>
        <dl className="metric-grid">
          <div><dt>Gross edge</dt><dd>{opportunity.grossSpreadBps} bps</dd></div>
          <div><dt>Funding</dt><dd>{opportunity.expectedFundingBps} bps</dd></div>
          <div><dt>Fees</dt><dd>−{opportunity.tradingFeesBps} bps</dd></div>
          <div><dt>Slippage</dt><dd>−{opportunity.slippageBps} bps</dd></div>
          <div><dt>Financing</dt><dd>−{opportunity.financingBps} bps</dd></div>
          <div><dt>Gas / transfer</dt><dd>−{opportunity.gasAndTransferBps} bps</dd></div>
          <div><dt>FX conversion</dt><dd>−{opportunity.fxConversionBps} bps</dd></div>
          <div><dt>Uncertainty</dt><dd>−{opportunity.uncertaintyBufferBps} bps</dd></div>
          <div className="metric-emphasis"><dt>Net edge</dt><dd>{opportunity.netEdgeBps} bps</dd></div>
          <div><dt>Capacity</dt><dd>{money(opportunity.capacityUsd)}</dd></div>
          <div><dt>Expires</dt><dd>{new Date(opportunity.expiresAt).toLocaleTimeString()}</dd></div>
        </dl>
      </section>
      <section className="legs" aria-labelledby="legs-heading">
        <h3 id="legs-heading">Executable-depth inputs</h3>
        {opportunity.legs.map((leg) => {
          const observation = observations.find((candidate) => candidate.eventId === leg.executableQuote.sourceBookEventId);
          return <div className="leg" key={leg.legId}>
            <div><span className={`side side-${leg.side}`}>{leg.side}</span><strong>{leg.instrumentId}</strong></div>
            <dl>
              <div><dt>Average</dt><dd>{leg.executableQuote.averagePrice}</dd></div><div><dt>Worst</dt><dd>{leg.executableQuote.worstPrice}</dd></div><div><dt>Book age</dt><dd>{formatAge(leg.executableQuote.ageMs)}</dd></div>
              <div><dt>Source event</dt><dd className="hash">{leg.executableQuote.sourceBookEventId}</dd></div>
              <div className="leg-timestamp"><dt>Source time</dt><dd>{formatTimestamp(observation?.sourceTimestamp)}</dd></div>
              <div className="leg-timestamp"><dt>Received time</dt><dd>{formatTimestamp(observation?.receivedTimestamp)}</dd></div>
            </dl>
          </div>;
        })}
      </section>
      <EvidencePanel opportunity={opportunity} detail={detail} />
      {(opportunity.rejectionReasons.length > 0 || detail?.result.rejection_history.length) ? <section className="rejection-panel" aria-label="Rejection provenance">
        <div className="section-heading compact"><div><p className="eyebrow">Decision history</p><h3>Rejection provenance</h3></div></div>
        {opportunity.rejectionReasons.length > 0 && <div><strong>Current reasons</strong><ul>{opportunity.rejectionReasons.map((reason) => <li key={reason}>{reasonLabel(reason)}</li>)}</ul></div>}
        {detail?.result.rejection_history.map((entry) => <div className="rejection-revision" key={`${entry.state_revision}:${entry.status}`}>
          <strong>Revision {entry.state_revision} · {entry.status}</strong>
          <p>{entry.rejection_reasons.map(reasonLabel).join(" · ") || "No rejection reason recorded"}</p>
        </div>)}
      </section> : null}
      <section className="intent-boundary" aria-label="Unsigned intent boundary">
        <button type="button" disabled>Create unsigned intent</button>
        <p>{stale ? "Unsigned intent creation is blocked for stale or non-actionable data." : intentPreviewCapability.reason}</p>
      </section>
    </aside>
  );
}
