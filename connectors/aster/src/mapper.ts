import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, type FundingQuote, type TopOfBook } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);
const nonnegative = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const EIGHT_HOURS_MS = 8 * 3_600_000;

const filter = z.object({ filterType: z.string() }).loose();
const symbolRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+$/),
  status: z.literal("TRADING"),
  contractType: z.string(),
  baseAsset: z.string().regex(/^[A-Z0-9]+$/),
  quoteAsset: z.literal("USDT"),
  marginAsset: z.string().min(1),
  underlyingType: z.string().optional(),
  underlyingSubType: z.array(z.string()).optional(),
  filters: z.array(filter),
});

/** How a venue with a Binance-compatible futures API marks its stock perpetuals in exchange info. */
export interface FuturesStockListing {
  readonly venue: string;
  readonly evidence: string;
  isStock(row: Pick<z.infer<typeof symbolRow>, "contractType" | "underlyingType" | "underlyingSubType">): boolean;
}

/** Aster tags stock perpetuals STOCK in underlyingSubType. */
export const ASTER_STOCKS: FuturesStockListing = {
  venue: "aster",
  evidence: "underlying_sub_type",
  isStock: row => row.contractType === "PERPETUAL" && (row.underlyingSubType ?? []).includes("STOCK"),
};

const BINANCE_EQUITY_TYPES = new Set(["EQUITY", "HK_EQUITY", "KR_EQUITY", "CN_EQUITY"]);
/** Binance lists stock perpetuals as TRADIFI_PERPETUAL contracts with an equity underlyingType. */
export const BINANCE_STOCKS: FuturesStockListing = {
  venue: "binance",
  evidence: "underlying_type",
  isStock: row => row.contractType === "TRADIFI_PERPETUAL" && BINANCE_EQUITY_TYPES.has(row.underlyingType ?? ""),
};
const fundingInfoRow = z.object({ symbol: z.string(), fundingIntervalHours: z.number().int().positive() });
const bookRow = z.object({ symbol: z.string(), bidPrice: z.string(), bidQty: z.string(), askPrice: z.string(), askQty: z.string(),
  time: z.number().int().positive() });
/** A book whose last change is this recent is taken as current at receipt; an older one keeps its own time. */
const BOOK_CURRENT_MS = 300_000;
const premiumRow = z.object({ symbol: z.string(), lastFundingRate: decimal, nextFundingTime: z.number().int().positive(),
  time: z.number().int().positive() });

const list = (input: unknown) => {
  const parsed = z.array(z.unknown()).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data;
};

function filterValue(filters: readonly z.infer<typeof filter>[], type: string, key: string): unknown {
  return filters.find(item => item.filterType === type)?.[key];
}

/**
 * A venue's USDT stock perpetuals from exchange info, which names the share in baseAsset. Funding intervals come from
 * funding info; a market it leaves out is assumed to settle every eight hours, flagged.
 */
export function mapFuturesInstruments(exchangeInfo: unknown, fundingInfo: unknown, observedAtMs: number,
  listing: FuturesStockListing = ASTER_STOCKS): Instrument[] {
  const info = z.object({ symbols: z.array(z.unknown()) }).safeParse(exchangeInfo);
  if (!info.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  const intervals = new Map(list(fundingInfo).flatMap(raw => {
    const row = fundingInfoRow.safeParse(raw);
    return row.success ? [[row.data.symbol, row.data.fundingIntervalHours * 3_600_000] as const] : [];
  }));
  return info.data.symbols.flatMap(raw => {
    const row = symbolRow.safeParse(raw);
    if (!row.success || !listing.isStock(row.data)) return [];
    const item = row.data;
    const interval = intervals.get(item.symbol);
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_${listing.venue}_${item.symbol}`,
      underlyingId: `equity:${item.baseAsset}`,
      productType: "perpetual",
      venue: listing.venue,
      venueSymbol: item.symbol,
      quoteAsset: item.quoteAsset,
      settlementAsset: item.marginAsset,
      collateralAsset: item.marginAsset,
      contractMultiplier: "1",
      tickSize: filterValue(item.filters, "PRICE_FILTER", "tickSize"),
      lotSize: filterValue(item.filters, "LOT_SIZE", "stepSize"),
      minimumNotional: filterValue(item.filters, "MIN_NOTIONAL", "notional") ?? "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: interval ?? EIGHT_HOURS_MS,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", `stock_underlying_evidence=${listing.evidence}`,
        "trading_schedule_unverified", ...(interval ? [] : ["funding_interval_assumed"])],
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

function level(price: string, quantity: string) {
  return positive.safeParse(price).success && nonnegative.safeParse(quantity).success ? { price, quantity } : undefined;
}

/**
 * Every market's best bid and offer. Each row's own time is the book's last change, which for a quiet market can be
 * minutes old while the quote still stands, so a book changed within five minutes is stamped with the read's receipt
 * time, flagged; an older one keeps its own time and shows as stale.
 */
export function mapBookTickers(input: unknown, receivedAtMs: number): Map<string, TopOfBook> {
  const tops = new Map<string, TopOfBook>();
  for (const raw of list(input)) {
    const row = bookRow.safeParse(raw);
    if (!row.success) continue;
    const bid = level(row.data.bidPrice, row.data.bidQty);
    const ask = level(row.data.askPrice, row.data.askQty);
    if (!bid && !ask) continue;
    const current = row.data.time >= receivedAtMs - BOOK_CURRENT_MS;
    tops.set(row.data.symbol, { sourceTimestampMs: current ? receivedAtMs : row.data.time,
      ...(current ? { flags: ["client_receipt_timestamp"] } : {}), ...(bid ? { bid } : {}), ...(ask ? { ask } : {}) });
  }
  return tops;
}

/** Funding for listed markets: the premium index's current rate, which settles at nextFundingTime. */
export function mapPremiumIndexFunding(input: unknown, instruments: readonly Instrument[]): Map<string, FundingQuote> {
  const intervals = new Map(instruments.flatMap(item => item.productType === "perpetual" ? [[item.venueSymbol, item.fundingInterval] as const] : []));
  const funding = new Map<string, FundingQuote>();
  for (const raw of list(input)) {
    const row = premiumRow.safeParse(raw);
    const intervalMs = row.success ? intervals.get(row.data.symbol) : undefined;
    if (!row.success || !intervalMs) continue;
    funding.set(row.data.symbol, { rate: row.data.lastFundingRate, intervalMs, nextSettlementMs: row.data.nextFundingTime,
      rateType: "predicted", sourceTimestampMs: row.data.time });
  }
  return funding;
}
