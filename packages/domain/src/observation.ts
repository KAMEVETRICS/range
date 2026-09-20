import { z } from "zod";
import {
  EventIdSchema,
  InstrumentIdSchema,
  IsoTimestampSchema,
  VenueSchema,
} from "./ids.js";

export const ObservationEnvelopeSchema = z.object({
  eventId: EventIdSchema,
  schemaVersion: z.number().int().positive(),
  venue: VenueSchema,
  instrumentId: InstrumentIdSchema,
  sourceTimestamp: IsoTimestampSchema,
  receivedTimestamp: IsoTimestampSchema,
  sequence: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).optional(),
  transport: z.enum(["websocket", "rest", "replay"]),
  freshnessBudgetMs: z.number().int().positive(),
  qualityFlags: z.array(z.string().trim().min(1)),
  rawPayloadRefOrHash: z.string().trim().min(1),
  payload: z.json(),
}).strict();

export type ObservationEnvelope<T> = Omit<z.infer<typeof ObservationEnvelopeSchema>, "payload"> & {
  payload: T;
};
