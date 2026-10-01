import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardApi, MarketCell, MarketFunding, MarketRow } from "../api/client.js";
import { pollWhileIdle } from "../api/poll.js";

type View = "funding" | "price";
type Period = "1h" | "8h" | "1d" | "apr";

/** Bitget is the primary venue: every other venue is shown next to its spread against Bitget. */
const PRIMARY = "bitget";
const HOUR_MS = 3_600_000;
const VENUE_ORDER = ["binance", "hyperliquid_hip3", "bybit", "lighter", "qfex", "aster", "pacifica", "nado", "extended", "variational", "ondo_perps"];
const VENUES: Record<string, { label: string; mono: string }> = {
  bitget: { label: "Bitget", mono: "BG" }, binance: { label: "Binance", mono: "BN" }, hyperliquid_hip3: { label: "Hyperliquid", mono: "HL" }, extended: { label: "Extended", mono: "EX" },
  ondo_perps: { label: "Ondo", mono: "ON" }, bybit: { label: "Bybit", mono: "BY" }, aster: { label: "Aster", mono: "AS" },
  lighter: { label: "Lighter", mono: "LI" }, qfex: { label: "QFEX", mono: "QF" }, nado: { label: "Nado", mono: "NA" }, pacifica: { label: "Pacifica", mono: "PA" }, variational: { label: "Variational", mono: "VA" },
};
const PERIODS: Array<{ id: Period; label: string }> = [{ id: "1h", label: "1H" }, { id: "8h", label: "8H" }, { id: "1d", label: "1D" }, { id: "apr", label: "APR" }];

const venueInfo = (venue: string) => VENUES[venue] ?? { label: venue.replaceAll("_", " "), mono: venue.slice(0, 2).toUpperCase() };

/** A percentage with about four significant digits and no trailing zeros, as funding tables show them. */
export function formatPercent(value: number): string {
  if (value === 0) return "0%";
  const decimals = Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(Math.abs(value)))));
  const text = value.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${text}%`;
}

function formatPrice(value: number): string {
  const abs = Math.abs(value);
  return value.toFixed(abs >= 100 ? 2 : abs >= 1 ? 3 : 5);
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))} s`;
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} min`;
  return `${Math.floor(ms / HOUR_MS)} h ${Math.round((ms % HOUR_MS) / 60_000)} min`;
}

const formatInterval = (ms: number) => ms % HOUR_MS === 0 ? `${ms / HOUR_MS} h` : `${Math.round(ms / 60_000)} min`;

function fundingIn(funding: MarketFunding, period: Period): number {
  return period === "1h" ? funding.rate_1h_pct : period === "8h" ? funding.rate_8h_pct
    : period === "1d" ? funding.rate_1h_pct * 24 : funding.apr_pct;
}

const isLive = (cell: MarketCell, view: View) => view === "funding" ? cell.funding?.live === true : cell.book_live;

/** The market a column shows: perpetuals first (only they fund), then spot for prices; live data before stale. */
function pick(cells: readonly MarketCell[], view: View): MarketCell | undefined {
  const perps = cells.filter((cell) => cell.market === "perp");
  const pool = view === "funding" ? perps : [...perps, ...cells.filter((cell) => cell.market !== "perp")];
  return pool.find((cell) => isLive(cell, view)) ?? pool[0];
}

function valueOf(cell: MarketCell | undefined, view: View, period: Period): number | undefined {
  if (!cell) return undefined;
  if (view === "funding") return cell.funding ? fundingIn(cell.funding, period) : undefined;
  return cell.mid === null ? undefined : Number(cell.mid);
}

interface Column { venue: string; cells: MarketCell[]; shown?: MarketCell; value?: number; live: boolean; spread?: number }
interface TableRow { ticker: string; primary: Column; others: Map<string, Column>; bestSpread?: number }

function buildRow(row: MarketRow, venues: readonly string[], view: View, period: Period): TableRow {
  const column = (venue: string): Column => {
    const cells = row.cells.filter((cell) => cell.venue === venue);
    const shown = pick(cells, view);
    return { venue, cells, shown, value: valueOf(shown, view, period), live: shown ? isLive(shown, view) : false };
  };
  const primary = column(PRIMARY);
  const others = new Map(venues.map((venue) => {
    const other = column(venue);
    // Spreads use live values only: Bitget minus the venue (funding), or Bitget's premium over the venue (price).
    if (primary.live && other.live && primary.value !== undefined && other.value !== undefined) {
      other.spread = view === "funding" ? primary.value - other.value : (primary.value / other.value - 1) * 100;
    }
    return [venue, other] as const;
  }));
  const spreads = [...others.values()].flatMap((item) => item.spread === undefined ? [] : [Math.abs(item.spread)]);
  return { ticker: row.ticker, primary, others, ...(spreads.length ? { bestSpread: Math.max(...spreads) } : {}) };
}

function tickerColor(ticker: string): string {
  let hash = 0;
  for (const char of ticker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 42%)`;
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
            <dd>{`Rate ${formatPercent(Number(cell.funding.rate) * 100)} per interval (${cell.funding.rate_type})`}</dd>
            <dd>{`1H ${formatPercent(cell.funding.rate_1h_pct)} · 8H ${formatPercent(cell.funding.rate_8h_pct)} · 1D ${formatPercent(cell.funding.rate_1h_pct * 24)} · APR ${formatPercent(cell.funding.apr_pct)}`}</dd>
            <dd>{`Next settlement in ${formatAge(Math.max(0, cell.funding.next_settlement_ms - now))}`}</dd>
            <dd>{`Updated ${formatAge(cell.funding.age_ms)} ago${cell.funding.live ? "" : " (stale)"}`}</dd>
            {cell.funding.flags.length > 0 && <dd className="flags">{cell.funding.flags.join(", ").replaceAll("_", " ")}</dd>}
          </> : cell.market === "perp" && <dd>No funding yet</dd>}
        </dl>
      ))}
    </div>
  );
}

