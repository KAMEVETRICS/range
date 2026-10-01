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

/**
 * A fill short of its requested notional by no more than this (1e-40 USD) is complete. Quantities are exact to 80
 * places, so a level sized to the remainder of a notional that does not divide its price (2,500 at 228.37) leaves a
 * gap below price x 1e-80: rounding dust, never money. Quotes still report the exact quantity x price.
 */
export const FILL_DUST_USD = `0.${"0".repeat(39)}1`;

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
