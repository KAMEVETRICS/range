import { z } from "zod";
import {
  IsoTimestampSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  InstrumentIdSchema,
  UnderlyingIdSchema,
  VenueSchema,
} from "./ids.js";

const TimeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const TradingSessionSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
  opensAt: TimeOfDaySchema,
  closesAt: TimeOfDaySchema,
}).strict();

export const TradingScheduleSchema = z.object({
  timezone: z.string().trim().min(1),
  sessions: z.array(TradingSessionSchema).min(1),
}).strict();

const instrumentFields = {
  instrumentId: InstrumentIdSchema,
  underlyingId: UnderlyingIdSchema,
  venue: VenueSchema,
  venueFamily: z.string().trim().min(1).optional(),
  venueSymbol: z.string().trim().min(1),
  quoteAsset: z.string().trim().min(1),
  settlementAsset: z.string().trim().min(1),
  collateralAsset: z.string().trim().min(1),
  contractMultiplier: PositiveDecimalStringSchema,
  tickSize: PositiveDecimalStringSchema,
  lotSize: PositiveDecimalStringSchema,
  minimumNotional: NonNegativeDecimalStringSchema,
  tradingSchedule: TradingScheduleSchema,
  capabilities: z.array(z.string().trim().min(1)).min(1),
  metadataVersion: z.number().int().positive(),
  effectiveFrom: IsoTimestampSchema,
};

const TokenizedSpotInstrumentSchema = z.object({
  ...instrumentFields,
  productType: z.literal("tokenized_spot"),
  fundingInterval: z.never().optional(),
}).strict();

const PerpetualInstrumentSchema = z.object({
  ...instrumentFields,
  productType: z.literal("perpetual"),
  fundingInterval: z.number().int().positive(),
}).strict();

export const InstrumentSchema = z.discriminatedUnion("productType", [
  TokenizedSpotInstrumentSchema,
  PerpetualInstrumentSchema,
]);

export type TradingSchedule = z.infer<typeof TradingScheduleSchema>;
export type Instrument = z.infer<typeof InstrumentSchema>;
