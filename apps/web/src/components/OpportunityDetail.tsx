import type { DashboardApi, Opportunity, OpportunityDetailEnvelope, QuoteTimestamp } from "../api/client.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { formatAge, formatBpsNumber, formatPrice, formatTimestamp, formatUtcClock, shortId } from "./OpportunityTable.js";

const money = (value: string) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const bps = (value: string) => `${formatBpsNumber(value)} bps`;
/** A cost as what it takes off the edge; zero carries no sign. */
const cost = (value: string) => {
  const shown = formatBpsNumber(value);
  return shown === "0.00" ? "0.00 bps" : shown.startsWith("-") ? `+${shown.slice(1)} bps` : `−${shown} bps`;
};

const reasonLabel = (reason: string) => reason.replaceAll("_", " ");

export function OpportunityDetail({ opportunity, quoteTimestamps, detail, invalidated, intentPreviewCapability }: {
  opportunity: Opportunity;
  quoteTimestamps: QuoteTimestamp[];
  detail?: OpportunityDetailEnvelope;
  invalidated: boolean;
  intentPreviewCapability: DashboardApi["intentPreviewCapability"];
}) {
  const stale = invalidated || opportunity.status !== "actionable" || opportunity.freshness.eligibility !== "live" || !opportunity.freshness.synchronized;
  const warning = invalidated ? "This result was invalidated by the live stream and is being refreshed." : stale ? "This result is research-only because its currentness or input eligibility failed." : "Current application-service result. Revalidate before any external execution decision.";
  const net = Number(opportunity.netEdgeBps);
  return (
    <aside className="panel detail-panel" aria-label="Selected opportunity detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Selected result</p>
          <h2>{opportunity.underlyingId.split(":").at(-1)} · {opportunity.strategy.replaceAll("_", " ")}</h2>
          <p className="hash">{opportunity.opportunityId}</p>
        </div>
        <span className={`status ${stale ? "warn" : "ok"}`}>{stale ? "Stale input" : "Current"}</span>
      </div>
      <p className={`callout ${stale ? "warn" : "neutral"}`}>{warning}</p>
      <section aria-labelledby="economics-heading">
        <div className="sub-head"><h3 id="economics-heading">Economics</h3><span>{formatAge(opportunity.freshness.oldestInputMs)}</span></div>
        <dl className="metric-grid">
          <div><dt>Gross edge</dt><dd title={`${opportunity.grossSpreadBps} bps`}>{bps(opportunity.grossSpreadBps)}</dd></div>
          <div><dt>Funding</dt><dd title={`${opportunity.expectedFundingBps} bps`}>{bps(opportunity.expectedFundingBps)}</dd></div>
          <div><dt>Fees</dt><dd title={`${opportunity.tradingFeesBps} bps`}>{cost(opportunity.tradingFeesBps)}</dd></div>
          <div><dt>Slippage</dt><dd title={`${opportunity.slippageBps} bps`}>{cost(opportunity.slippageBps)}</dd></div>
          <div><dt>Financing</dt><dd title={`${opportunity.financingBps} bps`}>{cost(opportunity.financingBps)}</dd></div>
          <div><dt>Gas / transfer</dt><dd title={`${opportunity.gasAndTransferBps} bps`}>{cost(opportunity.gasAndTransferBps)}</dd></div>
          <div><dt>FX conversion</dt><dd title={`${opportunity.fxConversionBps} bps`}>{cost(opportunity.fxConversionBps)}</dd></div>
          <div><dt>Uncertainty</dt><dd title={`${opportunity.uncertaintyBufferBps} bps`}>{cost(opportunity.uncertaintyBufferBps)}</dd></div>
          <div className={`metric-emphasis ${net >= 0 ? "positive" : "negative"}`}><dt>Net edge</dt><dd title={`${opportunity.netEdgeBps} bps`}>{bps(opportunity.netEdgeBps)}</dd></div>
          <div><dt>Capacity</dt><dd>{money(opportunity.capacityUsd)}</dd></div>
          <div><dt>Expires</dt><dd title={opportunity.expiresAt}>{formatUtcClock(Date.parse(opportunity.expiresAt))}</dd></div>
        </dl>
      </section>
      <section className="legs" aria-labelledby="legs-heading">
        <div className="sub-head"><h3 id="legs-heading">Executable-depth inputs</h3></div>
        {opportunity.legs.map((leg) => {
          const timestamp = (detail?.result.quote_timestamps ?? quoteTimestamps).find((candidate) => candidate.event_id === leg.executableQuote.sourceBookEventId);
          return <div className="leg" key={leg.legId}>
            <div className="leg-title"><span className={`side side-${leg.side}`}>{leg.side}</span><strong>{leg.instrumentId}</strong></div>
            <dl>
              <div><dt>Average</dt><dd title={leg.executableQuote.averagePrice}>{formatPrice(leg.executableQuote.averagePrice)}</dd></div>
              <div><dt>Worst</dt><dd title={leg.executableQuote.worstPrice}>{formatPrice(leg.executableQuote.worstPrice)}</dd></div>
              <div><dt>Book age</dt><dd>{formatAge(leg.executableQuote.ageMs)}</dd></div>
              <div><dt>Source event</dt><dd className="hash" title={leg.executableQuote.sourceBookEventId}>{shortId(leg.executableQuote.sourceBookEventId)}</dd></div>
              <div className="leg-timestamp"><dt>Source time</dt><dd title={formatTimestamp(timestamp?.source_timestamp_ms)}>{formatUtcClock(timestamp?.source_timestamp_ms)}</dd></div>
              <div className="leg-timestamp"><dt>Received time</dt><dd title={formatTimestamp(timestamp?.received_timestamp_ms)}>{formatUtcClock(timestamp?.received_timestamp_ms)}</dd></div>
            </dl>
          </div>;
        })}
      </section>
      <EvidencePanel opportunity={opportunity} detail={detail} />
      {(opportunity.rejectionReasons.length > 0 || detail?.result.rejection_history.length) ? <section className="rejection-panel" aria-label="Rejection provenance">
        <div className="sub-head"><h3>Rejection provenance</h3></div>
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
