import { describe, expect, it } from "vitest";
import * as domain from "./index.js";

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

const internalObservation = {
  eventId: "evt_book_1",
  schemaVersion: 1,
  venue: "hyperliquid_hip3",
  instrumentId: "ins_hl_xyz_tsla",
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
};

const actionableOpportunity = {
  opportunityId: "opp_1",
  strategy: "spot_perpetual_basis",
  underlyingId: "equity:TSLA",
  legs: [{
    legId: "leg_spot",
    instrumentId: "ins_ondo_tsla",
    side: "buy",
    executableQuote,
  }],
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

describe("schema review fixes", () => {
  it.each(["live", "delayed", "stale", "reference_only"] as const)(
    "preserves the required %s observation eligibility state",
    (eligibility) => {
      expect(domain.ObservationEnvelopeSchema.parse({ ...internalObservation, eligibility }).eligibility)
        .toBe(eligibility);
    },
  );

  it("rejects raw numeric economic values in canonical observation payloads", () => {
    expect(() => domain.ObservationEnvelopeSchema.parse({
      ...internalObservation,
      payload: { ...internalObservation.payload, capacityUsd: 25000.5 },
    })).toThrow();
  });

  it("uses epoch milliseconds internally and converts ISO boundary timestamps", () => {
    expect(() => domain.ObservationEnvelopeSchema.parse({
      ...internalObservation,
      sourceTimestamp: "2026-09-20T00:00:00.000Z",
    })).toThrow();

    expect("ObservationBoundaryEnvelopeSchema" in domain).toBe(true);
    expect("toInternalObservationEnvelope" in domain).toBe(true);

    const boundarySchema = (domain as unknown as {
      ObservationBoundaryEnvelopeSchema: { parse: (value: unknown) => unknown };
    }).ObservationBoundaryEnvelopeSchema;
    const toInternal = (domain as unknown as {
      toInternalObservationEnvelope: (value: unknown) => { sourceTimestamp: number; receivedTimestamp: number };
    }).toInternalObservationEnvelope;
    const boundary = {
      ...internalObservation,
      sourceTimestamp: "2026-09-20T00:00:00.000Z",
      receivedTimestamp: "2026-09-20T00:00:00.084Z",
    };

    expect(toInternal(boundarySchema.parse(boundary))).toMatchObject({
      sourceTimestamp: 1_789_862_400_000,
      receivedTimestamp: 1_789_862_400_084,
    });
  });

  it.each([
    ["unsynchronized", { freshness: { ...actionableOpportunity.freshness, synchronized: false } }],
    ["delayed", { freshness: { ...actionableOpportunity.freshness, eligibility: "delayed" } }],
    ["stale", { freshness: { ...actionableOpportunity.freshness, eligibility: "stale" } }],
    ["reference-only", { freshness: { ...actionableOpportunity.freshness, eligibility: "reference_only" } }],
    ["rejected", { rejectionReasons: ["STALE_INPUT"] }],
  ])("rejects %s inputs for actionable opportunities", (_name, invalidValues) => {
    expect(() => domain.OpportunitySchema.parse({ ...actionableOpportunity, ...invalidValues })).toThrow();
  });

  it.each([
    ["empty evidence", { evidenceHash: "" }],
    ["missing evidence", { evidenceHash: undefined }],
    ["zero capacity", { capacityUsd: "0" }],
    ["missing expiry", { expiresAt: undefined }],
  ])("independently rejects actionable opportunities with %s", (_name, invalidValues) => {
    expect(() => domain.OpportunitySchema.parse({ ...actionableOpportunity, ...invalidValues })).toThrow();
  });

  it("types evidence economic values separately from counts and durations", () => {
    const evidence = {
      sourceEventIds: ["evt_book_1"],
      calculationVersion: "calc.v1",
      canonicalMappingVersions: { "equity:TSLA": "map.v1" },
      assumptions: {
        holdingHorizonMs: { kind: "integer", value: 86_400_000 },
        usesFreshInputs: { kind: "boolean", value: true },
      },
      intermediateValues: {
        capacityUsd: { kind: "decimal", value: "25000" },
        matchedLegs: { kind: "integer", value: 2 },
      },
      warnings: [],
      evidenceHash: "sha256:evidence_1",
    };

    expect(domain.EvidenceBundleSchema.parse(evidence)).toEqual(evidence);
    expect(() => domain.EvidenceBundleSchema.parse({
      ...evidence,
      intermediateValues: {
        ...evidence.intermediateValues,
        capacityUsd: { kind: "decimal", value: 25000.5 },
      },
    })).toThrow();
  });
});
