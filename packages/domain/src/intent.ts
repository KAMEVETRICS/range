import { z } from "zod";
import {
  EvidenceHashSchema,
  InstrumentIdSchema,
  IsoTimestampSchema,
  OpportunityIdSchema,
  PositiveDecimalStringSchema,
  SideSchema,
} from "./ids.js";

const PriceBoundsSchema = z.object({
  minimum: PositiveDecimalStringSchema,
  maximum: PositiveDecimalStringSchema,
}).strict();

const DerivedIntentLegSchema = z.object({
  legId: z.string().trim().min(1),
  instrumentId: InstrumentIdSchema,
  side: SideSchema,
  quantity: PositiveDecimalStringSchema,
  priceBounds: PriceBoundsSchema,
}).strict();

export const UnsignedIntentSchema = z.object({
  opportunityId: OpportunityIdSchema,
  constrainedNotionalUsd: PositiveDecimalStringSchema,
  derivedLegs: z.array(DerivedIntentLegSchema).min(1).superRefine((legs, context) => {
    const ids = new Set<string>();
    for (const [index, leg] of legs.entries()) {
      if (ids.has(leg.legId)) {
        context.addIssue({ code: "custom", message: "Derived leg IDs must be unique.", path: [index, "legId"] });
      }
      ids.add(leg.legId);
    }
  }),
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  nonAtomicWarning: z.boolean(),
  preflightChecks: z.array(z.string().trim().min(1)).min(1),
  evidenceHash: EvidenceHashSchema,
  idempotencyKey: z.string().trim().min(1),
}).strict();

export type UnsignedIntent = z.infer<typeof UnsignedIntentSchema>;
