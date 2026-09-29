import { z } from "zod";
import { DecimalStringSchema, NonNegativeDecimalStringSchema, PositiveDecimalStringSchema } from "./ids.js";
import { DataEligibilitySchema } from "./observation.js";

const TopOfBookLevelSchema = z.object({ price: PositiveDecimalStringSchema, quantity: NonNegativeDecimalStringSchema }).strict();
const timing = {
  sourceTimestamp: z.number().int().nonnegative(),
  receivedTimestamp: z.number().int().nonnegative(),
  freshnessBudgetMs: z.number().int().positive(),
  eligibility: DataEligibilitySchema,
  qualityFlags: z.array(z.string()),
};

/** The latest top of book and funding rate the opportunity worker has seen for one instrument, with their times. */
export const MarketBoardEntrySchema = z.object({
  instrumentId: z.string().min(1),
  venue: z.string().min(1),
  venueSymbol: z.string().min(1),
  underlyingId: z.string().min(1),
  productType: z.string().min(1),
  book: z.object({ bid: TopOfBookLevelSchema.optional(), ask: TopOfBookLevelSchema.optional(), ...timing }).strict().optional(),
  funding: z.object({
    rate: DecimalStringSchema,
    rateType: z.enum(["current", "predicted", "realized"]),
    intervalMs: z.number().int().positive(),
    nextSettlementMs: z.number().int().nonnegative(),
    positiveRatePayer: z.enum(["long", "short"]).optional(),
    ...timing,
  }).strict().optional(),
}).strict();

/**
 * Display state, not trading state: the opportunity worker publishes it to Redis every few seconds and the gateway's
 * market overview reads it. Values stay until replaced, so readers judge each one's age from its timestamps.
 */
export const MarketBoardSnapshotSchema = z.object({
  asOfMs: z.number().int().nonnegative(),
  entries: z.array(MarketBoardEntrySchema),
}).strict();

export type MarketBoardEntry = z.infer<typeof MarketBoardEntrySchema>;
export type MarketBoardSnapshot = z.infer<typeof MarketBoardSnapshotSchema>;
