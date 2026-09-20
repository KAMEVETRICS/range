import { describe, expect, it } from "vitest";
import {
  EvidenceBundleSchema,
  ExecutableQuoteSchema,
  FundingProjectionSchema,
  InstrumentSchema,
  ObservationEnvelopeSchema,
  OpportunitySchema,
  UnsignedIntentSchema,
  VenueHealthSchema,
} from "./index.js";

const instrument = {
  instrumentId: "ins_hl_xyz_tsla",
  underlyingId: "equity:TSLA",
  productType: "perpetual",
  venue: "hyperliquid_hip3",
  venueFamily: "hyperliquid",
  venueSymbol: "xyz:TSLA",
  quoteAsset: "USD",
  settlementAsset: "USDC",
  collateralAsset: "USDC",
  contractMultiplier: "1",
  tickSize: "0.01",
  lotSize: "0.001",
  minimumNotional: "10",
  tradingSchedule: {
    timezone: "UTC",
    sessions: [{ daysOfWeek: [1, 2, 3, 4, 5], opensAt: "00:00", closesAt: "23:59" }],
  },
  fundingInterval: 28_800_000,
  capabilities: ["orderbook", "funding_current"],
  metadataVersion: 1,
  effectiveFrom: "2026-09-20T00:00:00.000Z",
};

const executableQuote = {
  side: "buy",
  requestedNotional: "1000",
  averagePrice: "201.25",
  worstPrice: "201.50",
  filledQuantity: "4.9689",
  capacityUsd: "25000",
  depthUtilization: "0.04",
  sourceBookEventId: "evt_book_1",
  ageMs: 84,
};

const fundingProjection = {
  rateType: "predicted",
  rate: "0.0001",
  intervalMs: 28_800_000,
  nextSettlementMs: 1_790_000_000_000,
  holdingHorizonMs: 86_400_000,
  expectedSettlements: 3,
  positionSide: "short",
  expectedCashflowBps: "3",
  sourceObservationIds: ["evt_funding_1"],
};

const opportunity = {
  opportunityId: "opp_1",
  strategy: "spot_perpetual_basis",
  underlyingId: "equity:TSLA",
  legs: [
    {
      legId: "leg_spot",
      instrumentId: "ins_ondo_tsla",
      side: "buy",
      executableQuote,
    },
    {
      legId: "leg_perp",
      instrumentId: instrument.instrumentId,
      side: "sell",
      executableQuote: { ...executableQuote, side: "sell" },
      fundingProjection,
    },
  ],
  grossSpreadBps: "31",
  expectedFundingBps: "3",
  tradingFeesBps: "8",
  slippageBps: "5",
  financingBps: "1",
  gasAndTransferBps: "0",
  fxConversionBps: "0",
  uncertaintyBufferBps: "2",
  netEdgeBps: "18",
  capacityUsd: "25000",
  freshness: {
    oldestInputMs: 84,
    synchronized: true,
    eligibility: "live",
    qualityFlags: [],
  },
  status: "actionable",
  expiresAt: "2026-09-20T00:00:02.000Z",
  evidenceHash: "sha256:evidence_1",
  rejectionReasons: [],
};

const evidenceBundle = {
  sourceEventIds: ["evt_book_1", "evt_funding_1"],
  calculationVersion: "calc.v1",
  canonicalMappingVersions: { "equity:TSLA": "map.v1" },
  assumptions: { holdingHorizonMs: { kind: "integer", value: 86_400_000 } },
  intermediateValues: { capacityUsd: { kind: "decimal", value: "25000" } },
  warnings: ["legs are non-atomic"],
  evidenceHash: "sha256:evidence_1",
};

const unsignedIntent = {
  opportunityId: "opp_1",
  constrainedNotionalUsd: "1000",
  derivedLegs: [
    {
      legId: "leg_spot",
      instrumentId: "ins_ondo_tsla",
      side: "buy",
      quantity: "4.9689",
      priceBounds: { minimum: "200", maximum: "202" },
    },
    {
      legId: "leg_perp",
      instrumentId: instrument.instrumentId,
      side: "sell",
      quantity: "4.9689",
      priceBounds: { minimum: "200", maximum: "202" },
    },
  ],
  createdAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-09-20T00:00:02.000Z",
  nonAtomicWarning: true,
  preflightChecks: ["freshness", "sequence_integrity"],
  evidenceHash: "sha256:evidence_1",
  idempotencyKey: "idem_1",
};

