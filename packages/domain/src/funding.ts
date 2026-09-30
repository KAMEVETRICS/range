import { z } from "zod";
import {
  DecimalStringSchema,
  EpochMillisecondsSchema,
  EventIdSchema,
  InstrumentIdSchema,
  PositiveDecimalStringSchema,
  SideSchema,
  VenueSchema,
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
  status: z.literal("projected"),
  venue: VenueSchema,
  instrumentId: InstrumentIdSchema,
  rateTypes: z.array(z.enum(["current", "predicted"])).min(1),
  positiveRatePayer: z.enum(["long", "short"]),
  intervalMs: z.number().int().positive(),
  nextSettlementMs: EpochMillisecondsSchema,
  holdingStartMs: EpochMillisecondsSchema,
  holdingEndMs: EpochMillisecondsSchema,
  holdingHorizonMs: z.number().int().positive(),
  /** Zero when no settlement falls inside the holding window, so no funding changes hands. */
  settlementCount: z.number().int().nonnegative(),
  positionSide: z.enum(["long", "short"]),
  expectedCashflowBps: DecimalStringSchema,
  expectedCashflowUsd: DecimalStringSchema,
  sourceObservationIds: z.array(EventIdSchema).min(1),
}).strict();

export type ExecutableQuote = z.infer<typeof ExecutableQuoteSchema>;
export type PartialQuote = z.infer<typeof PartialQuoteSchema>;
export type FundingProjection = z.infer<typeof FundingProjectionSchema>;
