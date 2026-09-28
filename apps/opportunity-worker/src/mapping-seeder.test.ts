import { expect, it } from "vitest";
import { InstrumentSchema } from "@range/domain";
import { SeedConfigSchema } from "@range/instruments";
import { createReviewedMappingSeeder } from "./mapping-seeder.js";

const instrument = InstrumentSchema.parse({
  instrumentId: "ins_bitget_SPOT_RNVDXUSDT", underlyingId: "bitget:rNVDX", venue: "bitget", venueFamily: "SPOT",
  venueSymbol: "RNVDXUSDT", quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT",
  productType: "tokenized_spot", contractMultiplier: "1", tickSize: "0.01", lotSize: "0.0001", minimumNotional: "1",
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["spot"], metadataVersion: 1, effectiveFrom: "2026-09-17T09:15:17.243Z",
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
