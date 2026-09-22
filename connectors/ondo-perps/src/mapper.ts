import { createHash } from "node:crypto";
import { z } from "zod";
import { CanonicalObservationPayloadSchema, InstrumentSchema, type Instrument } from "../../../packages/domain/src/index.js";
import { ConnectorDiagnosticError, type RawVenueEvent } from "../../../packages/connector-sdk/src/index.js";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const nonnegative = decimal.refine(value => !value.startsWith("-"));
const positive = nonnegative.refine(value => Number(value) > 0);
const text = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const envelope = <T extends z.ZodType>(result: T) => z.object({ success: z.literal(true), result });

const contractRow = z.object({
  market: text,
  productType: z.literal("perpetual"),
  contractType: z.literal("linear"),
  baseCurrency: text,
  quoteCurrency: text,
  disabled: z.boolean(),
  isClosed: z.boolean().optional(),
  tags: z.array(text),
  nextFundingRateTimestamp: timestamp.optional(),
}).passthrough();
const pairRow = z.object({ market: text, baseIncrement: positive, quoteIncrement: positive, tags: z.array(text).optional() }).passthrough();
const historyRow = z.object({ market: text, time: timestamp, fundingRate: decimal });
const fundingRow = z.object({ market: text, rate: decimal, intervalEnds: timestamp });
const oiRow = z.object({ market: text, openInterest: nonnegative, notionalValue: nonnegative });
const bookRow = z.object({
  market: text,
  time: timestamp,
  bids: z.array(z.tuple([positive, nonnegative])),
  asks: z.array(z.tuple([positive, nonnegative])),
});

function safe<T>(work: () => T): T {
  try { return work(); }
  catch { throw new ConnectorDiagnosticError("ADAPTER_FAILURE"); }
}

export function mapMarketCatalog(input: unknown): Map<string, z.infer<typeof pairRow>> {
  return safe(() => {
    const result = envelope(z.object({ perps: z.object({ tradingPairs: z.array(pairRow) }) })).parse(input).result;
    return new Map(result.perps.tradingPairs.map(pair => [pair.market, pair]));
  });
}

export function mapContracts(input: unknown): z.infer<typeof contractRow>[] {
  return safe(() => envelope(z.array(contractRow)).parse(input).result);
}

export function mapOndoPerpsMarket(
  rawContract: unknown,
  rawPair: unknown,
  observedIntervalMs: number,
  observedAtMs: number,
): Instrument {
  return safe(() => {
    const contract = contractRow.parse(rawContract);
    const pair = pairRow.parse(rawPair);
    if (contract.market !== pair.market || contract.disabled || contract.isClosed ||
        !contract.tags.includes("Stock") || !pair.market.endsWith("-USD.P") ||
        !Number.isSafeInteger(observedIntervalMs) || observedIntervalMs < 60_000) throw new Error();
    const base = pair.market.slice(0, -"-USD.P".length);
    if (base !== contract.baseCurrency || !Number.isSafeInteger(observedAtMs)) throw new Error();
    return InstrumentSchema.parse({
      instrumentId: `ins_ondo_perps_${contract.market}`,
      underlyingId: `equity:${base}`,
      productType: "perpetual",
      venue: "ondo_perps",
      venueFamily: "ondo",
      venueSymbol: contract.market,
      quoteAsset: contract.quoteCurrency,
      settlementAsset: "UNVERIFIED",
      collateralAsset: "UNVERIFIED",
      contractMultiplier: "1",
      tickSize: pair.quoteIncrement,
      lotSize: pair.baseIncrement,
      minimumNotional: "0",
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
      fundingInterval: observedIntervalMs,
      capabilities: ["perpetual", "orderbook_reference_only", "stock_underlying_evidence=venue_tag", "settlement_unverified", "collateral_unverified", "trading_schedule_unverified", "funding_interval_observed_history"],
      metadata: { tags: contract.tags, intervalSource: "three_recent_realized_settlements", intervalConfidence: "historical_only", minimumNotionalVerified: false, contractMultiplierVerified: false },
      metadataVersion: 1,
      effectiveFrom: new Date(observedAtMs).toISOString(),
    });
  });
}

