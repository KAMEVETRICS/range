import type { Opportunity, QuoteTimestamp } from "../api/client.js";

export function formatAge(ageMs: number) {
  return ageMs < 1000 ? `${ageMs} ms old` : `${(ageMs / 1000).toFixed(1)} s old`;
}

const strategyLabel = (strategy: string) => strategy.replaceAll("_", " ");
export const formatTimestamp = (timestamp?: number) => timestamp === undefined ? "Unavailable" : new Date(timestamp).toISOString();
/** The time of day in UTC, to the millisecond: results live seconds, so the date adds nothing but width. */
export const formatClock = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 23);
export const formatUtcClock = (timestamp?: number) => timestamp === undefined ? "Unavailable" : `${formatClock(timestamp)} UTC`;
/**
 * Values are shown rounded, the exact ones kept in a title: the service returns basis points to a dozen decimals and
 * average fill prices to forty.
 */
export const formatBpsNumber = (value: string) => {
  const number = Number(value);
  return Math.abs(number) < 0.005 ? "0.00" : number.toFixed(2);
};
export const formatPrice = (value: string) => Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** A long event id or hash, shortened to its venue and last eight characters, or to its first fifteen. */
export function shortId(value: string) {
  if (value.length <= 24) return value;
  const venue = /^evt_([a-z0-9]+)_ins_/.exec(value)?.[1];
  return venue ? `${venue}…${value.slice(-8)}` : `${value.slice(0, 15)}…`;
}

export function OpportunityTable({ opportunities, quoteTimestamps, selectedId, invalidatedIds, onSelect }: {
  opportunities: Opportunity[];
  quoteTimestamps: QuoteTimestamp[];
  selectedId?: string;
  invalidatedIds: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  if (!opportunities.length) {
    return (
      <div className="empty-state">
        <strong>No current results</strong>
        <p>Nothing for this stock clears every cost right now. The live evaluations above show how close each pair is; adjust the filters to widen the scan.</p>
      </div>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table scan-table">
        <caption className="sr-only">Current opportunity intelligence</caption>
        <thead><tr><th>Underlying</th><th>Strategy</th><th>Prices / evidence</th><th className="num">Gross</th><th className="num">Costs</th><th className="num">Net edge</th><th className="num">Capacity</th><th>Freshness</th></tr></thead>
        <tbody>
          {opportunities.map((item) => {
            const invalidated = invalidatedIds.has(item.opportunityId);
            const stale = invalidated || item.freshness.eligibility !== "live" || !item.freshness.synchronized || item.status !== "actionable";
            return (
              <tr key={item.opportunityId} className={`${selectedId === item.opportunityId ? "selected" : ""} ${stale ? "non-actionable" : ""}`} onClick={() => onSelect(item.opportunityId)}>
                <td data-label="Underlying"><button className="row-select" type="button" onClick={() => onSelect(item.opportunityId)}>{item.underlyingId.split(":").at(-1)}</button></td>
                <td data-label="Strategy" className="strategy">{strategyLabel(item.strategy)}</td>
                <td data-label="Prices / evidence" className="lineage-cell">
                  {item.legs.map((leg) => {
                    const { averagePrice, worstPrice, sourceBookEventId } = leg.executableQuote;
                    const timestamp = quoteTimestamps.find((candidate) => candidate.event_id === sourceBookEventId);
                    return <div className="row-leg" key={leg.legId}>
                      <span className={`side side-${leg.side}`}>{leg.side}</span>
                      <strong title={`${averagePrice} avg / ${worstPrice} worst`}>{formatPrice(averagePrice)} avg / {formatPrice(worstPrice)} worst</strong>
                      <span className="hash" title={sourceBookEventId}>{shortId(sourceBookEventId)}</span>
                      <small title={`source ${formatTimestamp(timestamp?.source_timestamp_ms)} · received ${formatTimestamp(timestamp?.received_timestamp_ms)}`}>
                        {timestamp ? `src ${formatClock(timestamp.source_timestamp_ms)} · recv ${formatClock(timestamp.received_timestamp_ms)} UTC` : "Source times unavailable"}
                      </small>
                    </div>;
                  })}
                  <span className="row-evidence hash" title={item.evidenceHash}>{item.evidenceHash ? shortId(item.evidenceHash) : "Evidence hash unavailable"}</span>
                </td>
                <td data-label="Gross" className="num" title={`${item.grossSpreadBps} bps`}>{formatBpsNumber(item.grossSpreadBps)} bps</td>
                <td data-label="Costs" className="num costs"><span>Fees {formatBpsNumber(item.tradingFeesBps)} bps</span><span>slip {formatBpsNumber(item.slippageBps)} bps</span></td>
                <td data-label="Net edge" className={`num net ${Number(item.netEdgeBps) >= 0 ? "positive" : "negative"}`} title={`${item.netEdgeBps} bps`}>{formatBpsNumber(item.netEdgeBps)} bps</td>
                <td data-label="Capacity" className="num" title={`$${item.capacityUsd}`}>${Number(item.capacityUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                <td data-label="Freshness" className="freshness-cell"><span className={`status ${stale ? "warn" : "ok"}`}>{stale ? "Stale input" : "Live"}</span><small>{formatAge(item.freshness.oldestInputMs)}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
