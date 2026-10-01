import { z } from "zod";
import { RejectionCodeSchema } from "./opportunity.js";
import { IsoTimestampSchema, VenueSchema } from "./ids.js";

const RateLimitSchema = z.object({
  state: z.enum(["healthy", "limited", "backing_off", "unknown"]),
  retryAfterMs: z.number().int().positive().optional(),
}).strict();

const CapabilityChangeSchema = z.object({
  capability: z.string().trim().min(1),
  change: z.enum(["added", "removed"]),
  observedAt: IsoTimestampSchema,
}).strict();

export const VenueHealthSchema = z.object({
  venue: VenueSchema,
  connectionState: z.enum(["connected", "connecting", "reconnecting", "disconnected", "degraded", "quarantined"]),
  lastEventAgeMs: z.number().int().nonnegative(),
  clockSkewMs: z.number().int().nonnegative(),
  sequenceIntegrity: z.enum(["consistent", "gap", "unknown"]),
  rateLimit: RateLimitSchema,
  capabilityChanges: z.array(CapabilityChangeSchema),
  errorCounters: z.record(z.string(), z.number().int().nonnegative()),
  quarantineReason: RejectionCodeSchema.optional(),
}).strict();

export type VenueHealth = z.infer<typeof VenueHealthSchema>;
