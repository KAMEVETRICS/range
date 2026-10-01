import { z } from "zod";
import { InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, type FundingQuote, type TopOfBook } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positive = z.string().regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/);
const nonnegative = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const HOUR_MS = 3_600_000;

/**
 * Pacifica lists stocks alongside crypto, FX, and commodities without an asset-class field, so its stock perpetuals are
 * a reviewed list. SP500 (an index), CHIP, and BP (unclear underlyings) are left out.
 */
export const PACIFICA_STOCKS: ReadonlySet<string> = new Set([
  "NVDA", "TSLA", "GOOGL", "META", "PLTR", "HOOD", "CRCL", "MSTR", "MU", "SNDK", "SKHYNIX", "SAMSUNG", "SPCX", "URNM", "DRAM",
]);

const envelope = z.object({ success: z.literal(true), data: z.unknown() });
const marketRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+$/),
  instrument_type: z.literal("perpetual"),
  tick_size: positive,
  lot_size: positive,
  min_order_size: nonnegative,
});
const bookLevel = z.object({ p: positive, a: nonnegative });
const book = z.object({ s: z.string(), l: z.tuple([z.array(bookLevel), z.array(bookLevel)]), t: z.number().int().positive() });
const priceRow = z.object({ symbol: z.string(), next_funding: decimal, timestamp: z.number().int().positive() });

function data(input: unknown): unknown {
  const parsed = envelope.safeParse(input);
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data.data;
}

function rows(input: unknown): unknown[] {
  const parsed = z.array(z.unknown()).safeParse(data(input));
  if (!parsed.success) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  return parsed.data;
}

export function mapPacificaInstruments(input: unknown, observedAtMs: number): Instrument[] {
  return rows(input).flatMap(raw => {
    const row = marketRow.safeParse(raw);
    if (!row.success || !PACIFICA_STOCKS.has(row.data.symbol)) return [];
    const item = row.data;
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_pacifica_${item.symbol}`,
      underlyingId: `equity:${item.symbol}`,
      productType: "perpetual",
      venue: "pacifica",
      venueSymbol: item.symbol,
      quoteAsset: "USDC",
      settlementAsset: "USDC",
      collateralAsset: "USDC",
      contractMultiplier: "1",
      tickSize: item.tick_size,
      lotSize: item.lot_size,
      minimumNotional: item.min_order_size,
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: HOUR_MS,
      capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only", "stock_underlying_evidence=reviewed_list",
        "trading_schedule_unverified"],
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
    return instrument.success ? [instrument.data] : [];
  });
}

/** The best bid and offer from one market's book: levels are [bids, asks], best first. */
export function mapPacificaBook(input: unknown, symbol: string): TopOfBook {
  const parsed = book.safeParse(data(input));
  if (!parsed.success || parsed.data.s !== symbol) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  const [bids, asks] = parsed.data.l;
  const level = (item: z.infer<typeof bookLevel> | undefined) => item && { price: item.p, quantity: item.a };
  const bid = level(bids[0]);
  const ask = level(asks[0]);
  return { sourceTimestampMs: parsed.data.t, ...(bid ? { bid } : {}), ...(ask ? { ask } : {}) };
}

/**
 * Funding for listed markets from the prices feed: next_funding is the rate expected at the next hourly settlement.
 * The feed does not state settlement times, so the next full hour is assumed, flagged.
 */
export function mapPacificaFunding(input: unknown, instruments: readonly Instrument[]): Map<string, FundingQuote> {
  const listed = new Set(instruments.map(item => item.venueSymbol));
  const funding = new Map<string, FundingQuote>();
  for (const raw of rows(input)) {
    const row = priceRow.safeParse(raw);
    if (!row.success || !listed.has(row.data.symbol)) continue;
    funding.set(row.data.symbol, { rate: row.data.next_funding, intervalMs: HOUR_MS, rateType: "predicted",
      nextSettlementMs: Math.floor(row.data.timestamp / HOUR_MS) * HOUR_MS + HOUR_MS, sourceTimestampMs: row.data.timestamp,
      flags: ["hourly_settlement_assumed"] });
  }
  return funding;
}
