import { Decimal } from "decimal.js";
import { z } from "zod";
import type { MarketBoardEntry, MarketBoardSnapshot } from "@range/domain";

/** An older book stays visible but is left out of price gaps; Extended's RFQ books arrive about once a minute. */
const BOOK_LIVE_MS = 60_000;
/** Funding settles hourly or slower and is fetched every one to five minutes. */
const FUNDING_LIVE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

export const MarketOverviewCellSchema = z.object({
  venue: z.string(),
  market: z.enum(["perp", "spot"]),
  instrument_id: z.string(),
  venue_symbol: z.string(),
  bid: z.string().nullable(),
  ask: z.string().nullable(),
  mid: z.string().nullable(),
  book_age_ms: z.number().int().nonnegative().nullable(),
  book_live: z.boolean(),
  funding: z.object({
    rate: z.string(),
    rate_type: z.string(),
    interval_ms: z.number().int().positive(),
    next_settlement_ms: z.number().int().nonnegative(),
    age_ms: z.number().int().nonnegative(),
    live: z.boolean(),
    rate_1h_pct: z.number(),
    rate_8h_pct: z.number(),
    apr_pct: z.number(),
    eligibility: z.string(),
    flags: z.array(z.string()),
  }).strict().nullable(),
}).strict();

export const MarketOverviewRowSchema = z.object({
  ticker: z.string(),
  cells: z.array(MarketOverviewCellSchema),
  price_gap_pct: z.number().nullable(),
  cheapest_instrument_id: z.string().nullable(),
  richest_instrument_id: z.string().nullable(),
  funding_gap_8h_pct: z.number().nullable(),
  lowest_funding_instrument_id: z.string().nullable(),
  highest_funding_instrument_id: z.string().nullable(),
}).strict();

export type MarketOverviewCell = z.infer<typeof MarketOverviewCellSchema>;
export type MarketOverviewRow = z.infer<typeof MarketOverviewRowSchema>;

/**
 * Venue names for a share that differ from its listed ticker: an X suffix where the ticker is also a crypto token's
 * (Variational names BBX "BlackBerry Limited" and STXX "Seagate Technology"; Bybit maps QNTX to QNT), Berkshire
 * without its class dot, and Variational's VISA.
 */
const TICKER_ALIASES: Readonly<Record<string, string>> = { BBX: "BB", STXX: "STX", QNTX: "QNT", "BRK.B": "BRKB", VISA: "V" };

/**
 * The stock ticker a listing tracks: `equity:X` underlyings, and Bitget's venue-local names (`bitget:rX` Reality
 * tokens, `bitget:X` stock perpetuals). A match by ticker is not a reviewed mapping: the overview is display only.
 */
export function displayTicker(entry: Pick<MarketBoardEntry, "venue" | "underlyingId" | "productType">): string | undefined {
  let name: string;
  if (entry.underlyingId.startsWith("equity:")) name = entry.underlyingId.slice("equity:".length);
  else if (entry.venue === "bitget" && entry.underlyingId.startsWith("bitget:")) {
    name = entry.underlyingId.slice("bitget:".length);
    if (entry.productType === "tokenized_spot" && /^r[A-Z]/.test(name)) name = name.slice(1);
  } else return undefined;
  const ticker = name.toUpperCase();
  return TICKER_ALIASES[ticker] ?? (ticker || undefined);
}

function cell(entry: MarketBoardEntry, nowMs: number): MarketOverviewCell {
  const bid = entry.book?.bid?.price ?? null;
  const ask = entry.book?.ask?.price ?? null;
  const mid = bid !== null && ask !== null ? new Decimal(bid).plus(ask).div(2).toString() : null;
  const bookAgeMs = entry.book ? Math.max(0, nowMs - entry.book.sourceTimestamp) : null;
  const funding = entry.funding;
  let fundingCell: MarketOverviewCell["funding"] = null;
  if (funding) {
    const perHour = new Decimal(funding.rate).times(HOUR_MS).div(funding.intervalMs);
    const ageMs = Math.max(0, nowMs - funding.sourceTimestamp);
    fundingCell = {
      rate: funding.rate, rate_type: funding.rateType, interval_ms: funding.intervalMs, next_settlement_ms: funding.nextSettlementMs,
      age_ms: ageMs, live: ageMs <= FUNDING_LIVE_MS,
      rate_1h_pct: perHour.times(100).toNumber(), rate_8h_pct: perHour.times(800).toNumber(),
      apr_pct: perHour.times(24 * 365 * 100).toNumber(),
      eligibility: funding.eligibility, flags: [...funding.qualityFlags],
    };
  }
  return {
    venue: entry.venue, market: entry.productType === "perpetual" ? "perp" : "spot", instrument_id: entry.instrumentId,
    venue_symbol: entry.venueSymbol, bid, ask, mid, book_age_ms: bookAgeMs,
    book_live: mid !== null && bookAgeMs !== null && bookAgeMs <= BOOK_LIVE_MS, funding: fundingCell,
  };
}

function extremes(values: readonly { id: string; value: number }[]) {
  if (values.length < 2) return undefined;
  let low = values[0]!, high = values[0]!;
  for (const item of values) {
    if (item.value < low.value) low = item;
    if (item.value > high.value) high = item;
  }
  return { low, high };
}

/** One row per ticker listed on two or more venues, in ticker order; gaps use live values only. */
export function buildMarketOverview(snapshot: MarketBoardSnapshot, nowMs: number): MarketOverviewRow[] {
  const groups = new Map<string, MarketBoardEntry[]>();
  for (const entry of snapshot.entries) {
    const ticker = displayTicker(entry);
    if (ticker) groups.set(ticker, [...(groups.get(ticker) ?? []), entry]);
  }
  const rows: MarketOverviewRow[] = [];
  for (const [ticker, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(entries.map(entry => entry.venue)).size < 2) continue;
    const cells = entries.map(entry => cell(entry, nowMs));
    const prices = extremes(cells.filter(item => item.book_live).map(item => ({ id: item.instrument_id, value: Number(item.mid) })));
    const funding = extremes(cells.flatMap(item => item.funding?.live ? [{ id: item.instrument_id, value: item.funding.rate_8h_pct }] : []));
    rows.push({
      ticker, cells,
      price_gap_pct: prices ? (prices.high.value - prices.low.value) / prices.low.value * 100 : null,
      cheapest_instrument_id: prices?.low.id ?? null,
      richest_instrument_id: prices?.high.id ?? null,
      funding_gap_8h_pct: funding ? funding.high.value - funding.low.value : null,
      lowest_funding_instrument_id: funding?.low.id ?? null,
      highest_funding_instrument_id: funding?.high.id ?? null,
    });
  }
  return rows;
}
