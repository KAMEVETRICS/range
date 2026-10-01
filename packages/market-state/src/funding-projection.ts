import { Decimal } from "decimal.js";
import { DecimalStringSchema, FundingProjectionSchema, PositiveDecimalStringSchema, type FundingProjection } from "@range/domain";
import type { NormalizedFunding } from "./funding-state.js";

export interface FundingPosition {
  readonly side: "long" | "short";
  readonly notionalUsd: string;
}

export interface HoldingWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export type FundingProjectionResult = FundingProjection | {
  readonly status: "partial";
  readonly reason: "MISSING_SETTLEMENT_COVERAGE";
  readonly missingSettlementMs: number;
} | {
  readonly status: "no_settlement_due";
  readonly nextSettlementMs: number;
} | {
  readonly status: "rejected";
  readonly reason: "INVALID_REQUEST" | "FUNDING_SEMANTICS_UNKNOWN" | "MIXED_MARKET" |
    "MIXED_SEMANTICS" | "DUPLICATE_SETTLEMENT" | "DUPLICATE_SOURCE" | "NO_FUTURE_RATE" |
    "SOURCE_NOT_ELIGIBLE" | "STALE_INPUT" | "SETTLEMENT_NOT_FUTURE";
};

const MAX_INPUT_DIGITS = 128;
const MAX_SETTLEMENTS = 10_000;

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validFunding(value: unknown): value is NormalizedFunding {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<NormalizedFunding>;
  return item.status === "normalized" && item.provenance === "canonical_observation" &&
    typeof item.projectionEligible === "boolean" &&
    typeof item.venue === "string" && item.venue.length > 0 &&
    typeof item.instrumentId === "string" && item.instrumentId.startsWith("ins_") &&
    (item.rateType === "current" || item.rateType === "predicted" || item.rateType === "realized") &&
    (item.positiveRatePayer === "long" || item.positiveRatePayer === "short") &&
    typeof item.rate === "string" && DecimalStringSchema.safeParse(item.rate).success &&
    item.rate.replace(".", "").replace("-", "").length <= MAX_INPUT_DIGITS &&
    validTime(item.atMs) && validTime(item.sourceTimestampMs) && validTime(item.receivedTimestampMs) &&
    validTime(item.intervalMs) && item.intervalMs > 0 &&
    validTime(item.freshnessBudgetMs) && item.freshnessBudgetMs > 0 &&
    typeof item.sourceObservationId === "string" && /^evt_[A-Za-z0-9_.:-]+$/.test(item.sourceObservationId) &&
    typeof item.rawPayloadRefOrHash === "string" && item.rawPayloadRefOrHash.length > 0 &&
    item.projectionEligible === (item.rateType !== "realized") &&
    typeof item.sourceEligibility === "string" &&
    typeof item.transport === "string" && Array.isArray(item.qualityFlags);
}

