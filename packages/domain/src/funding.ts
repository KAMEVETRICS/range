import { z } from "zod";
import {
  DecimalStringSchema,
  EpochMillisecondsSchema,
  EventIdSchema,
  SideSchema,
} from "./ids.js";

export const ExecutableQuoteSchema = z.object({
  side: SideSchema,
  requestedNotional: DecimalStringSchema,
  averagePrice: DecimalStringSchema,
  worstPrice: DecimalStringSchema,
  filledQuantity: DecimalStringSchema,
  capacityUsd: DecimalStringSchema,
  depthUtilization: DecimalStringSchema,
  sourceBookEventId: EventIdSchema,
  ageMs: z.number().int().nonnegative(),
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
export type FundingProjection = z.infer<typeof FundingProjectionSchema>;
