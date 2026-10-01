import { describe, expect, it } from "vitest";
import { FundingProjectionSchema, OpportunitySchema } from "@range/domain";
import { normalizeFunding } from "./funding-state.js";
import { projectFunding as calculateFunding } from "./funding-projection.js";

const HOUR = 3_600_000;
const T = 1_790_000_000_000;

function funding(id: string, atMs: number, rate = "0.0001", rateType = "predicted", overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${id}`, schemaVersion: 1, venue: "venue_a", instrumentId: "ins_a",
    transport: "websocket", sourceTimestamp: T - 100, receivedTimestamp: T - 90,
    freshnessBudgetMs: 1_000, qualityFlags: [], rawPayloadRefOrHash: `hash_${id}`,
    eligibility: "live", payload: { kind: "funding", rateType, rate, intervalMs: HOUR, nextSettlementMs: atMs, positiveRatePayer: "long" },
    ...overrides,
  };
}

function normalized(id: string, atMs: number, rate = "0.0001", rateType = "predicted", overrides: Record<string, unknown> = {}) {
  const result = normalizeFunding(funding(id, atMs, rate, rateType, overrides), T);
  expect(result.status).toBe("normalized");
  if (result.status !== "normalized") throw new Error("fixture normalization failed");
  return result;
}

function projectFunding(
  position: Parameters<typeof calculateFunding>[0],
  window: Parameters<typeof calculateFunding>[1],
  settlements: Parameters<typeof calculateFunding>[2],
  evaluatedAtMs = T,
) {
  return calculateFunding(position, window, settlements, evaluatedAtMs);
}

describe("funding normalization and horizon projection", () => {
  it("rejects unknown interval or next settlement instead of inventing a schedule", () => {
    expect(normalizeFunding({ rate: "0.0001", rateType: "current" }, T)).toMatchObject({
      status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN",
    });
    expect(normalizeFunding(funding("missing", T + HOUR, "0.0001", "current", {
      payload: { kind: "funding", rateType: "current", rate: "0.0001", nextSettlementMs: T + HOUR, positiveRatePayer: "long" },
    }), T)).toMatchObject({ status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" });
  });

  it("retains rate kind, interval, source time, raw provenance, and event ID", () => {
    expect(normalized("one", T + HOUR, "0.0001", "current")).toMatchObject({
      rateType: "current", rate: "0.0001", intervalMs: HOUR, positiveRatePayer: "long",
      atMs: T + HOUR, sourceTimestampMs: T - 100, receivedTimestampMs: T - 90,
      sourceObservationId: "evt_one", rawPayloadRefOrHash: "hash_one", venue: "venue_a", instrumentId: "ins_a",
    });
  });

  it("compares actual settlements rather than annualized rates", () => {
    const result = projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + 8 * HOUR }, [
      ...[4, 8].map(hour => normalized(String(hour), T + hour * HOUR, "0.0001", "predicted", {
        payload: { kind: "funding", rateType: "predicted", rate: "0.0001", intervalMs: 4 * HOUR,
          nextSettlementMs: T + hour * HOUR, positiveRatePayer: "long" },
      })),
    ]);
    expect(result).toMatchObject({ status: "projected", expectedCashflowUsd: "2", expectedCashflowBps: "2",
      settlementCount: 2, sourceObservationIds: ["evt_4", "evt_8"] });
  });

  it("compares one-hour and eight-hour venues by eligible settlements in the same horizon", () => {
    const hourly = Array.from({ length: 8 }, (_, i) => normalized(`h${i}`, T + (i + 1) * HOUR));
    const eightHourly = normalized("8h", T + 8 * HOUR, "0.0005", "predicted", {
      venue: "venue_b", instrumentId: "ins_b",
      payload: { kind: "funding", rateType: "predicted", rate: "0.0005", intervalMs: 8 * HOUR, nextSettlementMs: T + 8 * HOUR, positiveRatePayer: "long" },
    });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + 8 * HOUR }, hourly))
      .toMatchObject({ expectedCashflowUsd: "8", settlementCount: 8 });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + 8 * HOUR }, [eightHourly]))
      .toMatchObject({ expectedCashflowUsd: "5", settlementCount: 1, venue: "venue_b" });
  });

  it("applies the long and short sign to negative funding with exact decimal cash and bps", () => {
    const settlement = normalized("negative", T + HOUR, "-0.00000000000000000001");
    expect(projectFunding({ side: "long", notionalUsd: "123456789.123456789" }, { startMs: T, endMs: T + HOUR }, [settlement]))
      .toMatchObject({ expectedCashflowUsd: "0.00000000000123456789123456789", expectedCashflowBps: "0.0000000000000001" });
    expect(projectFunding({ side: "short", notionalUsd: "123456789.123456789" }, { startMs: T, endMs: T + HOUR }, [settlement]))
      .toMatchObject({ expectedCashflowUsd: "-0.00000000000123456789123456789", expectedCashflowBps: "-0.0000000000000001" });
  });

  it("projects a current rate when a separate predicted rate is unavailable", () => {
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [
      normalized("current", T + HOUR, "0.0002", "current"),
    ])).toMatchObject({ status: "projected", rateTypes: ["current"], expectedCashflowUsd: "2" });
  });

  it("includes exact start and end boundaries but excludes one millisecond beyond them", () => {
    const settlements = [
      normalized("start", T + HOUR), normalized("end", T + 2 * HOUR), normalized("after", T + 3 * HOUR),
    ];
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T + HOUR, endMs: T + 2 * HOUR }, settlements))
      .toMatchObject({ settlementCount: 2, sourceObservationIds: ["evt_start", "evt_end"] });
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + HOUR - 1 }, settlements))
      .toMatchObject({ status: "no_settlement_due" });
  });

  it("keeps realized history separate from projected future cash flow", () => {
    const historical = normalized("history", T - HOUR, "0.01", "realized");
    expect(historical).toMatchObject({ rateType: "realized", projectionEligible: false });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [historical]))
      .toMatchObject({ status: "rejected", reason: "NO_FUTURE_RATE" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [
      historical, normalized("future", T + HOUR),
    ])).toMatchObject({ settlementCount: 1, expectedCashflowUsd: "1", sourceObservationIds: ["evt_future"] });
  });

  it("rejects delayed, stale, replayed, and flagged funding sources", () => {
    for (const overrides of [
      { eligibility: "delayed" }, { eligibility: "reference_only" },
      { sourceTimestamp: T - 1_001 }, { transport: "replay" },
      { qualityFlags: ["settlement_unverified"] },
    ]) {
      expect(normalizeFunding(funding("bad", T + HOUR, "0.0001", "predicted", overrides), T))
        .toMatchObject({ status: "rejected" });
    }
  });

  it("rejects duplicate settlements and cross-venue bundles instead of double-counting", () => {
    const first = normalized("first", T + HOUR);
    const duplicate = normalized("second", T + HOUR);
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [first, duplicate]))
      .toMatchObject({ status: "rejected", reason: "DUPLICATE_SETTLEMENT" });
    const otherVenue = normalized("other", T + 2 * HOUR, "0.0001", "predicted", { venue: "venue_b" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + 2 * HOUR }, [first, otherVenue]))
      .toMatchObject({ status: "rejected", reason: "MIXED_MARKET" });
  });

  it("rejects raw research funding passed directly to projection", () => {
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [
      { rate: "0.01", rateType: "predicted", nextSettlementMs: T + HOUR, intervalMs: HOUR },
    ])).toMatchObject({ status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" });
  });

  it("requires an explicit rate payer and honors a venue where shorts pay positive rates", () => {
    expect(normalizeFunding(funding("unknown_sign", T + HOUR, "0.0001", "current", {
      payload: { kind: "funding", rateType: "current", rate: "0.0001", intervalMs: HOUR, nextSettlementMs: T + HOUR },
    }), T)).toMatchObject({ status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" });
    const reversed = normalized("reverse", T + HOUR, "0.0001", "current", {
      payload: { kind: "funding", rateType: "current", rate: "0.0001", intervalMs: HOUR, nextSettlementMs: T + HOUR, positiveRatePayer: "short" },
    });
    expect(projectFunding({ side: "long", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [reversed]))
      .toMatchObject({ expectedCashflowUsd: "1", expectedCashflowBps: "1" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, { startMs: T, endMs: T + HOUR }, [reversed]))
      .toMatchObject({ expectedCashflowUsd: "-1", expectedCashflowBps: "-1" });
  });

  it("rechecks freshness and future settlement at the explicit evaluation time", () => {
    const source = normalized("expiring", T + HOUR);
    const window = { startMs: T + 1_001, endMs: T + HOUR };
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, window, [source], T + 1_001))
      .toMatchObject({ status: "rejected", reason: "STALE_INPUT" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T + HOUR, endMs: T + HOUR }, [source], T + HOUR))
      .toMatchObject({ status: "rejected", reason: "SETTLEMENT_NOT_FUTURE" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + HOUR }, [{ ...source, sourceEligibility: "reference_only" }]))
      .toMatchObject({ status: "rejected", reason: "SOURCE_NOT_ELIGIBLE" });
  });

  it("marks missing first, interior, and final scheduled rates as partial", () => {
    const first = normalized("first", T + HOUR);
    const third = normalized("third", T + 3 * HOUR);
    const window = { startMs: T, endMs: T + 3 * HOUR };
    for (const records of [[third], [first, third], [first]]) {
      const result = projectFunding({ side: "short", notionalUsd: "10000" }, window, records);
      expect(result).toMatchObject({ status: "partial", reason: "MISSING_SETTLEMENT_COVERAGE" });
      expect(FundingProjectionSchema.safeParse(result).success).toBe(false);
    }
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + 2 * HOUR }, [first]))
      .toMatchObject({ status: "partial", reason: "MISSING_SETTLEMENT_COVERAGE" });
  });

  it("keeps a true no-settlement window separate from a complete projection", () => {
    const result = projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + HOUR - 1 }, [normalized("later", T + HOUR)]);
    expect(result).toMatchObject({ status: "no_settlement_due", nextSettlementMs: T + HOUR });
    expect(FundingProjectionSchema.safeParse(result).success).toBe(false);
  });

  it("bounds schedule expansion before scanning a very long uncovered window", () => {
    const next = normalized("fast", T + 1, "0.0001", "predicted", {
      payload: { kind: "funding", rateType: "predicted", rate: "0.0001", intervalMs: 1,
        nextSettlementMs: T + 1, positiveRatePayer: "long" },
    });
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T + 100_001, endMs: T + 100_001 }, [next]))
      .toMatchObject({ status: "rejected", reason: "INVALID_REQUEST" });
  });

  it("rejects inconsistent interval, payer, or repeated source ID", () => {
    const first = normalized("first", T + HOUR);
    const second = normalized("second", T + 2 * HOUR);
    const window = { startMs: T, endMs: T + 2 * HOUR };
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, window, [first, { ...second, intervalMs: 8 * HOUR }]))
      .toMatchObject({ status: "rejected", reason: "MIXED_SEMANTICS" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, window, [first, { ...second, positiveRatePayer: "short" }]))
      .toMatchObject({ status: "rejected", reason: "MIXED_SEMANTICS" });
    expect(projectFunding({ side: "short", notionalUsd: "10000" }, window, [first, { ...second, sourceObservationId: first.sourceObservationId }]))
      .toMatchObject({ status: "rejected", reason: "DUPLICATE_SOURCE" });
  });

  it("hands a complete projection to a strict actionable opportunity leg", () => {
    const result = projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + HOUR }, [normalized("handoff", T + HOUR)]);
    expect(FundingProjectionSchema.safeParse(result).success).toBe(true);
    const opportunity = {
      opportunityId: "opp_funding_1", stateRevision: 0, strategy: "funding_differential", underlyingId: "equity:TSLA",
      legs: [{ legId: "leg_1", instrumentId: "ins_a", side: "sell",
        executableQuote: { side: "sell", requestedNotional: "10000", averagePrice: "100", worstPrice: "100",
          filledQuantity: "100", capacityUsd: "10000", depthUtilization: "1", sourceBookEventId: "evt_book_1", ageMs: 10 },
        fundingProjection: result }],
      grossSpreadBps: "0", expectedFundingBps: "1", tradingFeesBps: "0", slippageBps: "0",
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0",
      netEdgeBps: "1", capacityUsd: "10000",
      freshness: { oldestInputMs: 100, synchronized: true, eligibility: "live", qualityFlags: [] },
      status: "actionable", expiresAt: "2026-09-20T00:00:02.000Z", evidenceHash: "sha256:handoff", rejectionReasons: [],
    };
    expect(OpportunitySchema.safeParse(opportunity).success).toBe(true);
    expect(OpportunitySchema.safeParse({ ...opportunity, legs: [{ ...opportunity.legs[0],
      fundingProjection: projectFunding({ side: "short", notionalUsd: "10000" },
        { startMs: T, endMs: T + 2 * HOUR }, [normalized("partial", T + HOUR)]) }] }).success).toBe(false);
  });
});
