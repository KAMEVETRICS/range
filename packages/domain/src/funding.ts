import { z } from "zod";
import {
  DecimalStringSchema,
  EpochMillisecondsSchema,
  EventIdSchema,
  PositiveDecimalStringSchema,
  SideSchema,
} from "./ids.js";

export const ExecutableQuoteSchema = z.object({
  side: SideSchema,
  requestedNotional: DecimalStringSchema,
  averagePrice: DecimalStringSchema,
  worstPrice: DecimalStringSchema,
  filledQuantity: DecimalStringSchema,
  filledNotionalUsd: DecimalStringSchema.optional(),
  capacityUsd: DecimalStringSchema,
  depthUtilization: DecimalStringSchema,
  sourceBookEventId: EventIdSchema,
  sourceEventIds: z.array(EventIdSchema).min(1).optional(),
  ageMs: z.number().int().nonnegative(),
}).strict();

export const PartialQuoteSchema = ExecutableQuoteSchema.extend({
  status: z.literal("partial_fill"),
  filledNotionalUsd: DecimalStringSchema,
  remainingNotionalUsd: PositiveDecimalStringSchema,
}).strict();

export const FundingProjectionSchema = z.object({
  rateType: z.enum(["current", "predicted", "realized"]),
  rate: DecimalStringSchema,
  intervalMs: z.number().int().positive(),
  nextSettlementMs: EpochMillisecondsSchema,
  holdingHorizonMs: z.number().int().positive(),
  expectedSettlements: z.number().int().nonnegative(),
  positionSide: z.enum(["long", "short"]),
  expectedCashflowBps: DecimalStringSchema,
  sourceObservationIds: z.array(EventIdSchema).min(1),
}).strict();

export type ExecutableQuote = z.infer<typeof ExecutableQuoteSchema>;
export type PartialQuote = z.infer<typeof PartialQuoteSchema>;
export type FundingProjection = z.infer<typeof FundingProjectionSchema>;
