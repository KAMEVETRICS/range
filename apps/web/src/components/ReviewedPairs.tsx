import { useEffect, useMemo, useState } from "react";
import type { DashboardApi, PairEvaluation } from "../api/client.js";
import { pollWhileIdle } from "../api/poll.js";

const VENUE_LABELS: Record<string, string> = { bitget: "Bitget", hyperliquid_hip3: "trade.xyz" };
const STRATEGY_LABELS: Record<string, string> = { perp_spread: "Price spread", funding_differential: "Funding", spot_perp_basis: "Spot–perp basis" };
/** The evaluator's rejection codes, in the words a trader would use, most telling first. */
const REASONS: Array<[string, string]> = [
  ["NET_EDGE_BELOW_THRESHOLD", "below costs"],
  ["INSUFFICIENT_DEPTH", "not enough depth"],
  ["STALE_INPUT", "stale quote"],
  ["FUNDING_SEMANTICS_UNKNOWN", "funding unknown"],
  ["VENUE_DEGRADED", "venue degraded"],
  ["BOOK_SEQUENCE_GAP", "book gap"],
  ["CLOCK_SKEW_EXCEEDED", "clock skew"],
  ["COST_DATA_MISSING", "cost data missing"],
  ["UNKNOWN_INSTRUMENT_EQUIVALENCE", "not reviewed"],
];

const venueLabel = (venue: string) => VENUE_LABELS[venue] ?? venue.replaceAll("_", " ");
const ticker = (underlyingId: string) => underlyingId.replace(/^equity:/, "");

export function describeReasons(codes: readonly string[]): string {
  const known = REASONS.filter(([code]) => codes.includes(code)).map(([, label]) => label);
  const other = codes.filter(code => !REASONS.some(([known]) => known === code)).map(code => code.toLowerCase().replaceAll("_", " "));
  return [...known, ...other].join(", ");
}

/** Each stock and strategy's better direction: the one closer to clearing its costs. */
export function bestDirections(pairs: readonly PairEvaluation[]): PairEvaluation[] {
  const best = new Map<string, PairEvaluation>();
  for (const pair of pairs) {
    const key = `${pair.underlyingId}|${pair.strategy}`;
    const held = best.get(key);
    const rank = (item: PairEvaluation) => (item.status === "actionable" ? 1e9 : 0) + Number(item.netEdgeBps);
    if (!held || rank(pair) > rank(held)) best.set(key, pair);
  }
  return [...best.values()].sort((a, b) => a.underlyingId.localeCompare(b.underlyingId) || a.strategy.localeCompare(b.strategy));
}

const bps = (value: string) => {
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${Number.isInteger(number) ? number : number.toFixed(2)} bps`;
};

function side(label: string, item: PairEvaluation["buy"]) {
  return <span>{label} <strong>{venueLabel(item.venue)}</strong>{item.averagePrice ? ` @ ${Number(item.averagePrice).toFixed(2)}` : ""}</span>;
}

/**
 * Every reviewed pair is evaluated continuously, in both directions and for each strategy. This shows each one's latest
 * result, including why it is not actionable, so an empty scan is never a mystery.
 */
export function ReviewedPairs({ api, onSelectUnderlying, now = () => Date.now() }: {
  api: DashboardApi; onSelectUnderlying?: (underlyingId: string) => void; now?: () => number;
}) {
  const [pairs, setPairs] = useState<PairEvaluation[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const load = () => api.pairEvaluations()
      .then(response => { if (active) { setPairs(response.result.pairs); setError(undefined); } })
      .catch(() => { if (active) setError("Pair evaluations are unavailable."); });
    const stop = pollWhileIdle(load, 5_000);
    return () => { active = false; stop(); };
  }, [api]);
  const rows = useMemo(() => bestDirections(pairs ?? []), [pairs]);
  const actionable = rows.filter(row => row.status === "actionable").length;

  return (
    <section className="reviewed-pairs" aria-labelledby="reviewed-pairs-heading">
      <div className="section-heading">
        <div><p className="eyebrow">Reviewed pairs</p><h2 id="reviewed-pairs-heading">Live evaluations</h2></div>
        <span className="result-count">{actionable} actionable of {rows.length}</span>
      </div>
      <p className="pairs-note">Each approved pair is evaluated on every book update, in both directions, net of fees, slippage, and one hour of funding. The better direction is shown; a row turns green when it clears every cost.</p>
      {error && <div className="error-state" role="alert"><strong>Evaluations unavailable</strong><p>{error}</p></div>}
      {!pairs && !error ? <p className="loading">Loading pair evaluations…</p> : rows.length === 0 && !error
        ? <p className="loading">No reviewed pair has been evaluated yet.</p>
        : (
          <div className="pairs-table-shell">
            <table className="pairs-table">
              <thead><tr><th scope="col">Stock</th><th scope="col">Strategy</th><th scope="col">Trade</th><th scope="col">Net edge</th>
                <th scope="col">Spread</th><th scope="col">Funding</th><th scope="col">Costs</th><th scope="col">Status</th><th scope="col">Checked</th></tr></thead>
              <tbody>
                {rows.map(row => {
                  const ok = row.status === "actionable";
                  return (
                    <tr key={`${row.underlyingId}|${row.strategy}`} className={ok ? "actionable" : undefined}
                      onClick={() => onSelectUnderlying?.(row.underlyingId)}>
                      <th scope="row">{ticker(row.underlyingId)}</th>
                      <td>{STRATEGY_LABELS[row.strategy] ?? row.strategy}</td>
                      <td className="trade">{side("Buy", row.buy)} · {side("sell", row.sell)}</td>
                      <td className={Number(row.netEdgeBps) >= 0 ? "positive" : "negative"}>{bps(row.netEdgeBps)}</td>
                      <td>{bps(row.grossSpreadBps)}</td>
                      <td>{bps(row.expectedFundingBps)}</td>
                      <td>{bps(`-${row.costsBps}`)}</td>
                      <td>{ok ? <span className="badge ok">Actionable</span> : <span className="badge">{describeReasons(row.rejectionReasons) || row.status}</span>}</td>
                      <td>{Math.max(0, Math.round((now() - row.evaluatedAtMs) / 1000))}s ago</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