function ValueCell({ column, view, now, testId }: { column: Column; view: View; now: number; testId: string }) {
  if (column.value === undefined) return <td className="value-cell missing" data-testid={testId}>-</td>;
  const text = view === "funding" ? formatPercent(column.value) : formatPrice(column.value);
  const sign = view === "funding" ? (column.value > 0 ? "positive" : column.value < 0 ? "negative" : "zero") : "neutral";
  return (
    <td className={`value-cell ${sign}${column.live ? "" : " stale"}`} data-testid={testId} tabIndex={0}>
      <span className="value">{text}</span>
      {column.cells.length > 1 && <span className="more">{`+${column.cells.length - 1}`}</span>}
      <CellDetails cells={column.cells} now={now} />
    </td>
  );
}

function SpreadCell({ spread, testId }: { spread?: number; testId: string }) {
  if (spread === undefined) return <td className="spread-cell missing" data-testid={testId}>-</td>;
  const sign = spread > 0 ? "positive" : spread < 0 ? "negative" : "zero";
  return <td className={`spread-cell ${sign}`} data-testid={testId}>{formatPercent(spread)}</td>;
}

const VenueIcon = ({ venue }: { venue: string }) => <span className="venue-icon" data-venue={venue} data-mono={venueInfo(venue).mono} aria-hidden="true" />;

