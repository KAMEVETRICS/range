import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, toDecimalString, type PriceLevel } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);
const nonnegative = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const HOUR_MS = 3_600_000;
const HOURS_PER_YEAR = 24 * 365;

/** QFEX funding settles every hour. */
export const QFEX_FUNDING_INTERVAL_MS = HOUR_MS;

const marketRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9.]+-USD$/),
  base_asset: z.string().regex(/^[A-Z0-9.]+$/),
  quote_asset: z.literal("USD"),
  margin_asset: z.string().min(1),
  product_category: z.literal("EQUITY"),
  status: z.literal("ACTIVE"),
  tick_size: positive,
  lot_size: positive,
});

/**
 * QFEX's active USD-quoted stock perpetuals: refdata marks them product_category EQUITY. Listings quoted in other
 * currencies (SAMSUNG-KRW) and indexes are left out.
 */
export function mapQfexInstruments(input: unknown, observedAtMs: number): Instrument[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data.data.flatMap(raw => {
    const row = marketRow.safeParse(raw);
    if (!row.success) return [];
    const item = row.data;
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_qfex_${item.symbol}`,
      underlyingId: `equity:${item.base_asset}`,
      productType: "perpetual",
      venue: "qfex",
      venueSymbol: item.symbol,
      quoteAsset: item.quote_asset,
      settlementAsset: item.margin_asset,
      collateralAsset: item.margin_asset,
      contractMultiplier: "1",
      tickSize: item.tick_size,
      lotSize: item.lot_size,
      minimumNotional: "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: QFEX_FUNDING_INTERVAL_MS,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", "stock_underlying_evidence=product_category",
        "trading_schedule_unverified"],
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

/** RFC 3339 with nanoseconds, to epoch milliseconds. */
function epochMs(value: string): number | undefined {
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isSafeInteger(ms) ? ms : undefined;
}

const level = z.tuple([z.string(), z.string()]);
const bboMessage = z.object({ type: z.literal("bbo"), symbol: z.string(), time: z.string(), bid: z.array(level), ask: z.array(level) });
const fundingMessage = z.object({ type: z.literal("funding"), symbol: z.string(), time: z.string(), annualised_funding_rate: decimal,
  time_remaining: z.number().int().nonnegative() });

export interface QfexBbo {
  readonly symbol: string;
  readonly bid?: PriceLevel;
  readonly ask?: PriceLevel;
}

export interface QfexFunding {
  readonly symbol: string;
  /** Fraction per hour. */
  readonly rate: string;
  readonly sourceTimestampMs: number;
  readonly nextSettlementMs: number;
}

function bestLevel(levels: readonly (readonly [string, string])[]): PriceLevel | undefined {
  const [price, quantity] = levels[0] ?? [];
  return positive.safeParse(price).success && nonnegative.safeParse(quantity).success ? { price: price!, quantity: quantity! } : undefined;
}

/** A market's best bid and offer from a bbo message; either side may be empty. */
export function mapQfexBbo(message: unknown): QfexBbo | undefined {
  const parsed = bboMessage.safeParse(message);
  if (!parsed.success) return undefined;
  const bid = bestLevel(parsed.data.bid);
  const ask = bestLevel(parsed.data.ask);
  return { symbol: parsed.data.symbol, ...(bid ? { bid } : {}), ...(ask ? { ask } : {}) };
}

/**
 * A market's current hourly funding estimate. funding_rate is the hourly fraction rounded to five places, too coarse
 * for stock perpetuals (most read 0.00000), and annualised_funding_rate is the same rate times 8,760 to four places,
 * so the hourly rate comes from the annual one. time_remaining counts down to the settlement at the top of the hour.
 */
export function mapQfexFunding(message: unknown): QfexFunding | undefined {
  const parsed = fundingMessage.safeParse(message);
  const timeMs = parsed.success ? epochMs(parsed.data.time) : undefined;
  if (!parsed.success || timeMs === undefined) return undefined;
  const rate = toDecimalString(Number((Number(parsed.data.annualised_funding_rate) / HOURS_PER_YEAR).toPrecision(10)));
  if (rate === undefined) return undefined;
  const nextSettlementMs = Math.round((timeMs + parsed.data.time_remaining * 1_000) / 60_000) * 60_000;
  return { symbol: parsed.data.symbol, rate, sourceTimestampMs: timeMs, nextSettlementMs };
}
