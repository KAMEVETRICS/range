import { createHash } from "node:crypto";
import { CanonicalObservationPayloadSchema, InstrumentSchema, type Instrument } from "@range/domain";
import { ConnectorDiagnosticError, isEpochMilliseconds, type RawVenueEvent } from "@range/connector-sdk";
import { z } from "zod";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const nonnegative = decimal.refine(value => !value.startsWith("-"));
const positive = nonnegative.refine(value => /[1-9]/.test(value));
const text = z.string().min(1);
const timestamp = z.union([z.string().regex(/^\d+$/), z.number()]).transform(Number)
  .refine(value => Number.isSafeInteger(value) && isEpochMilliseconds(value) && value >= 1_000_000_000_000);
const category = z.enum(["SPOT", "USDT-FUTURES", "USDC-FUTURES"]);
export type BitgetCategory = z.infer<typeof category>;
export const BITGET_CATEGORIES: readonly BitgetCategory[] = ["SPOT", "USDT-FUTURES", "USDC-FUTURES"];
const response = z.object({ code: z.literal("00000"), data: z.unknown() });
const instrumentRow = z.object({
  symbol: text, category: z.string(), baseCoin: text, quoteCoin: text,
  isRwa: z.string().optional(), isReality: z.string().optional(), symbolType: z.string().optional(),
  pricePrecision: z.string().regex(/^\d{1,2}$/), quantityPrecision: z.string().regex(/^\d{1,2}$/),
  priceMultiplier: positive.optional(), quantityMultiplier: positive.optional(),
  minOrderAmount: nonnegative, status: text, type: z.string().optional(), fundInterval: z.string().optional(),
  // Bitget reports "0" when a listing's launch time is unknown.
  launchTime: z.union([z.literal("0").transform(() => undefined), timestamp]),
});
const instrumentsResponse = response.extend({ requestTime: timestamp.optional() });

