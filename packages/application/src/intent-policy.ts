import { Decimal } from "decimal.js";
import { z } from "zod";
import { PositiveDecimalStringSchema, type EvidenceBundle, type Opportunity } from "@range/domain";
import { ApplicationError } from "./service.js";

export const CreateIntentRequestSchema = z.object({
  opportunityId: z.string().max(200).regex(/^opp_[A-Za-z0-9_.:-]+$/),
  requestedNotionalUsd: PositiveDecimalStringSchema.and(z.string().max(128)),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
}).strict();
export const IntentParamsSchema = z.object({ id: z.string().regex(/^intent_[a-f0-9]{64}$/) }).strict();
export const EmptyIntentRequestSchema = z.object({}).strict();
export const strategyTtl = { perp_spread: 2000, spot_perp_basis: 5000, funding_differential: 30000 } as const;
export const Exact = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_DOWN });
export function fail(code: string): never { throw new ApplicationError(409, code); }
export function policy(opportunity: Opportunity, evidence: EvidenceBundle) {
  if (!Object.hasOwn(strategyTtl, opportunity.strategy)) fail("UNSUPPORTED_STRATEGY");
  if (opportunity.status !== "actionable" || opportunity.freshness.eligibility !== "live" ||
    !opportunity.freshness.synchronized || opportunity.freshness.qualityFlags.length) fail("OPPORTUNITY_NOT_ACTIONABLE");
  if (opportunity.legs.length !== 2 || new Set(opportunity.legs.map(leg => leg.instrumentId)).size !== 2 ||
      opportunity.legs.filter(leg => leg.side === "buy").length !== 1) fail("INVALID_LEGS");
  const integer = (key: string) => {
    const item = evidence.assumptions[key];
    if (!item || item.kind !== "integer" || !Number.isSafeInteger(item.value) || item.value <= 0) fail("POLICY_UNAVAILABLE");
    return item.value;
  };
  const minimum = evidence.assumptions.minNetEdgeBps;
  if (!minimum || minimum.kind !== "decimal" || !new Exact(minimum.value).isFinite()) fail("POLICY_UNAVAILABLE");
  return { ttl: strategyTtl[opportunity.strategy as keyof typeof strategyTtl], horizon: integer("holdingHorizonMs"),
    syncBudget: integer("synchronizationBudgetMs"), skewBudget: integer("maxClockSkewMs"), minEdge: minimum.value };
}