export function MarketsPage({ api, now = Date.now, refreshMs = 5_000 }: { api: DashboardApi; now?: () => number; refreshMs?: number }) {
  const [rows, setRows] = useState<MarketRow[]>();
  const [boardAsOfMs, setBoardAsOfMs] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("funding");
  const [period, setPeriod] = useState<Period>("1h");
  const [sort, setSort] = useState("spread");
  const [search, setSearch] = useState("");
  const [arbOnly, setArbOnly] = useState(false);

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

  useEffect(() => pollWhileIdle(load, refreshMs), [load, refreshMs]);

  const venues = useMemo(() => {
    const present = new Set((rows ?? []).flatMap((row) => row.cells.map((cell) => cell.venue)));
    present.delete(PRIMARY);
    return [...VENUE_ORDER.filter((venue) => present.has(venue)), ...[...present].filter((venue) => !VENUE_ORDER.includes(venue)).sort()];
  }, [rows]);

  const table = useMemo(() => {
    const query = search.trim().toUpperCase();
    const built = (rows ?? []).filter((row) => !query || row.ticker.includes(query))
      .map((row) => buildRow(row, venues, view, period))
      .filter((row) => !arbOnly || row.bestSpread !== undefined);
    const key = (row: TableRow): number | undefined => sort === "spread" ? row.bestSpread
      : sort === `venue:${PRIMARY}` ? row.primary.value
      : sort.startsWith("venue:") ? row.others.get(sort.slice(6))?.value
      : sort.startsWith("spread:") ? row.others.get(sort.slice(7))?.spread : undefined;
    return built.sort((a, b) => {
      if (sort === "market") return a.ticker.localeCompare(b.ticker);
      const ka = key(a), kb = key(b);
      if (ka === undefined || kb === undefined) return ka === kb ? a.ticker.localeCompare(b.ticker) : ka === undefined ? 1 : -1;
      return kb - ka || a.ticker.localeCompare(b.ticker);
    });
  }, [arbOnly, period, rows, search, sort, venues, view]);

  const header = (id: string, label: string, icons: string[], className = "") => (
    <th scope="col" key={id} className={className} aria-sort={sort === id ? (id === "market" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-button" onClick={() => setSort(id)}>
        {icons.length > 0 && <span className="icons">{icons.map((venue) => <VenueIcon key={venue} venue={venue} />)}</span>}
        <span className="label">{label}</span>
      </button>
    </th>
  );

  const nowMs = now();
  return (
    <main className="markets">
      <header className="markets-header">
        <div>
          <h1>Markets</h1>
          <p>{view === "funding" ? "Funding rate comparisons across venues, with Bitget as the primary venue." : "Price comparisons across venues, with Bitget as the primary venue."}</p>
        </div>
        <div className="markets-toolbar">
          <label className="search"><span className="visually-hidden">Search</span>
            <input type="search" aria-label="Search" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="button" role="switch" aria-checked={arbOnly} aria-label="Arb only" className="arb-switch" onClick={() => setArbOnly(!arbOnly)}>
            <span aria-hidden="true">Arb only</span><span className="track" aria-hidden="true"><span className="thumb" /></span>
          </button>
          <div className="segmented" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "funding"} onClick={() => setView("funding")}>Funding</button>
            <button type="button" aria-pressed={view === "price"} onClick={() => setView("price")}>Price</button>
          </div>
          {view === "funding" && <div className="segmented" role="group" aria-label="Funding period">
            {PERIODS.map((item) => <button key={item.id} type="button" aria-pressed={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>)}
          </div>}
        </div>
      </header>

      <p className="markets-note">
        <span className="live-dot" aria-hidden="true" />
        {boardAsOfMs === null ? "Waiting for market data… " : `Updated ${formatAge(nowMs - boardAsOfMs)} ago. `}
        Matched by ticker, not reviewed: contract terms can differ between venues. Reference only; Range does not trade.
        {view === "funding" ? " Spread = Bitget minus the venue for the period." : " Spread = Bitget's premium over the venue."}
      </p>
      {warnings.length > 0 && <div className="markets-warning" role="status">{warnings.join(" · ")}</div>}
      {error && <div className="markets-error" role="alert"><strong>Refresh failed</strong>{` (${error}). Showing the last data received.`}</div>}

      {rows === undefined ? <p className="markets-loading">Loading markets…</p> : (
        <div className="markets-table-shell">
          <table className="markets-table">
            <thead>
              <tr>
                {header("market", "Market", [], "market-col")}
                {header(`venue:${PRIMARY}`, venueInfo(PRIMARY).label, [PRIMARY], "primary-col")}
                {venues.flatMap((venue) => [
                  header(`venue:${venue}`, venueInfo(venue).label, [venue]),
                  header(`spread:${venue}`, `${venueInfo(PRIMARY).label} / ${venueInfo(venue).label}`, [PRIMARY, venue], "spread-col"),
                ])}
              </tr>
            </thead>
            <tbody>
              {table.map((row) => (
                <tr key={row.ticker}>
                  <th scope="row" className="market-col" aria-label={row.ticker}>
                    <span className="ticker-badge" style={{ background: tickerColor(row.ticker) }} data-initial={row.ticker[0]} aria-hidden="true" />
                    <span className="ticker-name">{row.ticker}</span>
                  </th>
                  <ValueCell column={row.primary} view={view} now={nowMs} testId={`cell-${PRIMARY}`} />
                  {venues.flatMap((venue) => {
                    const column = row.others.get(venue)!;
                    return [<ValueCell key={venue} column={column} view={view} now={nowMs} testId={`cell-${venue}`} />,
                      <SpreadCell key={`${venue}-spread`} spread={column.spread} testId={`cell-spread-${venue}`} />];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {table.length === 0 && <p className="markets-empty">No markets match.</p>}
        </div>
      )}
    </main>
  );
}
