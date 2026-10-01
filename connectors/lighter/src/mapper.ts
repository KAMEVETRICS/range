import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);

/**
 * Lighter lists stocks and ETFs among crypto, FX, and commodities without an asset-class field, so its stock perpetuals
 * are a reviewed list. Symbols shared with crypto tokens (WEN, BOT, S), indexes, and unclear names are left out; QNT
 * is too, since Lighter prices it near 283 where Quantinuum (QNT elsewhere) trades near 49.
 */
export const LIGHTER_STOCKS: ReadonlySet<string> = new Set([
  "AAOI", "AAPL", "ADI", "AMD", "AMZN", "ANTHROPIC", "ARM", "ASML", "AVGO", "AXTI", "BABA", "BB", "BE", "BMNR", "BOTZ", "BYD", "CBRS",
  "COIN", "CRCL", "CRWV", "CXMT", "DELL", "DIA", "DRAM", "EWY", "GEV", "GME", "GOOGL", "HANMI", "HOOD", "HYUNDAI", "IBM", "INTC",
  "IWM", "KIOXIA", "KORU", "LITE", "MAGS", "META", "MINIMAX", "MRNA", "MRVL", "MSFT", "MSTR", "MU", "NBIS", "NOK", "NOW", "NVDA",
  "OPENAI", "ORCL", "PLTR", "POPMART", "QCOM", "QQQ", "RKLB", "SAMSUNG", "SHEIN", "SKHY", "SKHYNIX", "SMIC", "SNDK", "SOXL",
  "SOXS", "SOXX", "SPCX", "SPY", "STRC", "TENCENT", "TSLA", "TSM", "TTWO", "UNITREE", "URA", "WDC", "XIAOMI", "ZHIPU",
]);

const marketRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+$/),
  market_id: z.number().int().nonnegative(),
  market_type: z.literal("perp"),
  status: z.literal("active"),
  min_base_amount: z.string(),
  min_quote_amount: z.string(),
  supported_size_decimals: z.number().int().min(0).max(18),
  supported_price_decimals: z.number().int().min(0).max(18),
});

const step = (decimals: number) => decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;

/** Lighter funding settles hourly. */
export const LIGHTER_FUNDING_INTERVAL_MS = 3_600_000;

export function mapLighterInstruments(input: unknown, observedAtMs: number): Instrument[] {
  const parsed = z.object({ order_books: z.array(z.unknown()) }).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data.order_books.flatMap(raw => {
    const row = marketRow.safeParse(raw);
    if (!row.success || !LIGHTER_STOCKS.has(row.data.symbol)) return [];
    const item = row.data;
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_lighter_${item.symbol}`,
      underlyingId: `equity:${item.symbol}`,
      productType: "perpetual",
      venue: "lighter",
      venueSymbol: item.symbol,
      quoteAsset: "USDC",
      settlementAsset: "USDC",
      collateralAsset: "USDC",
      contractMultiplier: "1",
      tickSize: step(item.supported_price_decimals),
      lotSize: step(item.supported_size_decimals),
      minimumNotional: item.min_quote_amount,
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: LIGHTER_FUNDING_INTERVAL_MS,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", "stock_underlying_evidence=reviewed_list",
        "trading_schedule_unverified"],
      metadata: { marketId: item.market_id },
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

/** One market's latest stats: best prices (without sizes) and the current hourly funding rate in percent. */
export interface LighterMarketStats {
  readonly symbol: string;
  readonly bestBid?: string;
  readonly bestAsk?: string;
  readonly fundingRatePct?: string;
}

const statsRow = z.object({
  symbol: z.string().min(1),
  best_bid_price: z.string().optional(),
  best_ask_price: z.string().optional(),
  current_funding_rate: z.string().optional(),
});

/** Market stats from a market_stats/all message (the subscription snapshot or an update); other messages yield none. */
export function mapLighterStatsMessage(message: unknown): LighterMarketStats[] {
  const parsed = z.object({ type: z.enum(["subscribed/market_stats", "update/market_stats"]), market_stats: z.record(z.string(), z.unknown()) })
    .safeParse(message);
  if (!parsed.success) return [];
  return Object.values(parsed.data.market_stats).flatMap(raw => {
    const row = statsRow.safeParse(raw);
    if (!row.success) return [];
    const { symbol, best_bid_price: bid, best_ask_price: ask, current_funding_rate: funding } = row.data;
    return [{
      symbol,
      ...(positive.safeParse(bid).success ? { bestBid: bid } : {}),
      ...(positive.safeParse(ask).success ? { bestAsk: ask } : {}),
      ...(decimal.safeParse(funding).success ? { fundingRatePct: funding } : {}),
    }];
  });
}

/** A percentage as a fraction, exactly: "0.0017" becomes "0.000017". */
export function percentToFraction(value: string): string | undefined {
  if (!decimal.safeParse(value).success) return undefined;
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const scale = fraction.length + 2;
  const padded = digits.padStart(scale + 1, "0");
  const text = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
  return `${negative ? "-" : ""}${text}`;
}
