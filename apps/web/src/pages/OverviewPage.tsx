import { useEffect, useMemo, useState } from "react";
import type { DashboardApi, PairEvaluation, VenueView } from "../api/client.js";
import { pollWhileIdle } from "../api/poll.js";
import { PairTable, STRATEGY_LABELS, bestPerStock, formatBps, pairVenueLabel, tickerOf, usePairEvaluations } from "../components/ReviewedPairs.js";
import { HEALTH_TONE, VenueIcon, healthLabel, venueInfo, type VenueRole } from "../venues.js";

const ROLE_LABELS: Record<VenueRole, string> = { executable: "Reviewed pairs", reference: "Reference data", board: "Markets board" };

const STEPS = [
  { title: "Ingest", body: "Public order books, funding and health from twelve venues, each stamped with its source and receive time." },
  { title: "Match", body: "Reviewed mappings join one stock across venues. Unreviewed listings appear on Markets but are never priced as trades." },
  { title: "Price", body: "Walk both order books at $2,500, then net out taker fees, slippage buffers and an hour of projected funding." },
  { title: "Prove", body: "Each result carries its evidence and expires within seconds. Agents read it over REST, SSE or MCP; Range never trades." },
];

function median(values: readonly number[]): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const ageText = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1_000))} s` : `${Math.round(ms / 60_000)} min`;

/** The landing page: what Range does, how close each reviewed pair is to actionable, and whether every venue is live. */
export function OverviewPage({ api, now = Date.now }: { api: DashboardApi; now?: () => number }) {
  const { pairs, asOfMs, error } = usePairEvaluations(api);
  const [venues, setVenues] = useState<VenueView[]>();
  useEffect(() => {
    let active = true;
    // Venue health counts against the gateway's general budget of 60 calls a minute, shared by every visitor.
    const stop = pollWhileIdle(() => api.listVenues().then(response => { if (active) setVenues(response.result.items); }), 60_000);
    return () => { active = false; stop(); };
  }, [api]);

  const rows = useMemo(() => bestPerStock(pairs ?? []), [pairs]);
  const actionable = rows.filter(row => row.status === "actionable").length;
  const best: PairEvaluation | undefined = rows[0];
  const costs = median(rows.map(row => Number(row.costsBps)));
  const healthy = venues?.filter(venue => healthLabel(venue) === "Healthy").length;
  const open = (underlyingId: string) => { window.location.hash = `#opportunities/${underlyingId}`; };
  const nowMs = now();

  return (
    <main className="page overview">
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="eyebrow">Tokenized-stock perpetuals · Bitget × trade.xyz</p>
          <h1 id="hero-heading">Cross-venue stock arbitrage, <em>priced against real depth.</em></h1>
          <p>Range evaluates ten stock pairs on Bitget and trade.xyz on every order-book update, in both directions. It walks both books, nets out fees, slippage and funding, and keeps the evidence behind every result. Read-only: no keys, no orders.</p>
          <div className="hero-actions">
            <a className="button primary" href="#opportunities">Open the scanner</a>
            <a className="button" href="#markets">Compare markets</a>
          </div>
        </div>
        <dl className="kpis" aria-label="Live summary">
          <div className="kpi">
            <dt>Actionable now</dt>
            <dd className={actionable ? "positive" : undefined}>{pairs ? `${actionable}/${rows.length}` : "–"}</dd>
            <p>stocks with a trade clearing every cost</p>
          </div>
          <div className="kpi">
            <dt>Closest to actionable</dt>
            <dd className={best ? Number(best.netEdgeBps) >= 0 ? "positive" : "negative" : undefined}>{best ? formatBps(best.netEdgeBps) : "–"}</dd>
            <p>{best ? `${tickerOf(best.underlyingId)} · ${STRATEGY_LABELS[best.strategy] ?? best.strategy} · buy ${pairVenueLabel(best.buy.venue)}` : "waiting for evaluations"}</p>
          </div>
          <div className="kpi">
            <dt>Costs to clear</dt>
            <dd>{costs === undefined ? "–" : `${costs.toFixed(1)} bps`}</dd>
            <p>median fees and slippage per trade</p>
          </div>
          <div className="kpi">
            <dt>Venues healthy</dt>
            <dd>{venues ? `${healthy}/${venues.length}` : "–"}</dd>
            <p>connected, in sequence, within rate limits</p>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="board-heading">
        <div className="panel-head">
          <div><p className="eyebrow">Live board</p><h2 id="board-heading">Reviewed pairs</h2></div>
          <span className="count">{asOfMs ? `Updated ${ageText(nowMs - asOfMs)} ago` : ""}</span>
        </div>
        <p className="panel-note">Each stock's best trade across both strategies and directions, closest to actionable first. Pick one to open it in the scanner.</p>
        {error && <div className="notice bad" role="alert"><strong>Evaluations unavailable</strong> {error}</div>}
        {!pairs && !error ? <p className="loading">Loading pair evaluations…</p> : rows.length === 0 && !error
          ? <p className="loading">No reviewed pair has been evaluated yet.</p>
          : <PairTable rows={rows} now={now} onSelectUnderlying={open} />}
      </section>

      <section className="steps-section" aria-labelledby="steps-heading">
        <div className="section-head"><p className="eyebrow">Method</p><h2 id="steps-heading">How Range decides</h2></div>
        <ol className="steps">
          {STEPS.map((step, index) => (
            <li className="step" key={step.title}>
              <span className="step-num">{String(index + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="venues-heading">
        <div className="section-head"><p className="eyebrow">Coverage</p><h2 id="venues-heading">Venues</h2></div>
        {!venues ? <p className="loading">Loading venue health…</p> : (
          <ul className="venue-grid">
            {venues.map(venue => {
              const label = healthLabel(venue);
              const info = venueInfo(venue.venue);
              return (
                <li className="venue-card" key={venue.venue}>
                  <VenueIcon venue={venue.venue} />
                  <div><strong>{info.label}</strong><span>{ROLE_LABELS[info.role]}</span></div>
                  <span className={`status ${HEALTH_TONE[label]}`}>{label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="page-foot">
        <p><strong>Intelligence, not guaranteed profit.</strong> Range reads public market data only. It holds no keys, signs nothing and submits no orders: at most it hands an operator an unsigned, expiring intent.</p>
      </footer>
    </main>
  );
}
