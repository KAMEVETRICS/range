import { describe, expect, it } from "vitest";
import { normalizeFunding } from "./funding-state.js";
import { projectFunding } from "./funding-projection.js";

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
      normalized("four", T + 4 * HOUR), normalized("eight", T + 8 * HOUR),
    ]);
    expect(result).toMatchObject({ status: "projected", expectedCashflowUsd: "2", expectedCashflowBps: "2",
      settlementCount: 2, sourceObservationIds: ["evt_four", "evt_eight"] });
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
      normalized("before", T + HOUR - 1), normalized("start", T + HOUR),
      normalized("end", T + 2 * HOUR), normalized("after", T + 2 * HOUR + 1),
    ];
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T + HOUR, endMs: T + 2 * HOUR }, settlements))
      .toMatchObject({ settlementCount: 2, sourceObservationIds: ["evt_start", "evt_end"] });
    expect(projectFunding({ side: "short", notionalUsd: "10000" },
      { startMs: T, endMs: T + HOUR - 1 }, settlements))
      .toMatchObject({ settlementCount: 1, sourceObservationIds: ["evt_before"] });
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
});
