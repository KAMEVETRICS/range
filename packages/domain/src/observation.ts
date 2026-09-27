import { z } from "zod";
import {
  DecimalStringSchema,
  EpochMillisecondsSchema,
  EventIdSchema,
  InstrumentIdSchema,
  IsoTimestampSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  VenueSchema,
} from "./ids.js";

export const DataEligibilitySchema = z.enum(["live", "delayed", "stale", "reference_only"]);

const PriceLevelSchema = z.object({
  price: PositiveDecimalStringSchema,
  quantity: NonNegativeDecimalStringSchema,
}).strict();

export const OrderBookObservationPayloadSchema = z.object({
  kind: z.literal("order_book"),
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  capacityUsd: NonNegativeDecimalStringSchema,
}).strict();

export const FundingObservationPayloadSchema = z.object({
  kind: z.literal("funding"),
  rateType: z.enum(["current", "predicted", "realized"]),
  rate: DecimalStringSchema,
  positiveRatePayer: z.enum(["long", "short"]).optional(),
  intervalMs: z.number().int().positive(),
  nextSettlementMs: EpochMillisecondsSchema,
}).strict();

export const IndexPriceObservationPayloadSchema = z.object({
  kind: z.literal("index_price"),
  price: PositiveDecimalStringSchema,
}).strict();

export const CanonicalObservationPayloadSchema = z.discriminatedUnion("kind", [
  OrderBookObservationPayloadSchema,
  FundingObservationPayloadSchema,
  IndexPriceObservationPayloadSchema,
]);

const observationEnvelopeFields = {
  eventId: EventIdSchema,
  schemaVersion: z.number().int().positive(),
  venue: VenueSchema,
  instrumentId: InstrumentIdSchema,
  sequence: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).optional(),
  sequencePolicy: z.literal("contiguous").optional(),
  sequenceReset: z.literal(true).optional(),
  transport: z.enum(["websocket", "rest", "replay"]),
  freshnessBudgetMs: z.number().int().positive(),
  qualityFlags: z.array(z.string().trim().min(1)),
  rawPayloadRefOrHash: z.string().trim().min(1),
  eligibility: DataEligibilitySchema,
  payload: CanonicalObservationPayloadSchema,
};

export const ObservationBoundaryEnvelopeSchema = z.object({
  ...observationEnvelopeFields,
  sourceTimestamp: IsoTimestampSchema,
  receivedTimestamp: IsoTimestampSchema,
}).strict();

export const ObservationEnvelopeSchema = z.object({
  ...observationEnvelopeFields,
  sourceTimestamp: EpochMillisecondsSchema,
  receivedTimestamp: EpochMillisecondsSchema,
}).strict();

export function toInternalObservationEnvelope(
  boundary: z.input<typeof ObservationBoundaryEnvelopeSchema>,
): z.output<typeof ObservationEnvelopeSchema> {
  const parsed = ObservationBoundaryEnvelopeSchema.parse(boundary);
  return ObservationEnvelopeSchema.parse({
    ...parsed,
    sourceTimestamp: Date.parse(parsed.sourceTimestamp),
    receivedTimestamp: Date.parse(parsed.receivedTimestamp),
  });
}

export type DataEligibility = z.infer<typeof DataEligibilitySchema>;
export type CanonicalObservationPayload = z.infer<typeof CanonicalObservationPayloadSchema>;
export type ObservationEnvelope<T extends CanonicalObservationPayload = CanonicalObservationPayload> = Omit<
  z.infer<typeof ObservationEnvelopeSchema>,
  "payload"
> & {
  payload: T;
};