function safe<T>(operation: () => T): T {
  try { return operation(); } catch { throw new ConnectorDiagnosticError("ADAPTER_FAILURE"); }
}
/** The JSON reviver's source preserves exchange decimals and 64-bit sequences (Node >=22). */
export function parseBitgetJson(input: string): unknown {
  return safe(() => JSON.parse(input, (_key, value: unknown, context?: {source: string}) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error();
    return context.source;
  }));
}
function precisionStep(value: string): string {
  const places = Number(value);
  if (places > 30) throw new Error();
  return places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`;
}
export function bitgetCategory(instrument: Instrument): BitgetCategory {
  return category.parse(instrument.venueFamily);
}
export function isReality(instrument: Instrument): boolean {
  return instrument.capabilities.includes("isReality=yes");
}

/** The stock ticker a Bitget instrument trades, for matching other venues' listings: Reality tokens drop their
 * "r" prefix (rAAPL -> AAPL) and stock perps use their base coin. Other instruments have no derivable ticker. */
export function bitgetEquityTicker(instrument: Instrument): string | undefined {
  if (!instrument.underlyingId.startsWith("bitget:")) return undefined;
  const base = instrument.underlyingId.slice("bitget:".length);
  if (isReality(instrument)) return /^r[A-Z0-9]/.test(base) ? base.slice(1).toUpperCase() : undefined;
  if (instrument.productType === "perpetual" && instrument.capabilities.includes("symbolType=stock")) return base.toUpperCase();
  return undefined;
}

/** Venue-local underlying IDs deliberately await the reviewed cross-venue registry. */
export function mapBitgetInstruments(input: unknown): Instrument[] {
  return safe(() => {
    const body = instrumentsResponse.parse(input);
    return z.array(instrumentRow).parse(body.data).flatMap(row => {
    if (!BITGET_CATEGORIES.includes(row.category as BitgetCategory) || row.status !== "online") return [];
    const spot = row.category === "SPOT";
    if (spot ? row.isRwa !== "YES" && row.isReality !== "yes" : row.type !== "perpetual") return [];
    // Range covers equities only: perps must be explicitly stock-linked; RWA spot marked metal/commodity/etc. is out.
    if (spot ? row.symbolType !== undefined && row.symbolType !== "stock" : row.symbolType !== "stock") return [];
    const interval = Number(row.fundInterval) * 3_600_000;
    if (!spot && (!Number.isSafeInteger(interval) || interval <= 0)) return [];
    // Without a launch time, metadata is effective only from when it was observed.
    const effectiveFromMs = row.launchTime ?? body.requestTime;
    if (effectiveFromMs === undefined) return [];
    const capabilities = [spot ? "spot" : "perpetual", "underlying_unverified", "trading_schedule_unverified"];
    if (row.launchTime === undefined) capabilities.push("launch_time_unknown");
    if (row.isRwa === "YES") capabilities.push("isRwa=YES", "tokenized_stock");
    if (row.symbolType === "stock") capabilities.push("symbolType=stock", "tokenized_stock");
    if (row.isReality === "yes") capabilities.push("isReality=yes", "tokenized_stock", "reality_raw_book=access_pending");
    // A listing Range cannot represent (e.g. non-ASCII symbols) is excluded alone rather than failing discovery.
    const instrument = InstrumentSchema.safeParse({
      instrumentId: `ins_bitget_${row.category}_${row.symbol}`, underlyingId: `bitget:${row.baseCoin}`,
      venue: "bitget", venueFamily: row.category, venueSymbol: row.symbol,
      productType: spot ? "tokenized_spot" : "perpetual",
      quoteAsset: row.quoteCoin, settlementAsset: row.quoteCoin, collateralAsset: row.quoteCoin,
      contractMultiplier: "1", tickSize: row.priceMultiplier ?? precisionStep(row.pricePrecision),
      lotSize: row.quantityMultiplier ?? precisionStep(row.quantityPrecision), minimumNotional: row.minOrderAmount,
      // Schema requires a schedule. This placeholder is explicitly unverified; events are reference-only.
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1,2,3,4,5,6,7], opensAt: "00:00", closesAt: "23:59" }] },
      capabilities: [...new Set(capabilities)], metadataVersion: 1,
      effectiveFrom: new Date(effectiveFromMs).toISOString(), ...(spot ? {} : { fundingInterval: interval }),
    });
    return instrument.success ? [instrument.data] : [];
    });
  });
}

function event(instrument: Instrument, raw: unknown, sourceTimestampMs: number,
  payload: RawVenueEvent["payload"], transport: RawVenueEvent["transport"], qualityFlags: string[] = [], sequence?: string): RawVenueEvent {
  const rawPayloadRefOrHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  return {
    eventId: `evt_bitget_${instrument.instrumentId}_${payload.kind}_${sourceTimestampMs}_${rawPayloadRefOrHash.slice(0, 16)}`,
    instrumentId: instrument.instrumentId, sourceTimestampMs, transport, freshnessBudgetMs: 5_000,
    qualityFlags: ["underlying_unverified", "trading_schedule_unverified", ...qualityFlags],
    rawPayloadRefOrHash, eligibility: "reference_only", payload: CanonicalObservationPayloadSchema.parse(payload),
    ...(sequence === undefined ? {} : { sequence }),
  };
}
// Decimal numeric JSON levels are accepted only when their decimal representation survives conversion.
const wireDecimal = z.union([decimal, z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const bookRow = z.object({ a: z.array(z.tuple([wireDecimal, wireDecimal])), b: z.array(z.tuple([wireDecimal, wireDecimal])), ts: timestamp,
  seq: z.union([text, z.number().int().nonnegative().safe().transform(String)]).optional() });
export function mapBitgetBook(input: unknown, instrument: Instrument, transport: RawVenueEvent["transport"] = "rest"): RawVenueEvent {
  return safe(() => {
    const row = bookRow.parse(response.parse(input).data);
    const levels = (values: [string, string][]) => values.map(([price, quantity]) => ({ price, quantity }));
    return event(instrument, input, row.ts, { kind: "order_book", asks: levels(row.a), bids: levels(row.b), capacityUsd: "0" },
      transport, ["capacity_usd_uncomputed", ...(isReality(instrument) ? ["reality_raw_book=access_pending"] : [])], row.seq);
  });
}

const tickerRow = z.object({ category, symbol: text, ts: timestamp, lastPrice: positive.optional(), indexPrice: positive.optional(),
  fundingRate: decimal.optional(), nextFundingTime: timestamp.optional(), openInterest: nonnegative.optional(),
  platformTurnover24h: nonnegative.optional(), turnover24h: nonnegative.optional(), markPrice: positive.optional() });
export interface BitgetTickerEvidence {
  instrumentId: string; sourceTimestampMs: number; openInterest?: string; platformTurnover24h?: string;
  turnover24h?: string; markPrice?: string; fundingRate?: string;
}
export interface BitgetMappedMessages { events: RawVenueEvent[]; evidence: BitgetTickerEvidence[] }
export function mapBitgetTickers(input: unknown, instruments: readonly Instrument[], transport: RawVenueEvent["transport"] = "rest"): BitgetMappedMessages {
  return safe(() => {
    const result: BitgetMappedMessages = { events: [], evidence: [] };
    for (const raw of z.array(z.unknown()).parse(response.parse(input).data)) {
      const identity = z.object({ symbol: text, category: text }).parse(raw);
      const instrument = instruments.find(i => i.venueSymbol === identity.symbol && i.venueFamily === identity.category);
      if (!instrument) continue;
      const row = tickerRow.parse(raw);
      result.evidence.push({ instrumentId: instrument.instrumentId, sourceTimestampMs: row.ts,
        ...(row.openInterest === undefined ? {} : { openInterest: row.openInterest }),
        ...(row.platformTurnover24h === undefined ? {} : { platformTurnover24h: row.platformTurnover24h }),
        ...(row.turnover24h === undefined ? {} : { turnover24h: row.turnover24h }),
        ...(row.markPrice === undefined ? {} : { markPrice: row.markPrice }),
        ...(row.fundingRate === undefined ? {} : { fundingRate: row.fundingRate }),
      });
      const price = row.indexPrice ?? row.lastPrice;
      if (price) result.events.push(event(instrument, raw, row.ts, { kind: "index_price", price }, transport,
        row.indexPrice ? [] : ["last_trade_reference"]));
      if (instrument.productType === "perpetual" && row.fundingRate !== undefined && row.nextFundingTime !== undefined) {
        result.events.push(event(instrument, raw, row.ts, { kind: "funding", rateType: "current", rate: row.fundingRate,
          intervalMs: instrument.fundingInterval, nextSettlementMs: row.nextFundingTime }, transport));
      }
    }
    return result;
  });
}

export function mapBitgetMessage(input: unknown, instruments: readonly Instrument[]): BitgetMappedMessages {
  return safe(() => {
    if (input === "pong") return { events: [], evidence: [] };
    const raw = typeof input === "string" ? parseBitgetJson(input) : input;
    if (raw && typeof raw === "object" && (raw as {event?:unknown}).event === "subscribe") return { events: [], evidence: [] };
    const frame = z.object({ arg: z.object({ instType: text, symbol: text, topic: z.enum(["books5", "ticker"]) }),
      action: z.literal("snapshot"), data: z.array(z.record(z.string(), z.unknown())).min(1), ts: timestamp }).parse(raw);
    const instrument = instruments.find(i => i.venueFamily?.toLowerCase() === frame.arg.instType && i.venueSymbol === frame.arg.symbol);
    if (!instrument) throw new Error();
    if (frame.arg.topic === "books5") return { events: frame.data.map(row => mapBitgetBook({ code: "00000", data: row }, instrument, "websocket")), evidence: [] };
    return mapBitgetTickers({ code: "00000", data: frame.data.map(row => ({ ...row, category: instrument.venueFamily, symbol: instrument.venueSymbol, ts: row.ts ?? frame.ts })) }, [instrument], "websocket");
  });
}