/** Adds only supplied settlement observations; it never extrapolates a cadence or a future rate. */
export function projectFunding(
  position: FundingPosition,
  holdingWindow: HoldingWindow,
  settlements: readonly unknown[],
  evaluatedAtMs: number,
): FundingProjectionResult {
  if ((position.side !== "long" && position.side !== "short") ||
      !PositiveDecimalStringSchema.safeParse(position.notionalUsd).success ||
      position.notionalUsd.replace(".", "").length > MAX_INPUT_DIGITS ||
      !validTime(holdingWindow.startMs) || !validTime(holdingWindow.endMs) || !validTime(evaluatedAtMs) ||
      holdingWindow.endMs < holdingWindow.startMs || holdingWindow.startMs < evaluatedAtMs ||
      settlements.length > MAX_SETTLEMENTS) {
    return { status: "rejected", reason: "INVALID_REQUEST" };
  }
  if (settlements.length === 0 || !settlements.every(validFunding)) {
    return { status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" };
  }
  const source = settlements as readonly NormalizedFunding[];
  if (source.some(item => item.venue !== source[0]!.venue || item.instrumentId !== source[0]!.instrumentId)) {
    return { status: "rejected", reason: "MIXED_MARKET" };
  }
  if (source.some(item => item.sourceEligibility !== "live" ||
      (item.transport !== "websocket" && item.transport !== "rest") || item.qualityFlags.length > 0)) {
    return { status: "rejected", reason: "SOURCE_NOT_ELIGIBLE" };
  }
  const eligible = source.filter(item => item.projectionEligible);
  if (eligible.length === 0) {
    return { status: "rejected", reason: "NO_FUTURE_RATE" };
  }
  if (eligible.some(item => item.atMs <= evaluatedAtMs)) {
    return { status: "rejected", reason: "SETTLEMENT_NOT_FUTURE" };
  }
  if (source.some(item => item.sourceTimestampMs > item.receivedTimestampMs ||
      item.receivedTimestampMs > evaluatedAtMs ||
      evaluatedAtMs - item.sourceTimestampMs > item.freshnessBudgetMs ||
      item.receivedTimestampMs - item.sourceTimestampMs > item.freshnessBudgetMs)) {
    return { status: "rejected", reason: "STALE_INPUT" };
  }
  if (eligible.some(item => item.intervalMs !== eligible[0]!.intervalMs ||
      item.positiveRatePayer !== eligible[0]!.positiveRatePayer)) {
    return { status: "rejected", reason: "MIXED_SEMANTICS" };
  }
  const sourceIds = new Set<string>();
  for (const item of source) {
    if (sourceIds.has(item.sourceObservationId)) return { status: "rejected", reason: "DUPLICATE_SOURCE" };
    sourceIds.add(item.sourceObservationId);
  }
  const byTime = new Map<number, NormalizedFunding>();
  for (const item of eligible) {
    if (byTime.has(item.atMs)) return { status: "rejected", reason: "DUPLICATE_SETTLEMENT" };
    byTime.set(item.atMs, item);
  }
  const intervalMs = eligible[0]!.intervalMs;
  const nextSettlementMs = Math.min(...eligible.map(item => item.atMs));
  if (eligible.some(item => (item.atMs - nextSettlementMs) % intervalMs !== 0)) {
    return { status: "rejected", reason: "MIXED_SEMANTICS" };
  }
  // A next settlement farther away than one verified interval leaves an unknown first slot.
  if (nextSettlementMs - evaluatedAtMs > intervalMs) {
    return { status: "partial", reason: "MISSING_SETTLEMENT_COVERAGE", missingSettlementMs: evaluatedAtMs + intervalMs };
  }
  if (nextSettlementMs > holdingWindow.endMs) {
    return { status: "no_settlement_due", nextSettlementMs };
  }
  if (Math.floor((holdingWindow.endMs - nextSettlementMs) / intervalMs) + 1 > MAX_SETTLEMENTS) {
    return { status: "rejected", reason: "INVALID_REQUEST" };
  }
  const included: NormalizedFunding[] = [];
  for (let atMs = nextSettlementMs; atMs <= holdingWindow.endMs;) {
    if (atMs >= holdingWindow.startMs) {
      const item = byTime.get(atMs);
      if (!item) return { status: "partial", reason: "MISSING_SETTLEMENT_COVERAGE", missingSettlementMs: atMs };
      included.push(item);
    }
    if (atMs > Number.MAX_SAFE_INTEGER - intervalMs) {
      return { status: "rejected", reason: "INVALID_REQUEST" };
    }
    atMs += intervalMs;
  }
  if (included.length === 0) {
    return { status: "no_settlement_due", nextSettlementMs };
  }
  if (holdingWindow.endMs === holdingWindow.startMs) {
    return { status: "rejected", reason: "INVALID_REQUEST" };
  }
  const maxDigits = Math.max(position.notionalUsd.replace(".", "").length,
    ...included.map(item => item.rate.replace(/[.\-]/g, "").length));
  const ExactDecimal = Decimal.clone({ precision: 2 * maxDigits + Math.ceil(Math.log10(included.length + 1)) + 20 });
  const totalRate = included.reduce((sum, item) => {
    const sign = position.side === item.positiveRatePayer ? -1 : 1;
    return sum.plus(new ExactDecimal(item.rate).times(sign));
  }, new ExactDecimal(0));
  return FundingProjectionSchema.parse({
    status: "projected", venue: source[0]!.venue, instrumentId: source[0]!.instrumentId,
    positionSide: position.side, positiveRatePayer: eligible[0]!.positiveRatePayer,
    intervalMs, nextSettlementMs, holdingStartMs: holdingWindow.startMs, holdingEndMs: holdingWindow.endMs,
    holdingHorizonMs: holdingWindow.endMs - holdingWindow.startMs,
    settlementCount: included.length,
    expectedCashflowUsd: totalRate.times(position.notionalUsd).toFixed(),
    expectedCashflowBps: totalRate.times(10_000).toFixed(),
    rateTypes: [...new Set(included.map(item => item.rateType))],
    sourceObservationIds: included.map(item => item.sourceObservationId),
  });
}
