import type { Opportunity, QuoteTimestamp } from "../api/client.js";

export function formatAge(ageMs: number) {
  return ageMs < 1000 ? `${ageMs} ms old` : `${(ageMs / 1000).toFixed(1)} s old`;
}

const strategyLabel = (strategy: string) => strategy.replaceAll("_", " ");
export const formatTimestamp = (timestamp?: number) => timestamp === undefined ? "Unavailable" : new Date(timestamp).toISOString();

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
                    const timestamp = quoteTimestamps.find((candidate) => candidate.event_id === leg.executableQuote.sourceBookEventId);
                    return <div className="row-leg" key={leg.legId}>
                      <span className={`side side-${leg.side}`}>{leg.side}</span>
                      <strong>{leg.executableQuote.averagePrice} avg / {leg.executableQuote.worstPrice} worst</strong>
                      <span className="hash">{leg.executableQuote.sourceBookEventId}</span>
                      <small>src {formatTimestamp(timestamp?.source_timestamp_ms)} · recv {formatTimestamp(timestamp?.received_timestamp_ms)}</small>
                    </div>;
                  })}
                  <span className="row-evidence hash">{item.evidenceHash ?? "Evidence hash unavailable"}</span>
                </td>
                <td data-label="Gross" className="num">{item.grossSpreadBps} bps</td>
                <td data-label="Costs" className="num costs">Fees {item.tradingFeesBps} · slip {item.slippageBps} bps</td>
                <td data-label="Net edge" className={`num net ${Number(item.netEdgeBps) >= 0 ? "positive" : "negative"}`}>{item.netEdgeBps} bps</td>
                <td data-label="Capacity" className="num">${Number(item.capacityUsd).toLocaleString("en-US")}</td>
                <td data-label="Freshness" className="freshness-cell"><span className={`status ${stale ? "warn" : "ok"}`}>{stale ? "Stale input" : "Live"}</span><small>{formatAge(item.freshness.oldestInputMs)}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
