import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, toDecimalString, type FundingQuote, type TopOfBook } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);
const YEAR_S = 365 * 24 * 3_600;
const EIGHT_HOURS_S = 8 * 3_600;
/** A quote the venue refreshed this recently is taken as current at receipt; an older one keeps its own time. */
const QUOTE_CURRENT_MS = 300_000;

/**
 * Variational lists stocks and ETFs among crypto without an asset-class field. This reviewed list is its listings whose
 * names are companies or funds (for example "BlackBerry Limited" for BBX and "Visa Inc." for VISA).
 */
export const VARIATIONAL_STOCKS: ReadonlySet<string> = new Set([
  "AAOI", "AAPL", "ALAB", "AMAT", "AMD", "AMZN", "ARM", "AVGO", "BABA", "BBX", "BMNR", "BNC", "BOT", "BRKB", "BX", "CAT", "CBRS",
  "CIEN", "COIN", "COST", "CRCL", "CRDO", "CRM", "CRWD", "CRWV", "CSCO", "DELL", "DIS", "DKNG", "DRAM", "EBAY", "EWJ", "EWT", "EWY",
  "EWZ", "FWDI", "GME", "GOOGL", "GPRO", "HD", "HIMS", "HOOD", "HPE", "IBM", "INTC", "IREN", "IWM", "JPM", "KLAC", "KSTR", "LITE",
  "LLY", "META", "MRNA", "MRVL", "MSFT", "MSTR", "MU", "NBIS", "NFLX", "NVDA", "ONDS", "ORCL", "PAYP", "PLTR", "QNTX", "QQQ",
  "RDDT", "RIVN", "RKLB", "SHAZ", "SKHY", "SMCI", "SNDK", "SNOW", "SOXL", "SOXS", "SONY", "SPCX", "STRC", "STXX", "TER", "TMF",
  "TSLA", "TSM", "TTWO", "TZA", "UBER", "URNM", "USAR", "UVXY", "VISA", "WEN", "WMT", "XBI", "XLE", "ZM",
]);

const listing = z.object({
  ticker: z.string().regex(/^[A-Z0-9]+$/),
  name: z.string().optional(),
  funding_rate: decimal,
  funding_interval_s: z.number().int().nonnegative(),
  quotes: z.object({
    updated_at: z.string(),
    base: z.object({ bid: positive.optional(), ask: positive.optional() }),
  }),
});

function listings(input: unknown): unknown[] {
  const parsed = z.object({ listings: z.array(z.unknown()) }).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data.listings;
}

/** RFC 3339 with nanoseconds, to epoch milliseconds. */
function epochMs(value: string): number | undefined {
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isSafeInteger(ms) ? ms : undefined;
}

export function mapVariationalInstruments(input: unknown, observedAtMs: number): Instrument[] {
  return listings(input).flatMap(raw => {
    const row = listing.safeParse(raw);
    if (!row.success || !VARIATIONAL_STOCKS.has(row.data.ticker)) return [];
    const item = row.data;
    const stated = item.funding_interval_s > 0;
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_variational_${item.ticker}`,
      underlyingId: `equity:${item.ticker}`,
      productType: "perpetual",
      venue: "variational",
      venueSymbol: item.ticker,
      quoteAsset: "USDC",
      settlementAsset: "USDC",
      collateralAsset: "USDC",
      contractMultiplier: "1",
      tickSize: "0.000001",
      lotSize: "0.000001",
      minimumNotional: "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: (stated ? item.funding_interval_s : EIGHT_HOURS_S) * 1_000,
      capabilities: ["perpetual", "rfq_indicative_quotes", "funding_reference_only", "stock_underlying_evidence=reviewed_list",
        "tick_size_unverified", "lot_size_unverified", "trading_schedule_unverified", ...(stated ? [] : ["funding_interval_assumed"])],
      metadata: item.name ? { name: item.name } : {},
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

/**
 * Every listing's base quote: Variational is request-for-quote, so these are indicative prices without sizes. A quote
 * refreshed within five minutes counts as current when received; an older one keeps its own time and shows as stale.
 */
export function mapVariationalTops(input: unknown, receivedAtMs: number): Map<string, TopOfBook> {
  const tops = new Map<string, TopOfBook>();
  for (const raw of listings(input)) {
    const row = listing.safeParse(raw);
    const updatedAtMs = row.success ? epochMs(row.data.quotes.updated_at) : undefined;
    if (!row.success || updatedAtMs === undefined) continue;
    const { bid, ask } = row.data.quotes.base;
    if (!bid && !ask) continue;
    const current = updatedAtMs >= receivedAtMs - QUOTE_CURRENT_MS;
    tops.set(row.data.ticker, {
      sourceTimestampMs: current ? receivedAtMs : updatedAtMs,
      flags: ["top_of_book_size_unknown", "rfq_indicative_quote", ...(current ? ["client_receipt_timestamp"] : [])],
      ...(bid ? { bid: { price: bid, quantity: "0" } } : {}),
      ...(ask ? { ask: { price: ask, quantity: "0" } } : {}),
    });
  }
  return tops;
}

/**
 * Funding for listed markets. Variational states funding_rate as an annual fraction (TSLA 0.296 when Bybit and Aster
 * charged about 0.03% per eight hours), so the rate per interval is its share of a year. Settlement times are not
 * stated; the next multiple of the interval is assumed. Both are flagged.
 */
export function mapVariationalFunding(input: unknown, instruments: readonly Instrument[], receivedAtMs: number): Map<string, FundingQuote> {
  const listed = new Set(instruments.map(item => item.venueSymbol));
  const funding = new Map<string, FundingQuote>();
  for (const raw of listings(input)) {
    const row = listing.safeParse(raw);
    if (!row.success || !listed.has(row.data.ticker) || row.data.funding_interval_s <= 0) continue;
    const intervalMs = row.data.funding_interval_s * 1_000;
    const rate = toDecimalString(Number((Number(row.data.funding_rate) * row.data.funding_interval_s / YEAR_S).toPrecision(10)));
    if (rate === undefined) continue;
    funding.set(row.data.ticker, { rate, intervalMs, rateType: "predicted", sourceTimestampMs: receivedAtMs,
      nextSettlementMs: Math.floor(receivedAtMs / intervalMs) * intervalMs + intervalMs,
      flags: ["client_receipt_timestamp", "funding_rate_from_annual", "settlement_time_assumed"] });
  }
  return funding;
}
