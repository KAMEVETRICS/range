import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, type FundingQuote, type TopOfBook } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);
const nonnegative = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const envelope = z.object({
  retCode: z.literal(0),
  result: z.object({ list: z.array(z.unknown()), nextPageCursor: z.string().optional() }),
  time: z.number().int().positive(),
});

const instrumentRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+$/),
  contractType: z.literal("LinearPerpetual"),
  status: z.literal("Trading"),
  symbolType: z.literal("stock"),
  underlyingTicker: z.string().regex(/^[A-Z0-9][A-Z0-9.-]*$/),
  baseCoin: z.string().regex(/^[A-Z0-9]+$/),
  quoteCoin: z.string().min(1),
  settleCoin: z.string().min(1),
  priceFilter: z.object({ tickSize: positive }),
  lotSizeFilter: z.object({ qtyStep: positive, minNotionalValue: nonnegative.optional() }),
  fundingInterval: z.number().int().positive(),
  marketRegion: z.string().optional(),
  fullName: z.string().optional(),
});

const tickerRow = z.object({
  symbol: z.string().min(1),
  bid1Price: z.string().optional(),
  bid1Size: z.string().optional(),
  ask1Price: z.string().optional(),
  ask1Size: z.string().optional(),
  fundingRate: z.string().optional(),
  nextFundingTime: z.string().optional(),
  fundingIntervalHour: z.string().optional(),
});

function parseEnvelope(input: unknown): z.infer<typeof envelope> {
  const parsed = envelope.safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data;
}

/**
 * Stock perpetuals from one page of Bybit's linear instruments. Bybit marks them with symbolType "stock" and names
 * the listed share in underlyingTicker, which may differ from the symbol (BBXUSDT is BB). Asian listings carry exchange
 * codes there (Samsung is 005930), so those take the base coin's name (SAMSUNG), as other venues do. A listing that
 * does not parse is skipped; only a response that is not a successful listing fails.
 */
export function mapBybitInstruments(input: unknown, observedAtMs: number): { instruments: Instrument[]; nextCursor?: string } {
  const page = parseEnvelope(input);
  const instruments = page.result.list.flatMap(raw => {
    const row = instrumentRow.safeParse(raw);
    if (!row.success) return [];
    const item = row.data;
    const ticker = /^[A-Z][A-Z.]*$/.test(item.underlyingTicker) ? item.underlyingTicker : item.baseCoin;
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_bybit_${item.symbol}`,
      underlyingId: `equity:${ticker}`,
      productType: "perpetual",
      venue: "bybit",
      venueSymbol: item.symbol,
      quoteAsset: item.quoteCoin,
      settlementAsset: item.settleCoin,
      collateralAsset: item.settleCoin,
      contractMultiplier: "1",
      tickSize: item.priceFilter.tickSize,
      lotSize: item.lotSizeFilter.qtyStep,
      minimumNotional: item.lotSizeFilter.minNotionalValue ?? "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: item.fundingInterval * 60_000,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", "stock_underlying_evidence=symbol_type",
        "trading_schedule_unverified"],
      metadata: { underlyingTicker: item.underlyingTicker, ...(item.marketRegion ? { marketRegion: item.marketRegion } : {}),
        ...(item.fullName ? { fullName: item.fullName } : {}) },
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
  return { instruments, ...(page.result.nextPageCursor ? { nextCursor: page.result.nextPageCursor } : {}) };
}

function level(price: string | undefined, quantity: string | undefined) {
  return positive.safeParse(price).success && nonnegative.safeParse(quantity).success ? { price: price!, quantity: quantity! } : undefined;
}

/**
 * Every linear market's best bid and offer and its funding, from one tickers response. The response's own time stamps
 * both. fundingRate is the rate Bybit expects to settle at nextFundingTime.
 */
export function mapBybitTickers(input: unknown): { tops: Map<string, TopOfBook>; funding: Map<string, FundingQuote> } {
  const page = parseEnvelope(input);
  const tops = new Map<string, TopOfBook>();
  const funding = new Map<string, FundingQuote>();
  for (const raw of page.result.list) {
    const row = tickerRow.safeParse(raw);
    if (!row.success) continue;
    const { symbol } = row.data;
    const bid = level(row.data.bid1Price, row.data.bid1Size);
    const ask = level(row.data.ask1Price, row.data.ask1Size);
    if (bid || ask) tops.set(symbol, { sourceTimestampMs: page.time, ...(bid ? { bid } : {}), ...(ask ? { ask } : {}) });
    const hours = Number(row.data.fundingIntervalHour);
    const nextSettlementMs = Number(row.data.nextFundingTime);
    if (decimal.safeParse(row.data.fundingRate).success && Number.isSafeInteger(hours) && hours > 0 &&
        Number.isSafeInteger(nextSettlementMs) && nextSettlementMs > 0) {
      funding.set(symbol, { rate: row.data.fundingRate!, intervalMs: hours * 3_600_000, nextSettlementMs, rateType: "predicted",
        sourceTimestampMs: page.time });
    }
  }
  return { tops, funding };
}
