import { expect, it } from "vitest";
import { InstrumentSchema } from "@range/domain";
import { calculationMetadataHash, InstrumentRegistry, SeedConfigSchema } from "@range/instruments";
import { createReviewedMappingSeeder } from "./mapping-seeder.js";

const instrument = InstrumentSchema.parse({
  instrumentId: "ins_bitget_SPOT_RNVDXUSDT", underlyingId: "bitget:rNVDX", venue: "bitget", venueFamily: "SPOT",
  venueSymbol: "RNVDXUSDT", quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT",
  productType: "tokenized_spot", contractMultiplier: "1", tickSize: "0.01", lotSize: "0.0001", minimumNotional: "1",
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["spot"], metadataVersion: 1, effectiveFrom: "2026-09-17T09:15:17.243Z",
});
const perp = (id: string, venue: string, capabilities: string[], effectiveFrom: string) => InstrumentSchema.parse({
  ...instrument, instrumentId: id, venue, venueFamily: undefined, venueSymbol: id, productType: "perpetual", underlyingId: `${venue}:TSLA`,
  fundingInterval: 3_600_000, capabilities, effectiveFrom });
const proof = { contractMultiplier: "1", settlementAsset: "USD", collateralAsset: "USD", tradingSchedule: "24/7", economicExposure: "TSLA" };

it("waits through earlier versions on replay and publishes a review once its members reach the reviewed metadata", async () => {
  const aBefore = perp("ins_a", "venue_a", ["perpetual", "trading_schedule_unverified"], "2026-09-20T00:00:00.000Z");
  const aReviewed = perp("ins_a", "venue_a", ["perpetual"], "2026-09-29T00:00:00.000Z");
  const b = perp("ins_b", "venue_b", ["perpetual"], "2026-09-20T00:00:00.000Z");
  const expected = new InstrumentRegistry();
  for (const item of [aBefore, aReviewed, b]) expected.upsert(item);
  const member = (id: string, venue: string) => {
    const current = expected.getCurrent(id)!;
    return { venue, venueSymbol: id, instrumentVersion: current.version, metadataHash: current.metadataHash };
  };
  const published: Array<{ mapping: { members: Array<{ instrumentId: string; instrumentVersion: number }> } }> = [];
  const seeder = createReviewedMappingSeeder(SeedConfigSchema.parse({ schemaVersion: 1, refusedCandidates: [], mappings: [{
    underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
    reviewedAt: "2026-09-29T00:00:00.000Z", members: [member("ins_a", "venue_a"), member("ins_b", "venue_b")], proof,
  }] }), async (_underlyingId, event) => { published.push(event as never); });

  await seeder({ kind: "upsert", instrument: aBefore });
  await expect(seeder({ kind: "upsert", instrument: b })).resolves.toBeUndefined();
  expect(published).toEqual([]);
  await seeder({ kind: "upsert", instrument: aReviewed });
  await seeder({ kind: "upsert", instrument: b });
  expect(published.map(event => event.mapping.members.map(item => [item.instrumentId, item.instrumentVersion])))
    .toEqual([[["ins_a", 2], ["ins_b", 1]]]);
});

it("publishes a review on a new registry that numbers the reviewed metadata differently", async () => {
  // The reviewing deployment's registry saw earlier metadata first and numbered the reviewed metadata 2; a new one
  // sees the reviewed metadata first, as version 1.
  const a = perp("ins_a", "venue_a", ["perpetual"], "2026-09-29T00:00:00.000Z");
  const b = perp("ins_b", "venue_b", ["perpetual"], "2026-09-20T00:00:00.000Z");
  const published: Array<{ mapping: { members: Array<{ instrumentId: string; instrumentVersion: number }> } }> = [];
  const seeder = createReviewedMappingSeeder(SeedConfigSchema.parse({ schemaVersion: 1, refusedCandidates: [], mappings: [{
    underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
    reviewedAt: "2026-09-29T00:00:00.000Z", proof, members: [
      { venue: "venue_a", venueSymbol: "ins_a", instrumentVersion: 2, metadataHash: calculationMetadataHash(a) },
      { venue: "venue_b", venueSymbol: "ins_b", metadataHash: calculationMetadataHash(b) },
    ],
  }] }), async (_underlyingId, event) => { published.push(event as never); });

  await seeder({ kind: "upsert", instrument: a });
  await seeder({ kind: "upsert", instrument: b });
  expect(published.map(event => event.mapping.members.map(item => [item.instrumentId, item.instrumentVersion])))
    .toEqual([[["ins_a", 1], ["ins_b", 1]]]);
});

it("skips a metadata change reported at an unchanged effective time instead of crash-looping", async () => {
  const published: unknown[] = [];
  const seeder = createReviewedMappingSeeder(SeedConfigSchema.parse({ schemaVersion: 1, mappings: [], refusedCandidates: [] }),
    async (_underlyingId, event) => { published.push(event); });

  await seeder({ kind: "upsert", instrument });
  const changedLot = InstrumentSchema.parse({ ...instrument, lotSize: "1" });
  const other = InstrumentSchema.parse({ ...instrument, instrumentId: "ins_bitget_SPOT_RAAOXUSDT",
    venueSymbol: "RAAOXUSDT", underlyingId: "bitget:rAAOX" });
  await expect(seeder({ kind: "upsert", instrument: changedLot })).resolves.toBeUndefined();
  await expect(seeder({ kind: "upsert", instrument: other })).resolves.toBeUndefined();
  expect(published).toEqual([]);
});
