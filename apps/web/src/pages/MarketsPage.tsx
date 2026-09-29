import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardApi, MarketCell, MarketFunding, MarketRow } from "../api/client.js";

type View = "funding" | "price";
type Period = "1h" | "8h" | "1d" | "apr";
type Sort = "gap" | "symbol";

const HOUR_MS = 3_600_000;
const COLUMN_ORDER = ["bitget-perp", "bitget-spot", "hyperliquid_hip3-perp", "extended-perp", "ondo_perps-perp"];
const COLUMN_LABELS: Record<string, string> = {
  "bitget-perp": "Bitget perp", "bitget-spot": "Bitget spot", "hyperliquid_hip3-perp": "Hyperliquid",
  "extended-perp": "Extended", "ondo_perps-perp": "Ondo",
};
const PERIODS: Array<{ id: Period; label: string }> = [{ id: "1h", label: "1h" }, { id: "8h", label: "8h" }, { id: "1d", label: "1d" }, { id: "apr", label: "APR" }];
/** Multiplies an 8-hour rate or gap into the chosen period. */
const PERIOD_FROM_8H: Record<Period, number> = { "1h": 1 / 8, "8h": 1, "1d": 3, apr: 3 * 365 };
const PERIOD_DIGITS: Record<Period, number> = { "1h": 4, "8h": 4, "1d": 3, apr: 2 };

const columnKey = (cell: Pick<MarketCell, "venue" | "market">) => `${cell.venue}-${cell.market}`;
const percent = (value: number, digits: number) => `${value.toFixed(digits)}%`;

function fundingIn(funding: MarketFunding, period: Period): number {
  return period === "1h" ? funding.rate_1h_pct : period === "8h" ? funding.rate_8h_pct
    : period === "1d" ? funding.rate_1h_pct * 24 : funding.apr_pct;
}

function formatPrice(value: string): string {
  const number = Number(value);
  const digits = Math.abs(number) >= 100 ? 2 : Math.abs(number) >= 1 ? 3 : 5;
  return number.toFixed(digits);
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))} s`;
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} min`;
  return `${Math.floor(ms / HOUR_MS)} h ${Math.round((ms % HOUR_MS) / 60_000)} min`;
}

function formatInterval(ms: number): string {
  return ms % HOUR_MS === 0 ? `${ms / HOUR_MS} h` : `${Math.round(ms / 60_000)} min`;
}

function CellDetails({ cells, now }: { cells: MarketCell[]; now: number }) {
  return (
    <div className="cell-details" role="tooltip">
      {cells.map((cell) => (
        <dl key={cell.instrument_id}>
          <dt>{cell.venue_symbol}</dt>
          <dd>{cell.mid ? `Bid ${cell.bid} · Ask ${cell.ask} · Mid ${cell.mid}` : "No book yet"}</dd>
          {cell.book_age_ms !== null && <dd>{`Book ${formatAge(cell.book_age_ms)} old${cell.book_live ? "" : " (stale)"}`}</dd>}
          {cell.funding ? <>
            <dd>{`Funding every ${formatInterval(cell.funding.interval_ms)}`}</dd>
            <dd>{`Rate ${percent(Number(cell.funding.rate) * 100, 5)} per interval (${cell.funding.rate_type})`}</dd>
            <dd>{`1h ${percent(cell.funding.rate_1h_pct, 4)} · 8h ${percent(cell.funding.rate_8h_pct, 4)} · 1d ${percent(cell.funding.rate_1h_pct * 24, 3)} · APR ${percent(cell.funding.apr_pct, 2)}`}</dd>
            <dd>{`Next settlement in ${formatAge(Math.max(0, cell.funding.next_settlement_ms - now))}`}</dd>
            <dd>{`Updated ${formatAge(cell.funding.age_ms)} ago${cell.funding.live ? "" : " (stale)"}`}</dd>
            {cell.funding.flags.length > 0 && <dd className="flags">{cell.funding.flags.join(", ").replaceAll("_", " ")}</dd>}
          </> : cell.market === "perp" && <dd>No funding yet</dd>}
        </dl>
      ))}
    </div>
  );
}

function MarketCellView({ row, cells, view, period, now, columnId, label }: { row: MarketRow; cells: MarketCell[]; view: View; period: Period; now: number; columnId: string; label: string }) {
  if (!cells.length) return <td className="market-cell empty" data-testid={`cell-${columnId}`} data-label={label}>—</td>;
  const marked = view === "funding"
    ? [row.lowest_funding_instrument_id, row.highest_funding_instrument_id] : [row.cheapest_instrument_id, row.richest_instrument_id];
  const primary = cells.find((cell) => marked.includes(cell.instrument_id))
    ?? cells.find((cell) => view === "funding" ? cell.funding?.live : cell.book_live) ?? cells[0]!;
  let value = "—";
  if (view === "funding" && primary.funding) value = percent(fundingIn(primary.funding, period), PERIOD_DIGITS[period]);
  if (view === "price" && primary.mid) value = formatPrice(primary.mid);
  const badge = view === "funding"
    ? primary.instrument_id === row.lowest_funding_instrument_id ? "Long" : primary.instrument_id === row.highest_funding_instrument_id ? "Short" : undefined
    : primary.instrument_id === row.cheapest_instrument_id ? "Buy" : primary.instrument_id === row.richest_instrument_id ? "Sell" : undefined;
  const classes = ["market-cell"];
  if (!primary.book_live) classes.push("stale-book");
  if (primary.funding && !primary.funding.live) classes.push("stale-funding");
  if (badge) classes.push(badge === "Long" || badge === "Buy" ? "low-side" : "high-side");
  return (
    <td className={classes.join(" ")} data-testid={`cell-${columnId}`} data-label={label} tabIndex={0}>
      <span className="value">{value}</span>
      {badge && <span className="side-badge">{badge}</span>}
      {cells.length > 1 && <span className="more">{`+${cells.length - 1}`}</span>}
      <CellDetails cells={cells} now={now} />
    </td>
  );
}

