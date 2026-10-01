import { useEffect, useMemo, useState } from "react";
import type { DashboardApi, PairEvaluation } from "../api/client.js";
import { pollWhileIdle } from "../api/poll.js";
import { EdgeMeter } from "./EdgeMeter.js";

const VENUE_LABELS: Record<string, string> = { bitget: "Bitget", hyperliquid_hip3: "trade.xyz" };
export const STRATEGY_LABELS: Record<string, string> = { perp_spread: "Price spread", funding_differential: "Funding", spot_perp_basis: "Spot–perp basis" };
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

export const pairVenueLabel = (venue: string) => VENUE_LABELS[venue] ?? venue.replaceAll("_", " ");
export const tickerOf = (underlyingId: string) => underlyingId.replace(/^equity:/, "");

export function describeReasons(codes: readonly string[]): string {
  const known = REASONS.filter(([code]) => codes.includes(code)).map(([, label]) => label);
  const other = codes.filter(code => !REASONS.some(([known]) => known === code)).map(code => code.toLowerCase().replaceAll("_", " "));
  return [...known, ...other].join(", ");
}

/** Closer to clearing its costs ranks higher; anything actionable ranks above everything that is not. */
const rank = (item: PairEvaluation) => (item.status === "actionable" ? 1e9 : 0) + Number(item.netEdgeBps);

/** Each stock and strategy's better direction: the one closer to clearing its costs. */
export function bestDirections(pairs: readonly PairEvaluation[]): PairEvaluation[] {
  const best = new Map<string, PairEvaluation>();
  for (const pair of pairs) {
    const key = `${pair.underlyingId}|${pair.strategy}`;
    const held = best.get(key);
    if (!held || rank(pair) > rank(held)) best.set(key, pair);
  }
  return [...best.values()].sort((a, b) => a.underlyingId.localeCompare(b.underlyingId) || a.strategy.localeCompare(b.strategy));
}

/**
 * Each stock's best strategy and direction, closest to actionable first. Between two perpetuals both strategies price
 * the same trade, so they often tie; the price spread is kept then.
 */
export function bestPerStock(pairs: readonly PairEvaluation[]): PairEvaluation[] {
  const best = new Map<string, PairEvaluation>();
  for (const pair of pairs) {
    const held = best.get(pair.underlyingId);
    if (!held || rank(pair) > rank(held) || rank(pair) === rank(held) && pair.strategy === "perp_spread") best.set(pair.underlyingId, pair);
  }
  return [...best.values()].sort((a, b) => rank(b) - rank(a) || a.underlyingId.localeCompare(b.underlyingId));
}

export const formatBps = (value: string) => {
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${Number.isInteger(number) ? number : number.toFixed(2)} bps`;
};

/** The reviewed pairs' latest evaluations, refreshed every few seconds while shown; a failed refresh keeps the last. */
export function usePairEvaluations(api: DashboardApi, intervalMs = 5_000) {
  const [state, setState] = useState<{ pairs?: PairEvaluation[]; asOfMs?: number | null; error?: string }>({});
  useEffect(() => {
    let active = true;
    const load = () => api.pairEvaluations()
      .then(response => { if (active) setState({ pairs: response.result.pairs, asOfMs: response.result.as_of_ms }); })
      .catch(() => { if (active) setState(current => ({ ...current, error: "Pair evaluations are unavailable." })); });
    const stop = pollWhileIdle(load, intervalMs);
    return () => { active = false; stop(); };
  }, [api, intervalMs]);
  return state;
}

function side(label: string, item: PairEvaluation["buy"]) {
  return <span>{label} <strong>{pairVenueLabel(item.venue)}</strong>{item.averagePrice ? ` @ ${Number(item.averagePrice).toFixed(2)}` : ""}</span>;
}

/** Each pair and strategy's better direction, with how far its net edge sits from break-even. */
export function PairTable({ rows, now, onSelectUnderlying, compact = false }: {
  rows: readonly PairEvaluation[]; now: () => number; onSelectUnderlying?: (underlyingId: string) => void; compact?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={`data-table pairs-table${compact ? " compact" : ""}`}>
        <thead><tr>
          <th scope="col">Stock</th><th scope="col">Strategy</th><th scope="col">Trade</th>
          <th scope="col" className="num">Net edge</th><th scope="col" className="meter-col"><span className="sr-only">Against break-even</span></th>
          <th scope="col" className="num">Spread</th><th scope="col" className="num">Funding</th><th scope="col" className="num">Costs</th>
          <th scope="col">Status</th><th scope="col" className="num">Checked</th>
        </tr></thead>
        <tbody>
          {rows.map(row => {
            const ok = row.status === "actionable";
            return (
              <tr key={`${row.underlyingId}|${row.strategy}`} className={ok ? "actionable" : undefined}
                onClick={() => onSelectUnderlying?.(row.underlyingId)}>
                <th scope="row" data-label="Stock"><span className="ticker">{tickerOf(row.underlyingId)}</span></th>
                <td data-label="Strategy">{STRATEGY_LABELS[row.strategy] ?? row.strategy}</td>
                <td data-label="Trade" className="trade">{side("Buy", row.buy)} · {side("sell", row.sell)}</td>
                <td data-label="Net edge" className={`num net ${Number(row.netEdgeBps) >= 0 ? "positive" : "negative"}`}>{formatBps(row.netEdgeBps)}</td>
                <td className="meter-col"><EdgeMeter netEdgeBps={row.netEdgeBps} /></td>
                <td data-label="Spread" className="num">{formatBps(row.grossSpreadBps)}</td>
                <td data-label="Funding" className="num">{formatBps(row.expectedFundingBps)}</td>
                <td data-label="Costs" className="num">{formatBps(`-${row.costsBps}`)}</td>
                <td data-label="Status">{ok ? <span className="status ok">Actionable</span>
                  : <span className="status">{describeReasons(row.rejectionReasons) || row.status}</span>}</td>
                <td data-label="Checked" className="num quiet">{Math.max(0, Math.round((now() - row.evaluatedAtMs) / 1000))}s ago</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every reviewed pair is evaluated continuously, in both directions and for each strategy. This shows each one's latest
 * result, including why it is not actionable, so an empty scan is never a mystery.
 */
export function ReviewedPairs({ api, onSelectUnderlying, now = () => Date.now() }: {
  api: DashboardApi; onSelectUnderlying?: (underlyingId: string) => void; now?: () => number;
}) {
  const { pairs, error } = usePairEvaluations(api);
  const rows = useMemo(() => bestDirections(pairs ?? []), [pairs]);
  const actionable = rows.filter(row => row.status === "actionable").length;

  return (
    <section className="panel reviewed-pairs" aria-labelledby="reviewed-pairs-heading">
      <div className="panel-head">
        <div><p className="eyebrow">Reviewed pairs</p><h2 id="reviewed-pairs-heading">Live evaluations</h2></div>
        <span className="count">{actionable} actionable of {rows.length}</span>
      </div>
      <p className="panel-note">Each approved pair is evaluated on every book update, in both directions, net of fees, slippage, and one hour of funding. The better direction is shown; a row turns green when it clears every cost.</p>
      {error && <div className="notice bad" role="alert"><strong>Evaluations unavailable</strong> {error}</div>}
      {!pairs && !error ? <p className="loading">Loading pair evaluations…</p> : rows.length === 0 && !error
        ? <p className="loading">No reviewed pair has been evaluated yet.</p>
        : <PairTable rows={rows} now={now} onSelectUnderlying={onSelectUnderlying} />}
    </section>
  );
}
