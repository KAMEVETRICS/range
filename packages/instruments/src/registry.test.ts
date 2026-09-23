import { describe, expect, it, vi } from "vitest";
import { InstrumentSchema, type Instrument } from "../../domain/src/index.js";
import { InstrumentRegistry } from "./registry.js";

const schedule = { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] };
function instrument(id: string, venue: string, venueFamily = "perps"): Instrument {
  return InstrumentSchema.parse({
    instrumentId: id, underlyingId: "venue-local:AAPL", productType: "perpetual", venue, venueFamily,
    venueSymbol: "AAPL", quoteAsset: "USD", settlementAsset: "USDC", collateralAsset: "USDC",
    contractMultiplier: "1", tickSize: "0.01", lotSize: "0.01", minimumNotional: "1",
    tradingSchedule: schedule, fundingInterval: 3_600_000, capabilities: ["perpetual", "orderbook"],
    metadata: { source: "official contract spec" }, metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
  });
}
const first = instrument("ins_bitget_AAPL", "bitget");
const second = instrument("ins_hip3_AAPL", "hyperliquid_hip3");

function reviewed(registry: InstrumentRegistry) {
  return {
    underlyingId: "equity:AAPL", mappingVersion: 1, compatibleExposure: "one AAPL share price unit per contract",
    reviewer: "research-team", reviewedAt: "2026-09-21T00:00:00.000Z",
    members: [first, second].map(item => ({ instrumentId: item.instrumentId, metadataHash: registry.getCurrent(item.instrumentId)!.metadataHash })),
    proof: {
      contractMultiplier: "official instrument specs checked for both contracts",
      settlementAsset: "official settlement documentation checked for both contracts",
      collateralAsset: "official collateral documentation checked for both contracts",
      tradingSchedule: "official session and holiday documentation checked for both contracts",
      economicExposure: "official underlying and payout terms checked for both contracts",
    },
  };
}

describe("InstrumentRegistry", () => {
  it("does not equate matching tickers without a reviewed mapping", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first); registry.upsert(second);
    expect(registry.resolveEquivalentInstruments("equity:AAPL")).toEqual([]);
  });

  it("resolves only uniquely identified venue symbols", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first);
    registry.upsert(instrument("ins_bitget_SPOT_AAPL", "bitget", "spot"));
    expect(registry.resolveVenueSymbol("bitget", "AAPL")).toBeUndefined();
    expect(registry.resolveVenueSymbol("bitget", "AAPL", "perps")?.instrument.instrumentId).toBe(first.instrumentId);
    expect(registry.resolveVenueSymbol("unknown", "AAPL")).toBeUndefined();
  });

  it("resolves a reviewed mapping pinned to current calculation metadata", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first); registry.upsert(second);
    registry.addReviewedMapping(reviewed(registry));
    expect(registry.resolveEquivalentInstruments("equity:AAPL").map(item => item.instrument.instrumentId))
      .toEqual([first.instrumentId, second.instrumentId]);
  });

  it("versions a multiplier change, emits withdrawal, and invalidates dependent equivalence", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first); registry.upsert(second); registry.addReviewedMapping(reviewed(registry));
    const events: unknown[] = [];
    registry.onCapabilityWithdrawal(event => events.push(event));
    const changed = { ...first, contractMultiplier: "10", effectiveFrom: "2026-09-22T00:00:00.000Z" };
    const result = registry.upsert(changed);
    expect(result.version).toBe(2);
    expect(result.withdrawnInstrumentIds).toEqual([first.instrumentId]);
    expect(events).toMatchObject([{ reason: "CAPABILITY_WITHDRAWN", instrumentId: first.instrumentId, withdrawnVersion: 1 }]);
    expect(registry.resolveEquivalentInstruments("equity:AAPL")).toEqual([]);
  });

  it("versions capability changes and ignores stale observations", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first);
    const changed = { ...first, capabilities: ["perpetual"], effectiveFrom: "2026-09-22T00:00:00.000Z" };
    expect(registry.upsert(changed).version).toBe(2);
    expect(registry.upsert(first).status).toBe("stale");
    expect(registry.getCurrent(first.instrumentId)?.instrument.capabilities).toEqual(["perpetual"]);
    expect(() => registry.upsert({ ...first, contractMultiplier: "2", effectiveFrom: changed.effectiveFrom })).toThrow(/conflicting observation/i);
  });

  it("does not let an older changed observation supersede a later unchanged observation", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first);
    registry.upsert({ ...first, effectiveFrom: "2026-09-22T00:00:00.000Z" });
    const result = registry.upsert({ ...first, contractMultiplier: "2", effectiveFrom: "2026-09-21T00:00:00.000Z" });
    expect(result.status).toBe("stale");
    expect(registry.getCurrent(first.instrumentId)?.version).toBe(1);
  });

  it("hashes metadata deterministically and excludes observation time", () => {
    const registry = new InstrumentRegistry();
    const initial = registry.upsert(first);
    const equivalent = { ...first, metadata: { source: "official contract spec" },
      effectiveFrom: "2026-09-21T00:00:00.000Z", metadataVersion: 99 };
    expect(registry.upsert(equivalent).version).toBe(1);
    expect(registry.getCurrent(first.instrumentId)?.metadataHash).toBe(initial.metadataHash);
  });

  it("rejects unverified, unknown, duplicate, and mismatched mapping members", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first); registry.upsert(second);
    const valid = reviewed(registry);
    expect(() => registry.addReviewedMapping({ ...valid, members: [...valid.members, valid.members[0]!] })).toThrow();
    expect(() => registry.addReviewedMapping({ ...valid, members: [{ instrumentId: "ins_missing", metadataHash: "a".repeat(64) }, valid.members[1]!] })).toThrow(/unknown instrument/i);
    expect(() => registry.addReviewedMapping({ ...valid, members: [{ ...valid.members[0]!, metadataHash: "b".repeat(64) }, valid.members[1]!] })).toThrow(/metadata hash/i);
    const uncertain = { ...second, capabilities: [...second.capabilities, "trading_schedule_unverified"] };
    registry.upsert({ ...uncertain, effectiveFrom: "2026-09-22T00:00:00.000Z" });
    const fresh = reviewed(registry);
    expect(() => registry.addReviewedMapping(fresh)).toThrow(/unverified/i);
  });

  it("rejects malformed JSON metadata and protects stored records from caller mutation", () => {
    const registry = new InstrumentRegistry();
    expect(() => registry.upsert({ ...first, metadata: { bad: () => 1 } } as unknown as Instrument)).toThrow();
    registry.upsert(first);
    const resolved = registry.getCurrent(first.instrumentId)!;
    resolved.instrument.capabilities.push("fabricated");
    expect(registry.getCurrent(first.instrumentId)?.instrument.capabilities).toEqual(["perpetual", "orderbook"]);
  });

  it("withdrawal subscription can be removed", () => {
    const registry = new InstrumentRegistry();
    registry.upsert(first);
    const listener = vi.fn();
    const unsubscribe = registry.onCapabilityWithdrawal(listener);
    unsubscribe();
    registry.upsert({ ...first, contractMultiplier: "2", effectiveFrom: "2026-09-22T00:00:00.000Z" });
    expect(listener).not.toHaveBeenCalled();
  });
});
