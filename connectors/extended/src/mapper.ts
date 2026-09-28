import { createHash } from "node:crypto";
import { CanonicalObservationPayloadSchema, InstrumentSchema, type Instrument } from "@range/domain";
import { ConnectorDiagnosticError, isEpochMilliseconds, type RawVenueEvent } from "@range/connector-sdk";
import { z } from "zod";

const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const nonnegative = decimal.refine(value => !value.startsWith("-"));
const positive = nonnegative.refine(value => /[1-9]/.test(value));
const text = z.string().trim().min(1);
const response = z.object({ status: z.literal("OK"), data: z.unknown() });

/**
 * Equity symbols explicitly listed by Extended's official RWA Markets page on
 * 2026-09-22. This is classification evidence only; availability is still
 * discovered from the API response and never hard-coded.
 */
const OFFICIAL_EXTENDED_EQUITIES = new Set([
  "NVDA", "MSTR", "MU", "SNDK", "TSM", "ASML", "AVGO", "ARM", "MRVL", "NBIS", "CRWV", "STXX",
  "DELL", "WDC", "QCOM", "RKLB", "SKHYNIX", "LITE", "CBRS", "SAMSUNG", "NOK", "BE", "USAR", "QNT",
  "IBM", "BB", "AAOI", "AXTI", "COHR", "BMNR", "FLNC", "ASTS", "PURR", "SPCX", "INTC", "CRCL",
  "TSLA", "AMD", "GOOGL", "HOOD", "COIN", "META", "ORCL", "AAPL", "MSFT", "BABA", "AMZN", "PLTR",
  "XIAOMI", "AMAT", "GLW", "KIOXIA", "MINIMAX", "UNITREE", "MRNA", "NFLX", "SKHY", "SMCI", "WMT",
  "IREN", "KLAC", "PDD", "APP", "ON", "RGTI", "LRCX", "ALAB", "CRWD", "CSCO", "TER", "ADBE", "CRDO",
  "MCHP", "GFS", "SNPS", "DDOG", "LIN", "MARA", "RIOT", "CLSK", "TTD", "AXON", "TTWO", "MELI",
  "VRTX", "SHOP", "BKNG", "STLD", "CDNS", "CEG", "HON", "XEL", "REGN", "GEHC", "TMUS", "ISRG",
  "NXPI", "ADSK", "ODFL", "CDW", "FANG", "SBUX", "ADI", "AMGN", "COST", "INTU", "TXN", "MPWR", "SOFI",
]);

const marketStats = z.object({
  fundingRate: decimal,
  nextFundingRate: z.number().finite().nonnegative(),
  openInterest: nonnegative,
  openInterestBase: nonnegative.optional(),
}).passthrough();

const tradingConfig = z.object({
  minOrderSize: positive,
  minOrderSizeChange: positive,
  minPriceChange: positive,
}).passthrough();

const marketRow = z.object({
  name: text,
  type: z.enum(["PERPETUAL", "SPOT"]),
  assetName: text,
  collateralAssetName: text,
  active: z.boolean(),
  status: text,
  isRfq: z.boolean(),
  isOffHours: z.boolean(),
  tradingHours: z.enum(["CONTINUOUS", "WEEKDAYS", "NO_OVERNIGHT", "REGULAR"]),
  marketStats,
  tradingConfig,
}).passthrough();

export interface ExtendedMarketEvidence {
  readonly venueSymbol: string;
  readonly assetName: string;
  readonly assetClass: "equity";
  readonly evidenceSource: "extended_official_rwa_markets";
  readonly fundingRate: string;
  readonly providerNextFundingValue: number;
  readonly openInterestUsd: string;
  readonly isRfq: boolean;
  readonly isOffHours: boolean;
  readonly tradingHours: "CONTINUOUS" | "WEEKDAYS" | "NO_OVERNIGHT" | "REGULAR";
  readonly researchOnly: true;
  readonly canonicalBlockReason: "NO_CANONICAL_MARKET_STATS_EVENT_PATH";
}

export interface ExtendedMappedMarkets {
  readonly instruments: Instrument[];
  readonly evidence: ExtendedMarketEvidence[];
}

function safe<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof ConnectorDiagnosticError) throw error;
    throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  }
}

function tradingSchedule(value: z.infer<typeof marketRow>["tradingHours"]) {
  if (value === "CONTINUOUS") {
    return { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] };
  }
  return { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5], opensAt: "00:00", closesAt: "23:59" }] };
}

