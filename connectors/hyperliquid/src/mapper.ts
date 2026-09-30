import { createHash } from "node:crypto";
import { CanonicalObservationPayloadSchema, InstrumentSchema, type Instrument } from "@range/domain";
import { ConnectorDiagnosticError, visibleCapacityUsd, type RawVenueEvent } from "@range/connector-sdk";
import { z } from "zod";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const nonnegative = decimal.refine(value => !value.startsWith("-"));
const positive = nonnegative.refine(value => /[1-9]/.test(value));
const text = z.string().trim().min(1);
const epochMs = z.number().int().safe().min(1_000_000_000_000);
const equityCategories = new Set(["equity", "equities", "stock", "stocks"]);

/**
 * trade.xyz equity perpetuals reviewed against its specifications (docs/reviews/2026-09-30-bitget-hyperliquid.md):
 * USDC collateral, size in shares, continuous trading (external prices Sunday 8 PM to Friday 8 PM ET, the venue's
 * own book otherwise), and Hyperliquid's $10 minimum order. Their books carry no quality flags.
 */
export const REVIEWED_EQUITY_PERPS: ReadonlySet<string> = new Set([
  "xyz:NVDA", "xyz:TSLA", "xyz:AAPL", "xyz:MSFT", "xyz:META", "xyz:AMZN", "xyz:GOOGL", "xyz:COIN", "xyz:MSTR", "xyz:HOOD",
]);

const categoryRows = z.array(z.tuple([text, text]));
const universeRow = z.object({
  name: text,
  szDecimals: z.number().int().min(0).max(18),
  maxLeverage: z.number().positive(),
  isDelisted: z.boolean().optional(),
  marginMode: z.string().optional(),
  onlyIsolated: z.boolean().optional(),
  growthMode: z.string().optional(),
});
const contextRow = z.object({
  funding: decimal,
  openInterest: nonnegative,
  markPx: positive,
  oraclePx: positive,
  midPx: positive.nullable().optional(),
  impactPxs: z.tuple([positive, positive]).nullable().optional(),
  premium: decimal.nullable().optional(),
  dayNtlVlm: nonnegative.optional(),
  prevDayPx: positive.optional(),
});
const metaAndContexts = z.tuple([
  z.object({
    universe: z.array(universeRow),
    collateralToken: z.number().int().nonnegative(),
  }),
  z.array(contextRow),
]);

const dexDescriptor = z.object({
  name: text,
  fullName: text,
  deployer: text,
  oracleUpdater: text.nullable().optional(),
  feeRecipient: text.nullable().optional(),
  assetToStreamingOiCap: z.array(z.tuple([text, nonnegative])).optional(),
  assetToFundingMultiplier: z.array(z.tuple([text, nonnegative])).optional(),
});

export type HyperliquidDexEvidence = z.infer<typeof dexDescriptor>;

export function mapPerpDexs(input: unknown): HyperliquidDexEvidence[] {
  return safe(() => z.array(dexDescriptor.nullable()).parse(input).filter(
    (row): row is HyperliquidDexEvidence => row !== null,
  ));
}

export interface HyperliquidMarketEvidence {
  readonly venueSymbol: string;
  readonly dex: string;
  readonly markPx: string;
  readonly oraclePx: string;
  readonly midPx?: string;
  readonly impactPxs?: readonly [string, string];
  readonly currentFunding: string;
  readonly openInterest: string;
  readonly observedAtMs: number;
  readonly timestampProvenance: "client_receipt";
  readonly researchOnly: true;
  readonly canonicalBlockReason: "SETTLEMENT_SCHEDULE_UNAVAILABLE";
}

export interface HyperliquidInstrumentMetadata {
  readonly [key: string]: string | number;
  readonly dex: string;
  readonly category: string;
  readonly evidenceSource: "perpCategories";
  readonly collateralTokenIndex: number;
}

/** HIP-3 discovery metadata remains typed after crossing the canonical adapter boundary. */
export type HyperliquidMappedInstrument = Instrument & {
  readonly metadata: HyperliquidInstrumentMetadata;
};

export interface HyperliquidMappedMarket {
  readonly instruments: HyperliquidMappedInstrument[];
  readonly evidence: HyperliquidMarketEvidence[];
}

function safe<T>(operation: () => T): T {
  try { return operation(); }
  catch { throw new ConnectorDiagnosticError("ADAPTER_FAILURE"); }
}

