import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstrumentSchema } from "../packages/domain/src/index.js";
import { prepareSeed, runSeed } from "./seed-mappings.js";

const schedule = { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] };
const item = InstrumentSchema.parse({
  instrumentId: "ins_bitget_AAPL", underlyingId: "bitget:AAPL", productType: "perpetual", venue: "bitget",
  venueFamily: "USDT-FUTURES", venueSymbol: "AAPLUSDT", quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT",
  contractMultiplier: "1", tickSize: "0.01", lotSize: "0.01", minimumNotional: "1", tradingSchedule: schedule,
  fundingInterval: 3_600_000, capabilities: ["perpetual"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
});

const empty = { schemaVersion: 1, mappings: [], refusedCandidates: [{ venue: "bitget", venueSymbol: "AAPLUSDT", reason: "Trading schedule unverified" }] };

describe("mapping seed", () => {
  it("refuses an unknown venue symbol even when an instrument ID looks valid", () => {
    const config = { ...empty, mappings: [{
      underlyingId: "equity:AAPL", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
      reviewedAt: "2026-09-21T00:00:00.000Z", members: [
        { venue: "bitget", venueFamily: "USDT-FUTURES", venueSymbol: "MISSING", metadataHash: "a".repeat(64) },
        { venue: "hyperliquid_hip3", venueSymbol: "AAPL", metadataHash: "b".repeat(64) },
      ], proof: { contractMultiplier: "source", settlementAsset: "source", collateralAsset: "source", tradingSchedule: "source", economicExposure: "source" },
    }] };
    expect(() => prepareSeed(config, [item])).toThrow(/unknown or ambiguous venue symbol/i);
  });

  it("dry run prints a diff and does not create or replace output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "range-seed-"));
    try {
      const configPath = join(directory, "mappings.json");
      const outputPath = join(directory, "seeded.json");
      await writeFile(configPath, JSON.stringify(empty));
      await writeFile(outputPath, "existing-state");
      const lines: string[] = [];
      await runSeed({ configPath, outputPath, dryRun: true, log: line => lines.push(line) });
      expect(await readFile(outputPath, "utf8")).toBe("existing-state");
      expect(lines.join("\n")).toMatch(/dry run.*diff/i);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("apply writes validated state after showing the diff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "range-seed-"));
    try {
      const configPath = join(directory, "mappings.json");
      const outputPath = join(directory, "seeded.json");
      await writeFile(configPath, JSON.stringify(empty));
      const lines: string[] = [];
      await runSeed({ configPath, outputPath, dryRun: false, log: line => lines.push(line) });
      expect(lines.join("\n")).toMatch(/diff[\s\S]*applied/i);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ schemaVersion: 1, instruments: [], reviewedMappings: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