export function mapExtendedMarkets(input: unknown, observedAtMs: number): ExtendedMappedMarkets {
  return safe(() => {
    if (!isEpochMilliseconds(observedAtMs)) throw new Error();
    const instruments: Instrument[] = [];
    const evidence: ExtendedMarketEvidence[] = [];
    for (const row of z.array(marketRow).parse(response.parse(input).data)) {
      if (row.type !== "PERPETUAL" || !row.active || row.status !== "ACTIVE") continue;
      if (!OFFICIAL_EXTENDED_EQUITIES.has(row.assetName)) continue;
      const capabilities = [
        "perpetual",
        "tokenized_stock",
        "orderbook",
        "orderbook_reference_only",
        "explicit_equity_evidence",
        "market_stats_research_only",
        row.isRfq ? "rfq_real_book_stream" : "central_limit_order_book",
        `trading_hours=${row.tradingHours}`,
      ];
      if (row.tradingHours !== "CONTINUOUS") {
        capabilities.push("holiday_calendar_unmodeled", "session_state_requires_refresh");
      }
      if (row.isOffHours) capabilities.push("market_off_hours");
      const marketEvidence: ExtendedMarketEvidence = {
        venueSymbol: row.name,
        assetName: row.assetName,
        assetClass: "equity",
        evidenceSource: "extended_official_rwa_markets",
        fundingRate: row.marketStats.fundingRate,
        providerNextFundingValue: row.marketStats.nextFundingRate,
        openInterestUsd: row.marketStats.openInterest,
        isRfq: row.isRfq,
        isOffHours: row.isOffHours,
        tradingHours: row.tradingHours,
        researchOnly: true,
        canonicalBlockReason: "NO_CANONICAL_MARKET_STATS_EVENT_PATH",
      };
      evidence.push(marketEvidence);
      instruments.push(InstrumentSchema.parse({
        instrumentId: `ins_extended_${row.name}`,
        underlyingId: `equity:${row.assetName}`,
        venue: "extended",
        venueFamily: "extended",
        venueSymbol: row.name,
        productType: "perpetual",
        quoteAsset: row.collateralAssetName,
        settlementAsset: "USDC",
        collateralAsset: "USDC",
        contractMultiplier: "1",
        tickSize: row.tradingConfig.minPriceChange,
        lotSize: row.tradingConfig.minOrderSizeChange,
        minimumNotional: "0",
        tradingSchedule: tradingSchedule(row.tradingHours),
        capabilities,
        metadata: {
          assetClass: "equity",
          equityEvidenceSource: "extended_official_rwa_markets",
          marketType: row.type,
          isRfq: row.isRfq,
          isOffHours: row.isOffHours,
          tradingHours: row.tradingHours,
          researchOnlyMarketStats: {
            fundingRate: row.marketStats.fundingRate,
            providerNextFundingValue: row.marketStats.nextFundingRate,
            openInterestUsd: row.marketStats.openInterest,
          },
        },
        metadataVersion: 1,
        effectiveFrom: new Date(observedAtMs).toISOString(),
        fundingInterval: 3_600_000,
      }));
    }
    return { instruments, evidence };
  });
}

function isRfq(instrument: Instrument): boolean {
  return instrument.metadata?.isRfq === true;
}

function isOffHours(instrument: Instrument): boolean {
  return instrument.metadata?.isOffHours === true;
}

function isContinuous(instrument: Instrument): boolean {
  return instrument.metadata?.tradingHours === "CONTINUOUS";
}

function rawEvent(
  instrument: Instrument,
  raw: unknown,
  sourceTimestampMs: number,
  transport: RawVenueEvent["transport"],
  bids: { price: string; quantity: string }[],
  asks: { price: string; quantity: string }[],
  sequence: number | undefined,
  bookKind: "rest" | "standard" | "rfq_real",
): RawVenueEvent {
  const rawPayloadRefOrHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const isValidatedRfqStream = sequence !== undefined && bookKind === "rfq_real";
  const qualityFlags = ["explicit_equity_evidence", "capacity_usd_uncomputed"];
  if (bookKind === "rest") qualityFlags.push("client_receipt_timestamp", "reference_book");
  else qualityFlags.push("book_update_mode_ambiguous");
  if (bookKind === "rest" && isRfq(instrument)) qualityFlags.push("rfq_indicative_book");
  if (bookKind === "rfq_real") qualityFlags.push("rfq_real_book");
  if (isOffHours(instrument)) qualityFlags.push("market_off_hours");
  if (!isContinuous(instrument)) qualityFlags.push("non_continuous_schedule", "session_state_requires_refresh");
  if (isValidatedRfqStream) qualityFlags.push("sequence_validated");
  return {
    eventId: `evt_extended_${instrument.instrumentId}_order_book_${sourceTimestampMs}_${rawPayloadRefOrHash.slice(0, 16)}`,
    instrumentId: instrument.instrumentId,
    sourceTimestampMs,
    ...(sequence === undefined ? {} : { sequence }),
    ...(isValidatedRfqStream ? { sequencePolicy: "contiguous" as const } : {}),
    transport,
    freshnessBudgetMs: 5_000,
    qualityFlags,
    rawPayloadRefOrHash,
    eligibility: "reference_only",
    payload: CanonicalObservationPayloadSchema.parse({ kind: "order_book", bids, asks, capacityUsd: "0" }),
  };
}

