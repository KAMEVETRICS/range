import { z } from "zod";
import { IsoTimestampSchema, InstrumentIdSchema, UnderlyingIdSchema } from "../../domain/src/index.js";

const MemberSchema = z.object({
  instrumentId: InstrumentIdSchema,
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

export const SeedMappingSchema = ReviewedMappingSchema.omit({ members: true }).extend({
  members: z.array(z.object({
    venue: z.string().trim().min(1),
    venueFamily: z.string().trim().min(1).optional(),
    venueSymbol: z.string().trim().min(1),
    metadataHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(2),
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