export function MarketsPage({ api, now = Date.now, refreshMs = 5_000 }: { api: DashboardApi; now?: () => number; refreshMs?: number }) {
  const [rows, setRows] = useState<MarketRow[]>();
  const [boardAsOfMs, setBoardAsOfMs] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("funding");
  const [period, setPeriod] = useState<Period>("8h");
  const [sort, setSort] = useState<Sort>("gap");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await api.marketOverview();
      setRows(response.result.rows);
      setBoardAsOfMs(response.result.board_as_of_ms);
      setWarnings(response.warnings);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "REQUEST_FAILED");
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  const columns = useMemo(() => {
    const present = new Set((rows ?? []).flatMap((row) => row.cells.map(columnKey)));
    return [...COLUMN_ORDER.filter((key) => present.has(key)), ...[...present].filter((key) => !COLUMN_ORDER.includes(key)).sort()];
  }, [rows]);

  const gapOf = useCallback((row: MarketRow) => view === "funding"
    ? row.funding_gap_8h_pct === null ? null : row.funding_gap_8h_pct * PERIOD_FROM_8H[period]
    : row.price_gap_pct, [period, view]);

  const visible = useMemo(() => {
    const query = search.trim().toUpperCase();
    const filtered = (rows ?? []).filter((row) => !query || row.ticker.includes(query));
    return [...filtered].sort((a, b) => {
      if (sort === "symbol") return a.ticker.localeCompare(b.ticker);
      const gapA = gapOf(a), gapB = gapOf(b);
      if (gapA === null || gapB === null) return gapA === gapB ? a.ticker.localeCompare(b.ticker) : gapA === null ? 1 : -1;
      return gapB - gapA || a.ticker.localeCompare(b.ticker);
    });
  }, [gapOf, rows, search, sort]);

  const nowMs = now();
  return (
    <main className={`markets view-${view}`}>
      <header className="app-header">
        <a className="brand" href="#markets" aria-label="Range markets"><span className="brand-mark">R</span><span>Range</span></a>
        <div><p className="eyebrow">Cross-venue stock perpetuals</p><h1>Markets</h1></div>
        <div className="live-state"><span aria-hidden="true" />
          <p aria-live="polite">{boardAsOfMs === null ? "Waiting for market data…" : `Updated ${formatAge(nowMs - boardAsOfMs)} ago · refreshes every ${refreshMs / 1_000} s`}</p>
        </div>
      </header>

      <p className="disclaimer"><strong>Reference only.</strong> Prices and funding for stocks that trade on two or more venues, matched by ticker, not reviewed: contract terms can differ between venues. Range does not trade, and this is not investment advice.</p>

      <section className="results-panel markets-panel" aria-labelledby="markets-heading">
        <div className="section-heading">
          <div><p className="eyebrow">{view === "funding" ? "Funding arbitrage" : "Price gaps"}</p><h2 id="markets-heading">{visible.length} stocks on 2+ venues</h2></div>
          <p className="coverage-note">{view === "funding"
            ? "Long where funding is lowest, short where it is highest; the gap is highest minus lowest for the period."
            : "Buy the cheapest mid price, sell the richest; the gap is richest over cheapest."}</p>
        </div>
        <div className="market-controls">
          <label className="market-search"><span className="visually-hidden">Search symbol</span>
            <input type="search" aria-label="Search symbol" placeholder="Search symbol…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="segmented" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "funding"} onClick={() => setView("funding")}>Funding</button>
            <button type="button" aria-pressed={view === "price"} onClick={() => setView("price")}>Price</button>
          </div>
          {view === "funding" && <div className="segmented" role="group" aria-label="Funding period">
            {PERIODS.map((item) => <button key={item.id} type="button" aria-pressed={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>)}
          </div>}
        </div>
        {warnings.length > 0 && <div className="inline-warning" role="status"><strong>Partial data</strong><p>{warnings.join(" · ")}</p></div>}
        {error && <div className="error-state" role="alert"><strong>Refresh failed</strong><p>{`${error}. Showing the last data received.`}</p></div>}
        {rows === undefined ? <p className="loading">Loading markets…</p> : (
          <div className="table-shell">
            <table className="markets-table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={sort === "symbol" ? "ascending" : "none"}>
                    <button type="button" className="sort-button" onClick={() => setSort("symbol")}>Symbol</button>
                  </th>
                  <th scope="col" className="numeric" aria-sort={sort === "gap" ? "descending" : "none"}>
                    <button type="button" className="sort-button" onClick={() => setSort("gap")}>{view === "funding" ? "Max funding gap" : "Max price gap"}</button>
                  </th>
                  {columns.map((key) => <th scope="col" key={key} className="numeric">{COLUMN_LABELS[key] ?? key.replace("-", " ")}</th>)}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const gap = gapOf(row);
                  return (
                    <tr key={row.ticker}>
                      <th scope="row" className="ticker">{row.ticker}</th>
                      <td className="numeric gap" data-label={view === "funding" ? "Max funding gap" : "Max price gap"}>{gap === null ? "—" : view === "funding" ? percent(gap, PERIOD_DIGITS[period]) : percent(gap, 3)}</td>
                      {columns.map((key) => <MarketCellView key={key} columnId={key} label={COLUMN_LABELS[key] ?? key.replace("-", " ")} row={row} view={view} period={period} now={nowMs}
                        cells={row.cells.filter((cell) => columnKey(cell) === key)} />)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
