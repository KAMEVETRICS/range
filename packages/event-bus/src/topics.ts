import {
  EvidenceBundleSchema, FundingObservationPayloadSchema, ObservationEnvelopeSchema,
  OpportunitySchema, OrderBookObservationPayloadSchema, UnsignedIntentSchema, VenueHealthSchema,
} from "@range/domain";
import { z } from "zod";

// Raw bytes belong in object storage. The bus carries their canonical metadata
// and reference/hash; it never needs exchange credentials or auth responses.
export const RawMarketEventSchema = ObservationEnvelopeSchema.omit({ payload: true });
export const DeadLetterSchema = z.object({
  originalTopic: z.string().min(1),
  key: z.string(),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  errorCode: z.enum(["INVALID_JSON", "INVALID_SCHEMA"]),
  traceId: z.uuid(),
}).strict();

export const topicSchemas = {
  "market.raw.v1": RawMarketEventSchema,
  "market.observation.v1": ObservationEnvelopeSchema,
  "book.state.v1": ObservationEnvelopeSchema.extend({ payload: OrderBookObservationPayloadSchema }),
  "funding.observation.v1": ObservationEnvelopeSchema.extend({ payload: FundingObservationPayloadSchema }),
  "venue.health.v1": VenueHealthSchema,
  "opportunity.v1": OpportunitySchema,
  "evidence.bundle.v1": EvidenceBundleSchema,
  "intent.lifecycle.v1": UnsignedIntentSchema,
  "range.dead-letter.v1": DeadLetterSchema,
} as const;

export type Topic = keyof typeof topicSchemas;
export type TopicPayload = { [T in Topic]: z.output<(typeof topicSchemas)[T]> };

export function parseEvent<T extends Topic>(topic: T, event: unknown): TopicPayload[T] {
  return topicSchemas[topic].parse(event) as TopicPayload[T];
}
