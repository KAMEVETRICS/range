import { newDb } from "pg-mem";
import { OpportunitySchema, ObservationEnvelopeSchema, InstrumentSchema, VenueHealthSchema, EvidenceBundleSchema } from "@range/domain";
import { RangeApplication } from "./service.js";
import type { ApplicationQueries } from "./queries.js";

export const instant = Date.parse("2026-09-24T12:00:00Z");
export const caller = { clientId: "alice", traceId: "rng_trace_test", scopes: ["intent:create"] };
export const request = { opportunityId: "opp_spread", requestedNotionalUsd: "5000", idempotencyKey: "idem_1" };
/** `reviewedBitget` files the Bitget instrument as production does: under its venue's own underlying (bitget:TSLA),
 * without an orderbook capability, joined to equity:TSLA only by the reviewed mapping in the pair snapshot. Without
 * `reviewed`, that mapping is missing. */
export async function intentFixture(strategy = "perp_spread", options: { reviewedBitget?: boolean; reviewed?: boolean } = {}) {
  let now = instant, revision = 7;
  const bitgetOwn = options.reviewedBitget === true;
  const instruments = ["bitget", "hyperliquid_hip3"].map((venue, i) => InstrumentSchema.parse({
    instrumentId: `ins_${i}`, underlyingId: bitgetOwn && i === 0 ? "bitget:TSLA" : "equity:TSLA", venue, venueSymbol: "TSLA",
    quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD",
    contractMultiplier: "1", tickSize: "0.01", lotSize: "0.00000001", minimumNotional: "1", metadataVersion: 1,
    effectiveFrom: new Date(instant - 10000).toISOString(),
    capabilities: bitgetOwn && i === 0 ? ["perpetual", "reviewed_stock_perp", "funding"] : ["orderbook", "funding"],
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
    ...(strategy === "spot_perp_basis" && i === 0 ? { productType: "tokenized_spot" } : { productType: "perpetual", fundingInterval: 3600000 }),
  }));
  const observations = instruments.flatMap((instrument, i) => {
    const base = { schemaVersion: 1, venue: instrument.venue, instrumentId: instrument.instrumentId, sourceTimestamp: instant,
      receivedTimestamp: instant, transport: "rest", freshnessBudgetMs: 60000, qualityFlags: [], rawPayloadRefOrHash: "private-locator", eligibility: "live" };
    return [ObservationEnvelopeSchema.parse({ ...base, eventId: `evt_book${i}`, payload: { kind: "order_book", bids: [{ price: i ? "102" : "99", quantity: "100" }],
      asks: [{ price: i ? "103" : "100", quantity: "100" }], capacityUsd: "10000" } }),
    ...(instrument.productType === "perpetual" ? [ObservationEnvelopeSchema.parse({ ...base, eventId: `evt_funding${i}`, payload: {
      kind: "funding", rateType: "current", rate: "0.001", positiveRatePayer: "long", intervalMs: 3600000, nextSettlementMs: instant + 60000,
    } })] : [])];
  });
  let opportunity = OpportunitySchema.parse({ opportunityId: "opp_spread", stateRevision: 7, underlyingId: "equity:TSLA", strategy,
    legs: instruments.map((instrument, i) => ({ legId: `leg_${i}`, instrumentId: instrument.instrumentId, side: i ? "sell" : "buy", executableQuote: {
      side: i ? "sell" : "buy", requestedNotional: "1000", averagePrice: i ? "102" : "100", worstPrice: i ? "102" : "100", filledQuantity: "10",
      capacityUsd: "1200", depthUtilization: "0.5", sourceBookEventId: `evt_book${i}`, ageMs: 0,
    } })), status: "actionable", rejectionReasons: [], grossSpreadBps: "200", expectedFundingBps: "0", tradingFeesBps: "2", slippageBps: "0",
    financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "1", netEdgeBps: "197", capacityUsd: "1200",
    expiresAt: new Date(instant + 60000).toISOString(), evidenceHash: `sha256:${"a".repeat(64)}`,
    freshness: { oldestInputMs: 0, synchronized: true, eligibility: "live", qualityFlags: [] } });
  const evidence = EvidenceBundleSchema.parse({ evidenceHash: opportunity.evidenceHash, calculationVersion: "v1",
    sourceEventIds: observations.map(item => item.eventId), canonicalMappingVersions: {}, intermediateValues: {}, warnings: ["non_atomic_fills"], assumptions: {
      holdingHorizonMs: { kind: "integer", value: 120000 }, minNetEdgeBps: { kind: "decimal", value: "1" },
      synchronizationBudgetMs: { kind: "integer", value: 1000 }, maxClockSkewMs: { kind: "integer", value: 1000 },
    } });
  const observationTimestamps = new Map<string, { eventId: string; sourceTimestampMs: number; receivedTimestampMs: number }>(observations.map(item => [item.eventId, {
    eventId: item.eventId,
    sourceTimestampMs: item.sourceTimestamp,
    receivedTimestampMs: item.receivedTimestamp,
  }]));
  const queries: ApplicationQueries = {
    async listVenues() { return instruments.map(item => ({ venue: item.venue as "bitget", capabilities: ["orderbook", "funding"], freshnessBudgetMs: 60000, asOfMs: instant,
      health: VenueHealthSchema.parse({ venue: item.venue, connectionState: "connected", sequenceIntegrity: "consistent", lastEventAgeMs: 0,
        clockSkewMs: 0, rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} }) })); },
    // Like the stored queries, both read one underlying at a time.
    async findInstruments(_context, filter) { return instruments.filter(item => item.underlyingId === filter.underlying); },
    async getMarketSnapshot(_context, filter) {
      return observations.filter(item => instruments.find(instrument => instrument.instrumentId === item.instrumentId)?.underlyingId === filter.underlying);
    },
    async scanOpportunities() { return [opportunity]; },
    async inspectOpportunity(_context, id) { return id === opportunity.opportunityId && revision === opportunity.stateRevision ? opportunity : undefined; },
    async liveOpportunities() { return [opportunity]; },
    async recentOpportunity(_context, id) { return id === opportunity.opportunityId ? opportunity : undefined; },
    async getEvidence() { return evidence; }, async getSourceTimestamps(_context, ids) { return ids.flatMap(id => observationTimestamps.get(id) ?? []); },
    async getOpportunityHistory() { return []; }, async getAcceptedRevision() { return revision; }, async readEvents() { return []; }, async latestEventOrdinal() { return 0; }, async getMarketBoard() { return undefined; },
    async getPairEvaluations() {
      return bitgetOwn && options.reviewed !== false ? { asOfMs: now, pairs: [], mappings: [{ underlyingId: "equity:TSLA",
        members: instruments.map(item => ({ instrumentId: item.instrumentId, venue: item.venue, venueSymbol: item.venueSymbol, underlyingId: item.underlyingId })) }] }
        : undefined;
    },
  };
  const { Pool } = newDb().adapters.createPg();
  const sql = new Pool();
  await sql.query("CREATE TABLE intents (idempotency_key text PRIMARY KEY, opportunity_id text NOT NULL, evidence_hash text NOT NULL, expires_at timestamptz NOT NULL, payload jsonb NOT NULL)");
  return { application: new RangeApplication(queries, () => now), queries, sql, observations, instruments, evidence, now: () => now,
    setNow: (value: number) => now = value, setRevision: (value: number) => revision = value,
    changeOpportunity: (patch: Record<string, unknown>) => opportunity = OpportunitySchema.parse({ ...opportunity, ...patch }) };
}
