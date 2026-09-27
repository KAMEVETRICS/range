import type { DashboardApi, Opportunity, OpportunityDetailEnvelope } from "../api/client.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { formatAge } from "./OpportunityTable.js";

const money = (value: string) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function OpportunityDetail({ opportunity, detail, invalidated, intentPreviewCapability }: {
  opportunity: Opportunity;
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
          <div><dt>Uncertainty</dt><dd>−{opportunity.uncertaintyBufferBps} bps</dd></div>
          <div className="metric-emphasis"><dt>Net edge</dt><dd>{opportunity.netEdgeBps} bps</dd></div>
          <div><dt>Capacity</dt><dd>{money(opportunity.capacityUsd)}</dd></div>
          <div><dt>Expires</dt><dd>{new Date(opportunity.expiresAt).toLocaleTimeString()}</dd></div>
        </dl>
      </section>
      <section className="legs" aria-labelledby="legs-heading">
        <h3 id="legs-heading">Executable-depth inputs</h3>
        {opportunity.legs.map((leg) => <div className="leg" key={leg.legId}>
          <div><span className={`side side-${leg.side}`}>{leg.side}</span><strong>{leg.instrumentId}</strong></div>
          <dl><div><dt>Average</dt><dd>{leg.executableQuote.averagePrice}</dd></div><div><dt>Worst</dt><dd>{leg.executableQuote.worstPrice}</dd></div><div><dt>Book age</dt><dd>{formatAge(leg.executableQuote.ageMs)}</dd></div></dl>
        </div>)}
      </section>
      <EvidencePanel opportunity={opportunity} detail={detail} />
      <section className="intent-boundary" aria-label="Unsigned intent boundary">
        <button type="button" disabled>Create unsigned intent</button>
        <p>{stale ? "Unsigned intent creation is blocked for stale or non-actionable data." : intentPreviewCapability.reason}</p>
      </section>
    </aside>
  );
}
