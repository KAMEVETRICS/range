import type { Opportunity } from "../api/client.js";

export function formatAge(ageMs: number) {
  return ageMs < 1000 ? `${ageMs} ms old` : `${(ageMs / 1000).toFixed(1)} s old`;
}

const strategyLabel = (strategy: string) => strategy.replaceAll("_", " ");

export function OpportunityTable({ opportunities, selectedId, invalidatedIds, onSelect }: {
  opportunities: Opportunity[];
  selectedId?: string;
  invalidatedIds: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  if (!opportunities.length) return <div className="empty-state"><strong>No current results</strong><p>Adjust the filters or wait for synchronized source coverage.</p></div>;
  return (
    <div className="table-shell">
      <table>
        <caption className="sr-only">Current opportunity intelligence</caption>
        <thead><tr><th>Underlying</th><th>Strategy</th><th className="numeric">Gross</th><th className="numeric">Costs</th><th className="numeric">Net edge</th><th className="numeric">Capacity</th><th>Freshness</th></tr></thead>
        <tbody>
          {opportunities.map((item) => {
            const invalidated = invalidatedIds.has(item.opportunityId);
            const stale = invalidated || item.freshness.eligibility !== "live" || !item.freshness.synchronized || item.status !== "actionable";
            return (
              <tr key={item.opportunityId} className={`${selectedId === item.opportunityId ? "selected" : ""} ${stale ? "non-actionable" : ""}`} onClick={() => onSelect(item.opportunityId)}>
                <td data-label="Underlying"><button className="row-select" type="button" onClick={() => onSelect(item.opportunityId)}>{item.underlyingId.split(":").at(-1)}</button></td>
                <td data-label="Strategy">{strategyLabel(item.strategy)}</td>
                <td data-label="Gross" className="numeric">{item.grossSpreadBps} bps</td>
                <td data-label="Costs" className="numeric costs">Fees {item.tradingFeesBps} · slip {item.slippageBps} bps</td>
                <td data-label="Net edge" className="numeric net-value">{item.netEdgeBps} bps</td>
                <td data-label="Capacity" className="numeric">${Number(item.capacityUsd).toLocaleString("en-US")}</td>
                <td data-label="Freshness"><span className={`freshness ${stale ? "stale" : "live"}`}>{stale ? "Stale input" : "Live"}</span><small>{formatAge(item.freshness.oldestInputMs)}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
