import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstrumentSchema } from "../packages/domain/src/index.js";
import { calculationMetadataHash } from "../packages/instruments/src/versioning.js";
import { prepareSeed, runSeed } from "./seed-mappings.js";

const schedule = { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] };
const item = InstrumentSchema.parse({
  instrumentId: "ins_bitget_AAPL", underlyingId: "bitget:AAPL", productType: "perpetual", venue: "bitget",
  venueFamily: "USDT-FUTURES", venueSymbol: "AAPLUSDT", quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT",
  contractMultiplier: "1", tickSize: "0.01", lotSize: "0.01", minimumNotional: "1", tradingSchedule: schedule,
  fundingInterval: 3_600_000, capabilities: ["perpetual"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
});
const hip3 = InstrumentSchema.parse({ ...item, instrumentId: "ins_hip3_AAPL", venue: "hyperliquid_hip3",
  venueFamily: "hip3", venueSymbol: "AAPL" });
const extended = InstrumentSchema.parse({ ...item, instrumentId: "ins_extended_AAPL", venue: "extended",
  venueFamily: "perps", venueSymbol: "AAPL-USD" });

const empty = { schemaVersion: 1, mappings: [], refusedCandidates: [{ venue: "bitget", venueSymbol: "AAPLUSDT", reason: "Trading schedule unverified" }] };
function withMapping(second = hip3, economicExposure = "initial audited payout terms") {
  return { ...empty, mappings: [{
    underlyingId: "equity:AAPL", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
    reviewedAt: "2026-09-21T00:00:00.000Z",
    members: [item, second].map(instrument => ({ venue: instrument.venue, venueFamily: instrument.venueFamily,
      venueSymbol: instrument.venueSymbol, instrumentVersion: 1, metadataHash: calculationMetadataHash(instrument) })),
    proof: { contractMultiplier: "multiplier source", settlementAsset: "settlement source", collateralAsset: "collateral source",
      tradingSchedule: "schedule source", economicExposure },
  }] };
}

describe("mapping seed", () => {
  it("refuses an unknown venue symbol even when an instrument ID looks valid", () => {
    const config = { ...empty, mappings: [{
      underlyingId: "equity:AAPL", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
      reviewedAt: "2026-09-21T00:00:00.000Z", members: [
        { venue: "bitget", venueFamily: "USDT-FUTURES", venueSymbol: "MISSING", instrumentVersion: 1, metadataHash: "a".repeat(64) },
        { venue: "hyperliquid_hip3", venueSymbol: "AAPL", instrumentVersion: 1, metadataHash: "b".repeat(64) },
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

  it("shows changed members and proof at the same label, then refuses an unversioned apply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "range-seed-"));
    try {
      const configPath = join(directory, "mappings.json");
      const catalogPath = join(directory, "catalog.json");
      const outputPath = join(directory, "seeded.json");
      await writeFile(catalogPath, JSON.stringify([item, hip3, extended]));
      await writeFile(configPath, JSON.stringify(withMapping()));
      await runSeed({ configPath, catalogPath, outputPath, dryRun: false });
      const original = await readFile(outputPath, "utf8");
      await writeFile(configPath, JSON.stringify(withMapping(extended, "revised audited payout terms")));
      const lines: string[] = [];
      await runSeed({ configPath, catalogPath, outputPath, dryRun: true, log: line => lines.push(line) });
      const diff = lines.join("\n");
      expect(diff).toMatch(/~ mapping equity:AAPL@1/);
      expect(diff).toContain("ins_hip3_AAPL");
      expect(diff).toContain("ins_extended_AAPL");
      expect(diff).toContain("revised audited payout terms");
      expect(await readFile(outputPath, "utf8")).toBe(original);
      await expect(runSeed({ configPath, catalogPath, outputPath, dryRun: false, log: () => {} }))
        .rejects.toThrow(/same-version mapping content/i);
      expect(await readFile(outputPath, "utf8")).toBe(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("shows a changed instrument catalog even when mapping labels are unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "range-seed-"));
    try {
      const configPath = join(directory, "mappings.json");
      const catalogPath = join(directory, "catalog.json");
      const outputPath = join(directory, "seeded.json");
      await writeFile(configPath, JSON.stringify(empty));
      await writeFile(catalogPath, JSON.stringify([item]));
      await runSeed({ configPath, catalogPath, outputPath, dryRun: false, log: () => {} });
      const original = await readFile(outputPath, "utf8");
      await writeFile(catalogPath, JSON.stringify([{ ...item, metadata: { source: "new official catalog" } }]));
      const lines: string[] = [];
      await runSeed({ configPath, catalogPath, outputPath, dryRun: true, log: line => lines.push(line) });
      expect(lines.join("\n")).toMatch(/~ instrument ins_bitget_AAPL/);
      expect(lines.join("\n")).toContain("new official catalog");
      expect(await readFile(outputPath, "utf8")).toBe(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("shows a proof-only edit at the same mapping version and refuses apply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "range-seed-"));
    try {
      const configPath = join(directory, "mappings.json");
      const catalogPath = join(directory, "catalog.json");
      const outputPath = join(directory, "seeded.json");
      await writeFile(catalogPath, JSON.stringify([item, hip3]));
      await writeFile(configPath, JSON.stringify(withMapping()));
      await runSeed({ configPath, catalogPath, outputPath, dryRun: false, log: () => {} });
      const original = await readFile(outputPath, "utf8");
      await writeFile(configPath, JSON.stringify(withMapping(hip3, "updated payout proof")));
      const lines: string[] = [];
      await runSeed({ configPath, catalogPath, outputPath, dryRun: true, log: line => lines.push(line) });
      expect(lines.join("\n")).toMatch(/~ mapping equity:AAPL@1/);
      expect(lines.join("\n")).toContain("updated payout proof");
      await expect(runSeed({ configPath, catalogPath, outputPath, dryRun: false, log: () => {} }))
        .rejects.toThrow(/same-version mapping content/i);
      expect(await readFile(outputPath, "utf8")).toBe(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