const restLevel = z.object({ price: positive, qty: nonnegative }).strict();
const restBook = z.object({ market: text, bid: z.array(restLevel), ask: z.array(restLevel) }).strict();

export function mapExtendedRestBook(input: unknown, instrument: Instrument, observedAtMs: number): RawVenueEvent {
  return safe(() => {
    if (!isEpochMilliseconds(observedAtMs)) throw new Error();
    const book = restBook.parse(response.parse(input).data);
    if (book.market !== instrument.venueSymbol) throw new Error();
    const levels = (rows: z.infer<typeof restLevel>[]) => rows.map(row => ({ price: row.price, quantity: row.qty }));
    return rawEvent(instrument, input, observedAtMs, "rest", levels(book.bid), levels(book.ask), undefined, "rest");
  });
}

// q is absolute in a snapshot but a signed change in a delta; c is the absolute size. Live snapshots omit c.
const streamLevel = z.object({ p: positive, q: decimal, c: nonnegative.optional() }).strict();
const streamFrame = z.object({
  ts: z.number().int().nonnegative(),
  type: z.enum(["SNAPSHOT", "DELTA"]),
  data: z.object({
    m: text, b: z.array(streamLevel), a: z.array(streamLevel),
    t: z.enum(["SNAPSHOT", "DELTA"]).optional(),
    // Undocumented; live full-depth subscriptions send "f". Other depth modes are not reconstructed here.
    d: z.literal("f").optional(),
  }).strict(),
  seq: z.number().int().nonnegative().safe(),
}).strict().refine(frame => frame.data.t === undefined || frame.data.t === frame.type);

export function extendedFrameMarket(input: unknown): string {
  return safe(() => streamFrame.parse(input).data.m);
}

function sortedLevels(levels: Map<string, string>, side: "bid" | "ask") {
  return [...levels].map(([price, quantity]) => ({ price, quantity })).sort((left, right) => {
    const difference = Number(left.price) - Number(right.price);
    return side === "ask" ? difference : -difference;
  });
}

export class ExtendedBookStreamMapper {
  private sequence: number | undefined;
  private readonly bids = new Map<string, string>();
  private readonly asks = new Map<string, string>();

  constructor(private readonly instrument: Instrument) {}

  map(input: unknown): RawVenueEvent {
    return safe(() => {
      const frame = streamFrame.parse(input);
      if (!isEpochMilliseconds(frame.ts) || frame.data.m !== this.instrument.venueSymbol) throw new Error();
      if (this.sequence === undefined) {
        if (frame.type !== "SNAPSHOT" || frame.seq !== 1) throw new Error();
      } else if (frame.seq !== this.sequence + 1) {
        if (isRfq(this.instrument)) throw new ConnectorDiagnosticError("SEQUENCE_GAP");
        throw new Error();
      }
      if (frame.type === "SNAPSHOT") {
        this.bids.clear();
        this.asks.clear();
      }
      const apply = (target: Map<string, string>, rows: z.infer<typeof streamLevel>[]) => {
        for (const row of rows) {
          const size = row.c ?? (frame.type === "SNAPSHOT" ? nonnegative.parse(row.q) : undefined);
          if (size === undefined) throw new Error();
          if (/^0(?:\.0+)?$/.test(size)) target.delete(row.p);
          else target.set(row.p, size);
        }
      };
      apply(this.bids, frame.data.b);
      apply(this.asks, frame.data.a);
      this.sequence = frame.seq;
      return rawEvent(
        this.instrument,
        input,
        frame.ts,
        "websocket",
        sortedLevels(this.bids, "bid"),
        sortedLevels(this.asks, "ask"),
        frame.seq,
        isRfq(this.instrument) ? "rfq_real" : "standard",
      );
    });
  }
}
