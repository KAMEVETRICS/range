import { z } from "zod";
import { DecimalStringSchema, NonNegativeDecimalStringSchema } from "./ids.js";

const PairSideSchema = z.object({
  instrumentId: z.string().min(1),
  venue: z.string().min(1),
  venueSymbol: z.string().min(1),
  /** The average fill price at the requested notional, when the book could fill it. */
  averagePrice: DecimalStringSchema.nullable(),
}).strict();

/** The latest evaluation of one reviewed pair, one strategy, one direction, whatever its outcome. */
export const PairEvaluationSchema = z.object({
  underlyingId: z.string().min(1),
  strategy: z.enum(["perp_spread", "spot_perp_basis", "funding_differential"]),
  buy: PairSideSchema,
  sell: PairSideSchema,
  status: z.enum(["observed", "validated", "actionable", "rejected", "intent_ready", "expired"]),
  grossSpreadBps: DecimalStringSchema,
  expectedFundingBps: DecimalStringSchema,
  /** Trading fees, slippage, financing, transfer, conversion, and the uncertainty buffer together. */
  costsBps: NonNegativeDecimalStringSchema,
  netEdgeBps: DecimalStringSchema,
  capacityUsd: NonNegativeDecimalStringSchema,
  requestedNotionalUsd: NonNegativeDecimalStringSchema,
  rejectionReasons: z.array(z.string()),
  evaluatedAtMs: z.number().int().nonnegative(),
}).strict();

export const ReviewedPairMappingSchema = z.object({
  underlyingId: z.string().min(1),
  members: z.array(z.object({
    instrumentId: z.string().min(1),
    venue: z.string().min(1),
    venueSymbol: z.string().min(1),
    underlyingId: z.string().min(1),
  }).strict()).min(2),
}).strict();

/**
 * The opportunity worker's latest evaluation of every reviewed pair, with the reviewed mappings behind them. It is
 * published to current state every few seconds, like the market board, so a rejection costs no write of its own.
 */
export const PairEvaluationSnapshotSchema = z.object({
  asOfMs: z.number().int().nonnegative(),
  pairs: z.array(PairEvaluationSchema),
  mappings: z.array(ReviewedPairMappingSchema),
}).strict();

export type PairEvaluation = z.infer<typeof PairEvaluationSchema>;
export type ReviewedPairMapping = z.infer<typeof ReviewedPairMappingSchema>;
export type PairEvaluationSnapshot = z.infer<typeof PairEvaluationSnapshotSchema>;
