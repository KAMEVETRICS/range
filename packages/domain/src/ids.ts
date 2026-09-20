import { z } from "zod";

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const POSITIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN).brand<"DecimalString">();
export const NonNegativeDecimalStringSchema = z.string()
  .regex(POSITIVE_DECIMAL_PATTERN)
  .brand<"NonNegativeDecimalString">();
export const PositiveDecimalStringSchema = z.string()
  .regex(/^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/)
  .brand<"PositiveDecimalString">();
export const IsoTimestampSchema = z.iso.datetime({ offset: true }).brand<"IsoTimestamp">();
export const EpochMillisecondsSchema = z.number().int().nonnegative().brand<"EpochMilliseconds">();

export const InstrumentIdSchema = z.string().regex(/^ins_[A-Za-z0-9_.:-]+$/).brand<"InstrumentId">();
export const EventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_.:-]+$/).brand<"EventId">();
export const OpportunityIdSchema = z.string().regex(/^opp_[A-Za-z0-9_.:-]+$/).brand<"OpportunityId">();
export const EvidenceHashSchema = z.string().trim().min(1).brand<"EvidenceHash">();
export const VenueSchema = z.string().trim().min(1).brand<"Venue">();
export const UnderlyingIdSchema = z.string().trim().min(1).brand<"UnderlyingId">();

export const SideSchema = z.enum(["buy", "sell"]);

export type DecimalString = z.infer<typeof DecimalStringSchema>;
export type NonNegativeDecimalString = z.infer<typeof NonNegativeDecimalStringSchema>;
export type PositiveDecimalString = z.infer<typeof PositiveDecimalStringSchema>;
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type EpochMilliseconds = z.infer<typeof EpochMillisecondsSchema>;
export type InstrumentId = z.infer<typeof InstrumentIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type OpportunityId = z.infer<typeof OpportunityIdSchema>;
export type EvidenceHash = z.infer<typeof EvidenceHashSchema>;
export type Venue = z.infer<typeof VenueSchema>;
export type UnderlyingId = z.infer<typeof UnderlyingIdSchema>;
export type Side = z.infer<typeof SideSchema>;
