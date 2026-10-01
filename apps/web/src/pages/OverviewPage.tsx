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

const Icon = ({ path }: { path: string }) => <svg viewBox="0 0 24 24"><path d={path} /></svg>;
const ICONS = {
  actionable: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM8.5 12.2l2.4 2.4 4.6-5",
  closest: "M4 16.5 9.5 11l3.5 3.5L20 7.5M14.5 7.5H20V13",
  costs: "M6 3.5h12v17l-3-2-3 2-3-2-3 2ZM9 8.5h6M9 12h6",
  venues: "M3 12h4l2.5-6 5 12 2.5-6h4",
  depth: "M5 18v-6M9.5 18V8M14 18v-6M18.5 18V5",
};

/** One live figure: a large value with a small unit, and optionally a row of capsules, one per item, filled when it counts. */
function Kpi({ label, icon, value, unit, tone, note, capsules, highlight = false }: {
  label: string; icon: string; value: string; unit?: string; tone?: "positive" | "negative"; note: string;
  capsules?: { filled: number; total: number }; highlight?: boolean;
}) {
  return (
    <div className={`kpi${highlight ? " highlight" : ""}`}>
      <dt><span className="kpi-icon" aria-hidden="true"><Icon path={icon} /></span>{label}</dt>
      <dd className={`kpi-value${tone ? ` ${tone}` : ""}`}>{value}{unit && <span className="kpi-unit">{unit}</span>}</dd>
      <dd className="kpi-note">{note}</dd>
      {capsules && capsules.total > 0 && (
        <dd className="capsules" aria-hidden="true">
          {Array.from({ length: capsules.total }, (_, index) => <span key={index} className={index < capsules.filled ? "on" : undefined} />)}
        </dd>
      )}
    </div>
  );
}

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
          <h1 id="hero-heading">
            Cross-venue{" "}
            <span className="chip-inline" aria-hidden="true"><VenueIcon venue="bitget" /><VenueIcon venue="hyperliquid_hip3" /></span>
            stock arbitrage, priced against{" "}
            <span className="chip-inline lime" aria-hidden="true"><Icon path={ICONS.depth} /></span>
            real depth.
          </h1>
          <p>Range evaluates ten stock pairs on Bitget and trade.xyz on every order-book update, in both directions. It walks both books, nets out fees, slippage and funding, and keeps the evidence behind every result. Read-only: no keys, no orders.</p>
          <div className="hero-actions">
            <a className="button primary" href="#opportunities">Open the scanner</a>
            <a className="button" href="#markets">Compare markets</a>
          </div>
        </div>
        <dl className="kpis" aria-label="Live summary">
          <Kpi label="Actionable now" icon={ICONS.actionable} value={pairs ? String(actionable) : "–"}
            {...(pairs ? { unit: `/${rows.length}`, capsules: { filled: actionable, total: rows.length } } : {})}
            {...(actionable ? { tone: "positive" as const } : {})} note="stocks with a trade clearing every cost" />
          <Kpi label="Closest to actionable" icon={ICONS.closest} highlight value={best ? formatBps(best.netEdgeBps).replace(/ bps$/, "").replace(/^-/, "−") : "–"}
            {...(best ? { unit: " bps", tone: Number(best.netEdgeBps) >= 0 ? "positive" as const : "negative" as const } : {})}
            note={best ? `${tickerOf(best.underlyingId)} · ${STRATEGY_LABELS[best.strategy] ?? best.strategy} · buy ${pairVenueLabel(best.buy.venue)}` : "waiting for evaluations"} />
          <Kpi label="Costs to clear" icon={ICONS.costs} value={costs === undefined ? "–" : costs.toFixed(1)}
            {...(costs === undefined ? {} : { unit: " bps" })} note="median fees and slippage per trade" />
          <Kpi label="Venues healthy" icon={ICONS.venues} value={venues ? String(healthy) : "–"}
            {...(venues ? { unit: `/${venues.length}`, capsules: { filled: healthy ?? 0, total: venues.length } } : {})}
            note="connected, in sequence, within rate limits" />
        </dl>
      </section>

      <section className="panel" aria-labelledby="board-heading">
        <div className="panel-head">
          <div><p className="eyebrow">Live board</p><h2 id="board-heading">Reviewed pairs</h2></div>
          <span className="count">{asOfMs ? `Updated ${ageText(nowMs - asOfMs)} ago` : ""}</span>
        </div>
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
