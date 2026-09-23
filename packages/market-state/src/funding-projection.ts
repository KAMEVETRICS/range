import { Decimal } from "decimal.js";
import { DecimalStringSchema, PositiveDecimalStringSchema } from "@range/domain";
import type { FundingRateType, NormalizedFunding } from "./funding-state.js";

export interface FundingPosition {
  readonly side: "long" | "short";
  readonly notionalUsd: string;
}

export interface HoldingWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export type FundingProjectionResult = {
  readonly status: "projected";
  readonly venue: string;
  readonly instrumentId: string;
  readonly positionSide: FundingPosition["side"];
  readonly holdingHorizonMs: number;
  readonly settlementCount: number;
  readonly expectedCashflowUsd: string;
  readonly expectedCashflowBps: string;
  readonly rateTypes: readonly FundingRateType[];
  readonly sourceObservationIds: readonly string[];
} | {
  readonly status: "rejected";
  readonly reason: "INVALID_REQUEST" | "FUNDING_SEMANTICS_UNKNOWN" | "MIXED_MARKET" | "DUPLICATE_SETTLEMENT" | "NO_FUTURE_RATE";
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
    item.projectionEligible === (item.rateType !== "realized");
}

/** Adds only supplied settlement observations; it never extrapolates a cadence or a future rate. */
export function projectFunding(
  position: FundingPosition,
  holdingWindow: HoldingWindow,
  settlements: readonly unknown[],
): FundingProjectionResult {
  if ((position.side !== "long" && position.side !== "short") ||
      !PositiveDecimalStringSchema.safeParse(position.notionalUsd).success ||
      position.notionalUsd.replace(".", "").length > MAX_INPUT_DIGITS ||
      !validTime(holdingWindow.startMs) || !validTime(holdingWindow.endMs) ||
      holdingWindow.endMs < holdingWindow.startMs ||
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
  if (!source.some(item => item.projectionEligible)) {
    return { status: "rejected", reason: "NO_FUTURE_RATE" };
  }
  const included = source.filter(item => item.projectionEligible &&
    item.atMs >= holdingWindow.startMs && item.atMs <= holdingWindow.endMs);
  const seen = new Set<number>();
  for (const item of included) {
    if (seen.has(item.atMs)) return { status: "rejected", reason: "DUPLICATE_SETTLEMENT" };
    seen.add(item.atMs);
  }
  const maxDigits = Math.max(position.notionalUsd.replace(".", "").length,
    ...included.map(item => item.rate.replace(/[.\-]/g, "").length));
  const ExactDecimal = Decimal.clone({ precision: 2 * maxDigits + Math.ceil(Math.log10(included.length + 1)) + 20 });
  const totalRate = included.reduce((sum, item) => {
    const sign = position.side === item.positiveRatePayer ? -1 : 1;
    return sum.plus(new ExactDecimal(item.rate).times(sign));
  }, new ExactDecimal(0));
  return {
    status: "projected", venue: source[0]!.venue, instrumentId: source[0]!.instrumentId,
    positionSide: position.side, holdingHorizonMs: holdingWindow.endMs - holdingWindow.startMs,
    settlementCount: included.length,
    expectedCashflowUsd: totalRate.times(position.notionalUsd).toFixed(),
    expectedCashflowBps: totalRate.times(10_000).toFixed(),
    rateTypes: [...new Set(included.map(item => item.rateType))],
    sourceObservationIds: included.map(item => item.sourceObservationId),
  };
}
