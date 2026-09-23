import { ObservationEnvelopeSchema } from "@range/domain";

export type FundingRateType = "current" | "predicted" | "realized";

export interface NormalizedFunding {
  readonly status: "normalized";
  readonly provenance: "canonical_observation";
  readonly projectionEligible: boolean;
  readonly venue: string;
  readonly instrumentId: string;
  readonly rateType: FundingRateType;
  readonly rate: string;
  readonly positiveRatePayer: "long" | "short";
  readonly intervalMs: number;
  readonly atMs: number;
  readonly sourceTimestampMs: number;
  readonly receivedTimestampMs: number;
  readonly freshnessBudgetMs: number;
  readonly sourceObservationId: string;
  readonly rawPayloadRefOrHash: string;
}

export interface RejectedFunding {
  readonly status: "rejected";
  readonly reason: "FUNDING_SEMANTICS_UNKNOWN" | "SOURCE_NOT_ELIGIBLE" | "STALE_INPUT";
}

export type FundingNormalization = NormalizedFunding | RejectedFunding;

/** Only canonical, live, fresh observations can supply future projection rates. */
export function normalizeFunding(observation: unknown, nowMs = Date.now()): FundingNormalization {
  const parsed = ObservationEnvelopeSchema.safeParse(observation);
  if (!parsed.success || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" };
  }
  const item = parsed.data;
  const payload = item.payload;
  if (payload.kind !== "funding") {
    return { status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" };
  }
  if (item.eligibility !== "live" || item.transport === "replay" || item.qualityFlags.length > 0) {
    return { status: "rejected", reason: "SOURCE_NOT_ELIGIBLE" };
  }
  if (item.sourceTimestamp > item.receivedTimestamp || item.receivedTimestamp > nowMs ||
      nowMs - item.sourceTimestamp > item.freshnessBudgetMs ||
      item.receivedTimestamp - item.sourceTimestamp > item.freshnessBudgetMs) {
    return { status: "rejected", reason: "STALE_INPUT" };
  }
  if (payload.positiveRatePayer === undefined ||
      (payload.rateType !== "realized" && payload.nextSettlementMs <= nowMs)) {
    return { status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" };
  }
  return {
    status: "normalized", provenance: "canonical_observation",
    projectionEligible: payload.rateType !== "realized",
    venue: item.venue, instrumentId: item.instrumentId,
    rateType: payload.rateType, rate: payload.rate, positiveRatePayer: payload.positiveRatePayer,
    intervalMs: payload.intervalMs, atMs: payload.nextSettlementMs,
    sourceTimestampMs: item.sourceTimestamp, receivedTimestampMs: item.receivedTimestamp,
    freshnessBudgetMs: item.freshnessBudgetMs,
    sourceObservationId: item.eventId, rawPayloadRefOrHash: item.rawPayloadRefOrHash,
  };
}