const venueHealth = {
  venue: "hyperliquid_hip3",
  connectionState: "connected",
  lastEventAgeMs: 84,
  clockSkewMs: 3,
  sequenceIntegrity: "consistent",
  rateLimit: { state: "healthy" },
  capabilityChanges: [],
  errorCounters: { reconnects: 0 },
};

describe("canonical schemas", () => {
  it("rejects a perpetual without a funding interval", () => {
    const { fundingInterval: _fundingInterval, ...perpetualWithoutFundingInterval } = instrument;
    expect(() => InstrumentSchema.parse(perpetualWithoutFundingInterval)).toThrow();
  });

  it("rejects actionable opportunities without evidence", () => {
    expect(() => OpportunitySchema.parse({
      opportunityId: "opp_1",
      status: "actionable",
      evidenceHash: "",
      legs: [],
    })).toThrow();
  });

  it("round-trips valid fixtures for every exported schema", () => {
    const fixtures = [
      [InstrumentSchema, instrument],
      [ObservationEnvelopeSchema, {
        eventId: "evt_book_1",
        schemaVersion: 1,
        venue: "hyperliquid_hip3",
        instrumentId: instrument.instrumentId,
        sourceTimestamp: 1_790_000_000_000,
        receivedTimestamp: 1_790_000_000_084,
        sequence: "42",
        transport: "websocket",
        freshnessBudgetMs: 500,
        qualityFlags: [],
        rawPayloadRefOrHash: "sha256:raw_1",
        eligibility: "live",
        payload: {
          kind: "order_book",
          bids: [{ price: "201.25", quantity: "5" }],
          asks: [{ price: "201.50", quantity: "4" }],
          capacityUsd: "25000",
        },
      }],
      [ExecutableQuoteSchema, executableQuote],
      [FundingProjectionSchema, fundingProjection],
      [OpportunitySchema, opportunity],
      [EvidenceBundleSchema, evidenceBundle],
      [UnsignedIntentSchema, unsignedIntent],
      [VenueHealthSchema, venueHealth],
    ] as const;

    for (const [schema, fixture] of fixtures) {
      expect(schema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
    }
  });

  it("rejects non-finite and numeric decimal values", () => {
    expect(() => ExecutableQuoteSchema.parse({ ...executableQuote, averagePrice: "NaN" })).toThrow();
    expect(() => ExecutableQuoteSchema.parse({ ...executableQuote, averagePrice: 201.25 })).toThrow();
  });

  it("rejects invalid API timestamps", () => {
    expect(() => ObservationEnvelopeSchema.parse({
      eventId: "evt_book_1",
      schemaVersion: 1,
      venue: "hyperliquid_hip3",
      instrumentId: instrument.instrumentId,
      sourceTimestamp: "not-an-epoch",
      receivedTimestamp: 1_790_000_000_084,
      transport: "websocket",
      freshnessBudgetMs: 500,
      qualityFlags: [],
      rawPayloadRefOrHash: "sha256:raw_1",
      eligibility: "live",
      payload: {
        kind: "index_price",
        price: "201.25",
      },
    })).toThrow();
  });

  it("rejects duplicate opportunity leg IDs", () => {
    expect(() => OpportunitySchema.parse({
      ...opportunity,
      legs: [opportunity.legs[0], { ...opportunity.legs[0], side: "sell" }],
    })).toThrow();
  });

  it.each(["signature", "privateKey", "apiSecret", "nonce", "orderSubmission"]) (
    "rejects unsigned intents containing %s",
    (forbiddenField) => {
      expect(() => UnsignedIntentSchema.parse({ ...unsignedIntent, [forbiddenField]: "forbidden" })).toThrow();
    },
  );
});