function decimalStep(places: number): string {
  return places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`;
}

function stripDexPrefix(symbol: string, dex: string): string | undefined {
  const prefix = `${dex}:`;
  if (!symbol.startsWith(prefix) || symbol.length === prefix.length) return undefined;
  return symbol.slice(prefix.length);
}

/**
 * Only an explicit equity category from `perpCategories` may create an equity
 * underlying. The coin text itself is never sufficient evidence.
 */
export function mapMetaAndContexts(
  input: unknown,
  dex: string,
  categoriesInput: unknown,
  observedAtMs: number,
): HyperliquidMappedMarket {
  return safe(() => {
    const [meta, contexts] = metaAndContexts.parse(input);
    if (contexts.length !== meta.universe.length || !Number.isSafeInteger(observedAtMs) || observedAtMs < 1_000_000_000_000) {
      throw new Error();
    }
    const categories = new Map(categoryRows.parse(categoriesInput));
    const instruments: HyperliquidMappedInstrument[] = [];
    const evidence: HyperliquidMarketEvidence[] = [];
    for (const [index, row] of meta.universe.entries()) {
      const ctx = contexts[index]!;
      const category = categories.get(row.name);
      const ticker = stripDexPrefix(row.name, dex);
      if (row.isDelisted || !ticker || !category || !equityCategories.has(category.toLowerCase())) continue;
      const underlyingHint = `equity:${ticker}`;
      const metadata: HyperliquidInstrumentMetadata = {
        dex,
        category,
        evidenceSource: "perpCategories",
        collateralTokenIndex: meta.collateralToken,
      };
      const reviewed = REVIEWED_EQUITY_PERPS.has(row.name);
      const capabilities = [
        "perpetual",
        "orderbook",
        "equity_perpetual",
        `dex=${dex}`,
        `perp_category=${category}`,
        "stock_underlying_evidence=perpCategories",
        "dynamic_tick_size",
        ...(reviewed ? ["reviewed_equity_perp", "trading_schedule=continuous_venue_stated"] : ["minimum_notional_unverified", "trading_schedule_unverified"]),
        `collateral_token_index=${meta.collateralToken}`,
      ];
      const canonical = InstrumentSchema.parse({
        instrumentId: `ins_hyperliquid_hip3_${row.name}`,
        underlyingId: underlyingHint,
        productType: "perpetual",
        venue: "hyperliquid_hip3",
        venueFamily: "hyperliquid",
        venueSymbol: row.name,
        quoteAsset: "USD",
        settlementAsset: `hyperliquid:spot-token:${meta.collateralToken}`,
        collateralAsset: `hyperliquid:spot-token:${meta.collateralToken}`,
        contractMultiplier: "1",
        // Hyperliquid has magnitude-dependent ticks; this is the finest decimal
        // increment allowed by szDecimals and is explicitly flagged as dynamic.
        tickSize: decimalStep(Math.max(0, 6 - row.szDecimals)),
        lotSize: decimalStep(row.szDecimals),
        // Hyperliquid rejects orders under $10; only reviewed markets state it, the rest keep it unverified.
        minimumNotional: reviewed ? "10" : "0",
        tradingSchedule: {
          timezone: "UTC",
          sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }],
        },
        fundingInterval: 3_600_000,
        capabilities,
        metadata,
        metadataVersion: 1,
        effectiveFrom: new Date(observedAtMs).toISOString(),
      });
      instruments.push({
        ...canonical,
        metadata,
      });
      evidence.push({
        venueSymbol: row.name,
        dex,
        markPx: ctx.markPx,
        oraclePx: ctx.oraclePx,
        ...(ctx.midPx == null ? {} : { midPx: ctx.midPx }),
        ...(ctx.impactPxs == null ? {} : { impactPxs: ctx.impactPxs }),
        currentFunding: ctx.funding,
        openInterest: ctx.openInterest,
        observedAtMs,
        timestampProvenance: "client_receipt",
        researchOnly: true,
        canonicalBlockReason: "SETTLEMENT_SCHEDULE_UNAVAILABLE",
      });
    }
    return { instruments, evidence };
  });
}

const HOUR_MS = 3_600_000;

/**
 * The current hourly funding of followed instruments on one HIP-3 dex, from its asset contexts. Hyperliquid settles
 * funding every hour, but the API states no settlement time, so the next full hour stands in; a dex-declared funding
 * multiplier other than 1 is unverified. Contexts carry no timestamp, so receipt time stands in. All three are
 * flagged, and the data is reference only: it never feeds actionable results.
 */
export function mapHyperliquidFunding(
  input: unknown,
  dex: string,
  instruments: readonly Instrument[],
  receivedAtMs: number,
  fundingMultipliers: ReadonlyMap<string, string> = new Map(),
): RawVenueEvent[] {
  return safe(() => {
    const [meta, contexts] = metaAndContexts.parse(input);
    if (contexts.length !== meta.universe.length || !Number.isSafeInteger(receivedAtMs) || receivedAtMs < 1_000_000_000_000) {
      throw new Error();
    }
    const bySymbol = new Map(meta.universe.map((row, index) => [row.name, contexts[index]!]));
    const nextSettlementMs = (Math.floor(receivedAtMs / HOUR_MS) + 1) * HOUR_MS;
    return instruments.flatMap((instrument): RawVenueEvent[] => {
      const ctx = bySymbol.get(instrument.venueSymbol);
      const asset = stripDexPrefix(instrument.venueSymbol, dex);
      if (!ctx || !asset) return [];
      const multiplier = fundingMultipliers.get(asset);
      const qualityFlags = ["client_receipt_timestamp", "hourly_settlement_assumed"];
      if (multiplier !== undefined && Number(multiplier) !== 1) qualityFlags.push("funding_multiplier_unverified");
      const raw = { coin: instrument.venueSymbol, funding: ctx.funding };
      const rawPayloadRefOrHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
      return [{
        eventId: `evt_hyperliquid_${instrument.instrumentId}_funding_${receivedAtMs}_${rawPayloadRefOrHash.slice(0, 16)}`,
        instrumentId: instrument.instrumentId,
        sourceTimestampMs: receivedAtMs,
        transport: "rest",
        freshnessBudgetMs: 120_000,
        qualityFlags,
        rawPayloadRefOrHash,
        eligibility: "reference_only",
        payload: CanonicalObservationPayloadSchema.parse({ kind: "funding", rateType: "predicted", rate: ctx.funding,
          positiveRatePayer: "long", intervalMs: HOUR_MS, nextSettlementMs }),
      }];
    });
  });
}

const bookLevel = z.object({ px: positive, sz: nonnegative, n: z.number().int().nonnegative() });
const book = z.object({
  coin: text,
  time: epochMs,
  levels: z.tuple([z.array(bookLevel), z.array(bookLevel)]),
});

function rawEvent(
  instrument: Instrument,
  raw: unknown,
  sourceTimestampMs: number,
  payload: RawVenueEvent["payload"],
  transport: RawVenueEvent["transport"],
): RawVenueEvent {
  const rawPayloadRefOrHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  // A reviewed market's book carries no flags: its schedule is verified, and tick size does not affect a quote.
  const reviewed = instrument.capabilities.includes("reviewed_equity_perp");
  return {
    eventId: `evt_hyperliquid_${instrument.instrumentId}_${payload.kind}_${sourceTimestampMs}_${rawPayloadRefOrHash.slice(0, 16)}`,
    instrumentId: instrument.instrumentId,
    sourceTimestampMs,
    transport,
    freshnessBudgetMs: 5_000,
    qualityFlags: reviewed ? [] : ["dynamic_tick_size", "trading_schedule_unverified"],
    rawPayloadRefOrHash,
    eligibility: "live",
    payload: CanonicalObservationPayloadSchema.parse(payload),
  };
}

export function mapHyperliquidBook(
  input: unknown,
  instrument: Instrument,
  transport: RawVenueEvent["transport"] = "rest",
): RawVenueEvent {
  return safe(() => {
    const row = book.parse(input);
    if (row.coin !== instrument.venueSymbol) throw new Error();
    const levels = (rows: z.infer<typeof bookLevel>[]) => rows.map(level => ({ price: level.px, quantity: level.sz }));
    const bids = levels(row.levels[0]);
    const asks = levels(row.levels[1]);
    return rawEvent(instrument, input, row.time, { kind: "order_book", bids, asks, capacityUsd: visibleCapacityUsd(bids, asks) }, transport);
  });
}

const fundingHistoryRow = z.object({
  coin: text,
  fundingRate: decimal,
  premium: decimal,
  time: epochMs,
});

export interface HyperliquidFundingEvidence {
  readonly venueSymbol: string;
  readonly fundingRate: string;
  readonly premium: string;
  readonly sourceTimestampMs: number;
  readonly rateType: "realized";
  readonly timestampProvenance: "venue_source";
  readonly researchOnly: true;
  readonly canonicalBlockReason: "PENDING_FUNDING_NORMALIZER";
}

export function mapFundingHistory(input: unknown, venueSymbol: string): HyperliquidFundingEvidence[] {
  return safe(() => z.array(fundingHistoryRow).parse(input).map(row => {
    if (row.coin !== venueSymbol) throw new Error();
    return {
      venueSymbol: row.coin,
      fundingRate: row.fundingRate,
      premium: row.premium,
      sourceTimestampMs: row.time,
      rateType: "realized" as const,
      timestampProvenance: "venue_source" as const,
      researchOnly: true as const,
      canonicalBlockReason: "PENDING_FUNDING_NORMALIZER" as const,
    };
  }));
}

export function mapHyperliquidMessage(input: unknown, instruments: readonly Instrument[]): RawVenueEvent | undefined {
  return safe(() => {
    if (input && typeof input === "object" && (input as { channel?: unknown }).channel === "pong") return undefined;
    const envelope = z.object({ channel: text, data: z.unknown() }).parse(input);
    if (envelope.channel === "subscriptionResponse" || envelope.channel === "pong") return undefined;
    if (envelope.channel !== "l2Book") throw new Error();
    const identity = z.object({ coin: text }).parse(envelope.data);
    const instrument = instruments.find(item => item.venueSymbol === identity.coin);
    if (!instrument) throw new Error();
    return mapHyperliquidBook(envelope.data, instrument, "websocket");
  });
}
