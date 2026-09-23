import { describe, expect, it } from "vitest";
import { EvidenceBundleSchema } from "@range/domain";
import { buildEvidence } from "./builder.js";

const input = {
  sourceEventIds: ["evt_book_a", "evt_book_b"], calculationVersion: "calc.v1",
  canonicalMappingVersions: { "equity:TSLA": "map.v1" },
  assumptions: { holdingHorizonMs: { kind: "integer" as const, value: 86_400_000 }, requestedNotionalUsd: { kind: "decimal" as const, value: "1000" } },
  intermediateValues: { grossSpreadBps: { kind: "decimal" as const, value: "30" } }, warnings: ["non_atomic_fills"],
};

describe("buildEvidence", () => {
  it("hashes canonical UTF-8 JSON independent of object insertion order", () => {
    const first = buildEvidence(input);
    const reordered = buildEvidence({ ...input, assumptions: { requestedNotionalUsd: input.assumptions.requestedNotionalUsd, holdingHorizonMs: input.assumptions.holdingHorizonMs } });
    expect(first.evidenceHash).toBe(reordered.evidenceHash);
    expect(EvidenceBundleSchema.safeParse(first).success).toBe(true);
  });

  it("changes hash for source IDs, their meaningful order, and calculation version", () => {
    const first = buildEvidence(input).evidenceHash;
    expect(buildEvidence({ ...input, sourceEventIds: ["evt_book_a", "evt_book_c"] }).evidenceHash).not.toBe(first);
    expect(buildEvidence({ ...input, sourceEventIds: [...input.sourceEventIds].reverse() }).evidenceHash).not.toBe(first);
    expect(buildEvidence({ ...input, calculationVersion: "calc.v2" }).evidenceHash).not.toBe(first);
  });

  it("changes hash when a quoted input or mapping version changes", () => {
    const first = buildEvidence(input).evidenceHash;
    expect(buildEvidence({ ...input, intermediateValues: { ...input.intermediateValues, quotePrice: { kind: "decimal", value: "100.1" } } }).evidenceHash).not.toBe(first);
    expect(buildEvidence({ ...input, canonicalMappingVersions: { "equity:TSLA": "map.v2" } }).evidenceHash).not.toBe(first);
  });
});
