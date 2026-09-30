import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, type FundingQuote, type TopOfBook } from "../../../packages/connector-sdk/src/index.js";

const HOUR_MS = 3_600_000;
const x18 = z.string().regex(/^-?\d+$/);

/**
 * Nado lists stocks and ETFs among crypto, FX, and commodities without an asset-class field, so its stock perpetuals
 * are a reviewed list. CHIP (unclear underlying) is left out.
 */
export const NADO_STOCKS: ReadonlySet<string> = new Set([
  "AAPL", "AMD", "AMZN", "AVGO", "BBX", "CRCL", "DELL", "GOOGL", "HIMS", "INTC", "LLY", "META", "MRVL", "MSFT", "MSTR", "MU", "NBIS",
  "NVDA", "ORCL", "PENG", "QQQ", "SKHY", "SNDK", "SPCX", "SPY", "TSLA", "ZHIPU",
]);

/** Nado funding settles every hour. */
export const NADO_FUNDING_INTERVAL_MS = HOUR_MS;

/** A value scaled by 10^18, as an exact decimal string. */
export function fromX18(value: string): string {
  const negative = value.startsWith("-");
  const digits = value.replace("-", "").padStart(19, "0");
  const whole = digits.slice(0, -18).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-18).replace(/0+$/, "");
  return `${negative && (whole !== "0" || fraction) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

const symbolRow = z.object({
  type: z.literal("perp"),
  product_id: z.number().int().nonnegative(),
  symbol: z.string().regex(/^[A-Z0-9]+-PERP$/),
  price_increment_x18: x18,
  size_increment: x18,
  trading_status: z.literal("live"),
});

export function mapNadoInstruments(input: unknown, observedAtMs: number): Instrument[] {
  const parsed = z.object({ status: z.literal("success"), data: z.object({ symbols: z.record(z.string(), z.unknown()) }) }).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return Object.values(parsed.data.data.symbols).flatMap(raw => {
    const row = symbolRow.safeParse(raw);
    const ticker = row.success ? row.data.symbol.slice(0, -"-PERP".length) : "";
    if (!row.success || !NADO_STOCKS.has(ticker)) return [];
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_nado_${row.data.symbol}`,
      underlyingId: `equity:${ticker}`,
      productType: "perpetual",
      venue: "nado",
      venueSymbol: row.data.symbol,
      quoteAsset: "USD",
      settlementAsset: "UNVERIFIED",
      collateralAsset: "UNVERIFIED",
      contractMultiplier: "1",
      tickSize: fromX18(row.data.price_increment_x18),
      lotSize: fromX18(row.data.size_increment),
      minimumNotional: "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: NADO_FUNDING_INTERVAL_MS,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", "stock_underlying_evidence=reviewed_list",
        "settlement_unverified", "collateral_unverified", "trading_schedule_unverified"],
      metadata: { productId: row.data.product_id },
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

/** Nado reads markets by product id; each listed instrument carries its id in metadata. */
export function productIds(instruments: readonly Instrument[]): Map<number, string> {
  return new Map(instruments.flatMap(item => {
    const id = item.metadata?.productId;
    return typeof id === "number" ? [[id, item.venueSymbol] as const] : [];
  }));
}

const priceRow = z.object({ product_id: z.number().int(), bid_x18: x18, ask_x18: x18 });

/** Best bid and ask for listed markets, without sizes; the response has no time, so receipt time stamps it, flagged. */
export function mapNadoPrices(input: unknown, products: ReadonlyMap<number, string>, receivedAtMs: number): Map<string, TopOfBook> {
  const parsed = z.object({ status: z.literal("success"), data: z.object({ market_prices: z.array(z.unknown()) }) }).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  const tops = new Map<string, TopOfBook>();
  for (const raw of parsed.data.data.market_prices) {
    const row = priceRow.safeParse(raw);
    const symbol = row.success ? products.get(row.data.product_id) : undefined;
    if (!row.success || !symbol) continue;
    const side = (value: string) => BigInt(value) > 0n ? { price: fromX18(value), quantity: "0" } : undefined;
    const bid = side(row.data.bid_x18);
    const ask = side(row.data.ask_x18);
    if (bid || ask) tops.set(symbol, { sourceTimestampMs: receivedAtMs, flags: ["client_receipt_timestamp", "top_of_book_size_unknown"],
      ...(bid ? { bid } : {}), ...(ask ? { ask } : {}) });
  }
  return tops;
}

const fundingRow = z.object({ product_id: z.number().int(), funding_rate_x18: x18, update_time: z.string().regex(/^\d+$/) });

/**
 * Funding for listed markets. Nado states the rate over 24 hours and settles hourly, so the rate per settlement is a
 * twenty-fourth of it; the next settlement is assumed at the top of the hour. Both are flagged.
 */
export function mapNadoFunding(input: unknown, products: ReadonlyMap<number, string>): Map<string, FundingQuote> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  const funding = new Map<string, FundingQuote>();
  for (const raw of Object.values(parsed.data)) {
    const row = fundingRow.safeParse(raw);
    const symbol = row.success ? products.get(row.data.product_id) : undefined;
    if (!row.success || !symbol) continue;
    const sourceTimestampMs = Number(row.data.update_time) * 1_000;
    funding.set(symbol, { rate: fromX18((BigInt(row.data.funding_rate_x18) / 24n).toString()), intervalMs: NADO_FUNDING_INTERVAL_MS,
      rateType: "predicted", sourceTimestampMs, nextSettlementMs: Math.floor(sourceTimestampMs / HOUR_MS) * HOUR_MS + HOUR_MS,
      flags: ["rate_from_24h", "hourly_settlement_assumed"] });
  }
  return funding;
}
