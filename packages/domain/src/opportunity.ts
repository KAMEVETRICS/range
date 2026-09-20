import { z } from "zod";
import {
  DecimalStringSchema,
  EvidenceHashSchema,
  InstrumentIdSchema,
  IsoTimestampSchema,
  NonNegativeDecimalStringSchema,
  OpportunityIdSchema,
  PositiveDecimalStringSchema,
  SideSchema,
  UnderlyingIdSchema,
} from "./ids.js";
import { ExecutableQuoteSchema, FundingProjectionSchema } from "./funding.js";
import { DataEligibilitySchema } from "./observation.js";

export const RejectionCodeSchema = z.enum([
  "STALE_INPUT",
  "UNSYNCHRONIZED_INPUTS",
  "BOOK_SEQUENCE_GAP",
  "UNKNOWN_INSTRUMENT_EQUIVALENCE",
  "INSUFFICIENT_DEPTH",
  "NET_EDGE_BELOW_THRESHOLD",
  "FUNDING_SEMANTICS_UNKNOWN",
  "VENUE_DEGRADED",
  "CLOCK_SKEW_EXCEEDED",
  "CAPABILITY_WITHDRAWN",
]);

const OpportunityLegSchema = z.object({
  legId: z.string().trim().min(1),
  instrumentId: InstrumentIdSchema,
  side: SideSchema,
  executableQuote: ExecutableQuoteSchema,
  fundingProjection: FundingProjectionSchema.optional(),
}).strict();

export const OpportunityFreshnessSchema = z.object({
  oldestInputMs: z.number().int().nonnegative(),
  synchronized: z.boolean(),
  eligibility: DataEligibilitySchema,
  qualityFlags: z.array(z.string().trim().min(1)),
}).strict();

const ActionableFreshnessSchema = OpportunityFreshnessSchema.extend({
  synchronized: z.literal(true),
  eligibility: z.literal("live"),
}).strict();

const opportunityFields = {
  opportunityId: OpportunityIdSchema,
  strategy: z.string().trim().min(1),
  underlyingId: UnderlyingIdSchema,
  legs: z.array(OpportunityLegSchema).min(1).superRefine((legs, context) => {
    const ids = new Set<string>();
    for (const [index, leg] of legs.entries()) {
      if (ids.has(leg.legId)) {
        context.addIssue({ code: "custom", message: "Opportunity leg IDs must be unique.", path: [index, "legId"] });
      }
      ids.add(leg.legId);
    }
  }),
  grossSpreadBps: DecimalStringSchema,
  expectedFundingBps: DecimalStringSchema,
  tradingFeesBps: NonNegativeDecimalStringSchema,
  slippageBps: NonNegativeDecimalStringSchema,
  financingBps: NonNegativeDecimalStringSchema,
  gasAndTransferBps: NonNegativeDecimalStringSchema,
  fxConversionBps: NonNegativeDecimalStringSchema,
  uncertaintyBufferBps: NonNegativeDecimalStringSchema,
  netEdgeBps: DecimalStringSchema,
  capacityUsd: NonNegativeDecimalStringSchema,
  freshness: OpportunityFreshnessSchema,
  expiresAt: IsoTimestampSchema,
  rejectionReasons: z.array(RejectionCodeSchema),
};

const ActionableOpportunitySchema = z.object({
  ...opportunityFields,
  status: z.literal("actionable"),
  capacityUsd: PositiveDecimalStringSchema,
  freshness: ActionableFreshnessSchema,
  evidenceHash: EvidenceHashSchema,
  rejectionReasons: z.array(RejectionCodeSchema).length(0),
}).strict();

const RejectedOpportunitySchema = z.object({
  ...opportunityFields,
  status: z.literal("rejected"),
  evidenceHash: EvidenceHashSchema.optional(),
  rejectionReasons: z.array(RejectionCodeSchema).min(1),
}).strict();

const NonActionableOpportunitySchema = z.object({
  ...opportunityFields,
  status: z.enum(["observed", "validated", "intent_ready", "expired"]),
  evidenceHash: EvidenceHashSchema.optional(),
}).strict();

export const OpportunitySchema = z.discriminatedUnion("status", [
  ActionableOpportunitySchema,
  RejectedOpportunitySchema,
  NonActionableOpportunitySchema,
]);

export const EvidenceValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decimal"), value: DecimalStringSchema }).strict(),
  z.object({ kind: z.literal("integer"), value: z.number().int() }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("string"), value: z.string() }).strict(),
]);

export const EvidenceBundleSchema = z.object({
  sourceEventIds: z.array(z.string().trim().min(1)).min(1),
  calculationVersion: z.string().trim().min(1),
  canonicalMappingVersions: z.record(z.string(), z.string().trim().min(1)),
  assumptions: z.record(z.string(), EvidenceValueSchema),
  intermediateValues: z.record(z.string(), EvidenceValueSchema),
  warnings: z.array(z.string().trim().min(1)),
  evidenceHash: EvidenceHashSchema,
}).strict();

export type RejectionCode = z.infer<typeof RejectionCodeSchema>;
export type Opportunity = z.infer<typeof OpportunitySchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