export interface OndoFundingEvidence {
  readonly venueSymbol: string;
  readonly current: { readonly rateType: "predicted"; readonly rate: string; readonly nextSettlementMs: number };
  readonly history: readonly { readonly rateType: "realized"; readonly rate: string; readonly settledAtMs: number }[];
  readonly openInterest: { readonly contracts: string; readonly notionalUsd: string } | undefined;
  readonly observedIntervalMs: number | undefined;
  readonly researchOnly: true;
  readonly canonicalBlockReason: "NO_FUNDING_OR_OPEN_INTEREST_RUNTIME_EVENT_PATH";
}

export function mapFundingHistory(input: unknown, market: string): OndoFundingEvidence["history"] {
  return safe(() => envelope(z.array(historyRow)).parse(input).result.map(row => {
    if (row.market !== market) throw new Error();
    return { rateType: "realized" as const, rate: row.fundingRate, settledAtMs: Date.parse(row.time) };
  }));
}

export function observedFundingIntervalMs(history: OndoFundingEvidence["history"], nextSettlementMs: number): number | undefined {
  if (history.length < 3) return undefined;
  const times = history.slice(0, 3).map(row => row.settledAtMs);
  const first = times[0]! - times[1]!;
  const second = times[1]! - times[2]!;
  const rounded = Math.round(first / 60_000) * 60_000;
  if (rounded < 60_000 || rounded > 86_400_000) return undefined;
  if (Math.abs(first - rounded) > 60_000 || Math.abs(second - rounded) > 60_000) return undefined;
  if (Math.abs(nextSettlementMs - times[0]! - rounded) > 60_000) return undefined;
  return rounded;
}

export function mapFundingEvidence(
  fundingInput: unknown,
  historyInput: unknown,
  oiInput: unknown,
  market: string,
  observedAtMs: number,
): OndoFundingEvidence {
  return safe(() => {
    const funding = envelope(fundingRow).parse(fundingInput).result;
    if (funding.market !== market) throw new Error();
    const nextSettlementMs = Date.parse(funding.intervalEnds);
    if (nextSettlementMs <= observedAtMs) throw new Error();
    const history = mapFundingHistory(historyInput, market);
    const oi = envelope(z.array(oiRow)).parse(oiInput).result.find(row => row.market === market);
    return {
      venueSymbol: market,
      current: { rateType: "predicted", rate: funding.rate, nextSettlementMs },
      history,
      openInterest: oi && { contracts: oi.openInterest, notionalUsd: oi.notionalValue },
      observedIntervalMs: observedFundingIntervalMs(history, nextSettlementMs),
      researchOnly: true,
      canonicalBlockReason: "NO_FUNDING_OR_OPEN_INTEREST_RUNTIME_EVENT_PATH",
    };
  });
}

export function mapOndoPerpsDepth(input: unknown, instrument: Instrument): RawVenueEvent {
  return safe(() => {
    const row = envelope(bookRow).parse(input).result;
    if (row.market !== instrument.venueSymbol) throw new Error();
    const sourceTimestampMs = Date.parse(row.time);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return {
      eventId: `evt_ondo_perps_${instrument.venueSymbol}_${sourceTimestampMs}_${hash.slice(0, 16)}`,
      instrumentId: instrument.instrumentId,
      sourceTimestampMs,
      transport: "rest",
      freshnessBudgetMs: 5_000,
      qualityFlags: ["reference_only", "capacity_usd_uncomputed", "settlement_unverified", "trading_schedule_unverified"],
      rawPayloadRefOrHash: hash,
      eligibility: "reference_only",
      payload: CanonicalObservationPayloadSchema.parse({
        kind: "order_book",
        bids: row.bids.map(([price, quantity]) => ({ price, quantity })),
        asks: row.asks.map(([price, quantity]) => ({ price, quantity })),
        capacityUsd: "0",
      }),
    };
  });
}
