import { z } from "zod";
import { IsoTimestampSchema, InstrumentIdSchema, UnderlyingIdSchema } from "../../domain/src/index.js";

const MemberSchema = z.object({
  instrumentId: InstrumentIdSchema,
  instrumentVersion: z.number().int().positive(),
  metadataHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** A review must cite evidence for every economic field that can break a hedge. */
export const ReviewedMappingSchema = z.object({
  underlyingId: UnderlyingIdSchema,
  mappingVersion: z.number().int().positive(),
  compatibleExposure: z.string().trim().min(1),
  reviewer: z.string().trim().min(1),
  reviewedAt: IsoTimestampSchema,
  members: z.array(MemberSchema).min(2),
  proof: z.object({
    contractMultiplier: z.string().trim().min(1),
    settlementAsset: z.string().trim().min(1),
    collateralAsset: z.string().trim().min(1),
    tradingSchedule: z.string().trim().min(1),
    economicExposure: z.string().trim().min(1),
  }).strict(),
}).strict();

export type ReviewedMapping = z.infer<typeof ReviewedMappingSchema>;

const EvidenceReferenceSchema = z.string().trim().refine(value => {
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "Evidence must be an HTTPS primary reference or a SHA-256 content reference");

export const LiveVenueEvidenceSchema = z.object({
  venue: z.string().trim().min(1),
  observedAt: IsoTimestampSchema,
  primarySourceUrl: z.string().url().refine(value => new URL(value).protocol === "https:", "Primary source must use HTTPS"),
  product: EvidenceReferenceSchema,
  fees: EvidenceReferenceSchema,
  funding: EvidenceReferenceSchema,
  sequence: EvidenceReferenceSchema,
  recovery: EvidenceReferenceSchema,
  rateLimit: EvidenceReferenceSchema,
  marketHours: EvidenceReferenceSchema,
}).strict();

export const SeedMappingSchema = ReviewedMappingSchema.omit({ members: true }).extend({
  members: z.array(z.object({
    venue: z.string().trim().min(1),
    venueFamily: z.string().trim().min(1).optional(),
    venueSymbol: z.string().trim().min(1),
    // A review pins the metadata hash, which every registry computes alike. The optional version only records what the
    // reviewing deployment's registry numbered that metadata: registries number versions in the order they see
    // metadata, so another one can number it differently, and matching ignores it.
    instrumentVersion: z.number().int().positive().optional(),
    metadataHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(2),
  // Operational release evidence is kept beside the reviewed declaration but
  // is not part of the runtime equivalence object or metadata hash.
  liveEvidence: z.array(LiveVenueEvidenceSchema).optional(),
}).strict();

export const SeedConfigSchema = z.object({
  schemaVersion: z.literal(1),
  mappings: z.array(SeedMappingSchema),
  refusedCandidates: z.array(z.object({
    venue: z.string().trim().min(1),
    venueSymbol: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }).strict()),
}).strict();
