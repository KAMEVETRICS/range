import { describe, expect, it } from "vitest";
import { parseEvent } from "@range/event-bus";
import { InstrumentRegistry } from "@range/instruments";
import { ReplayRunner, type ReplayEvent } from "./replay.js";
import type { WorkerPolicy } from "../../../apps/opportunity-worker/src/main.js";

export const testPolicy: WorkerPolicy = {
  runtime: "development", requestedNotionalUsd: "100", minimumNotionalUsd: "10", holdingHorizonMs: 1000,
  feesBpsByVenue: { a: "0", b: "0" }, slippageBpsByVenue: { a: "0", b: "0" },
  financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0",
};
/** Adds a reviewed mapping per underlying, pinned to the fixture's own instrument versions, after the last upsert. */
export function withReviewedMappings(events: ReplayEvent[]): ReplayEvent[] {
  const registry = new InstrumentRegistry();
  const members = new Map<string, string[]>();
  let lastUpsert = -1;
  events.forEach((event, index) => {
    if (event.kind !== "input" || event.topic !== "instrument.registry.v1" || event.payload.kind !== "upsert") return;
    const instrument = event.payload.instrument;
    registry.upsert(instrument);
    members.set(instrument.underlyingId, [...(members.get(instrument.underlyingId) ?? []), instrument.instrumentId]);
    lastUpsert = index;
  });
  const mappings = [...members].map(([underlyingId, ids]): ReplayEvent => ({
    kind: "input", atMs: events[lastUpsert]!.atMs, topic: "instrument.registry.v1", key: underlyingId,
    payload: parseEvent("instrument.registry.v1", { kind: "mapping", mapping: {
      underlyingId, mappingVersion: 1, compatibleExposure: "one share", reviewer: "replay fixture",
      reviewedAt: "2026-09-20T00:00:00.000Z",
      members: ids.map(instrumentId => ({ instrumentId, instrumentVersion: registry.getCurrent(instrumentId)!.version,
        metadataHash: registry.getCurrent(instrumentId)!.metadataHash })),
      proof: { contractMultiplier: "fixture", settlementAsset: "fixture", collateralAsset: "fixture",
        tradingSchedule: "fixture", economicExposure: "fixture" },
    } }),
  }));
  return [...events.slice(0, lastUpsert + 1), ...mappings, ...events.slice(lastUpsert + 1)];
}

export function replayFixture(): ReplayEvent[] {
  const at = 1_790_000_000_000;
  const events: ReplayEvent[] = [];
  for (const [venue, price] of [["a", "100"], ["b", "120"]] as const) {
    events.push({ kind: "input", atMs: at, topic: "instrument.registry.v1", key: venue, payload: parseEvent("instrument.registry.v1", { kind: "upsert", instrument: {
      instrumentId: `ins_${venue}`, underlyingId: "equity:DEMO", venue, venueSymbol: venue, productType: "perpetual",
      quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD", contractMultiplier: "1", tickSize: "0.01",
      lotSize: "0.001", minimumNotional: "10", capabilities: ["orderbook"], metadataVersion: 1,
      effectiveFrom: "2026-09-20T00:00:00.000Z", fundingInterval: 28800000,
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1,2,3,4,5], opensAt: "00:00", closesAt: "23:59" }] },
    } }) });
    events.push({ kind: "input", atMs: at, topic: "book.state.v1", key: venue, payload: parseEvent("book.state.v1", {
      eventId: `evt_${venue}`, schemaVersion: 1, venue, instrumentId: `ins_${venue}`, sequence: "101", transport: "replay",
      sourceTimestamp: at - 10, receivedTimestamp: at, freshnessBudgetMs: 1000, qualityFlags: [],
      rawPayloadRefOrHash: "sha256:synthetic", eligibility: "live", payload: { kind: "order_book",
        bids: [{ price, quantity: "100" }], asks: [{ price: `${Number(price) + 1}`, quantity: "100" }], capacityUsd: "10000" },
    }) });
    events.push({ kind: "input", atMs: at, topic: "funding.observation.v1", key: venue, payload: parseEvent("funding.observation.v1", {
      eventId: `evt_funding_${venue}`, schemaVersion: 1, venue, instrumentId: `ins_${venue}`, transport: "replay",
      sourceTimestamp: at - 10, receivedTimestamp: at, freshnessBudgetMs: 2000, qualityFlags: [],
      rawPayloadRefOrHash: "sha256:synthetic", eligibility: "live", payload: { kind: "funding", rateType: "predicted",
        rate: "0.0001", positiveRatePayer: "long", intervalMs: 28800000, nextSettlementMs: at + 500 },
    }) });
  }
  events.push({ kind: "checkpoint", atMs: at });
  return withReviewedMappings(events);
}

describe("deterministic replay", () => {
  it("rebuilds through the live evaluator with identical hashes after restart", async () => {
    const first = await new ReplayRunner(testPolicy).run(replayFixture(), "calc.v1");
    const second = await new ReplayRunner(testPolicy).run(replayFixture(), "calc.v1");
    expect(second.opportunities).toEqual(first.opportunities);
    expect(second.evidence.map(item => item.evidenceHash)).toEqual(first.evidence.map(item => item.evidenceHash));
    // $100 fills none of the fixture's prices exactly; every leg still quotes, so each result carries evidence.
    expect(first.evidence.length).toBe(4);
    // The reviewed pair is evaluated on its merits, not rejected as an unknown equivalence.
    expect(first.opportunities).toHaveLength(4);
    expect(first.opportunities.some(item => item.rejectionReasons.includes("UNKNOWN_INSTRUMENT_EQUIVALENCE"))).toBe(false);
  });

  it("reports missing, additional and changed evidence hashes at recorded checkpoints", async () => {
    const fixture = replayFixture();
    const checkpoint = fixture.at(-1)!;
    if (checkpoint.kind !== "checkpoint") throw new Error("fixture");
    checkpoint.expectedEvidenceHashes = [`sha256:${"0".repeat(64)}`];
    const result = await new ReplayRunner(testPolicy).run(fixture, "calc.v1");
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.expected).toEqual([`sha256:${"0".repeat(64)}`]);
    expect(result.drift[0]?.actual).toHaveLength(4);
  });

  it("rejects time regression instead of changing the recorded acceptance order", async () => {
    const events = replayFixture();
    events.at(-1)!.atMs = 1;
    await expect(new ReplayRunner(testPolicy).run(events, "calc.v1")).rejects.toThrow(/time/i);
  });

  it("keeps each underlying's debounce at its own due time", async () => {
    const at = 1_790_000_000_000;
    const original = replayFixture().filter(event => event.kind === "input");
    const isMapping = (event: ReplayEvent) => event.kind === "input" && event.topic === "instrument.registry.v1" &&
      event.payload.kind === "mapping";
    const other = withReviewedMappings(original.filter(event => !isMapping(event)).map(event => {
      const clone = JSON.parse(JSON.stringify(event).replaceAll("equity:DEMO", "equity:OTHER")
        .replaceAll("ins_a", "ins_other_a").replaceAll("ins_b", "ins_other_b")) as ReplayEvent;
      clone.atMs = at + 10;
      if (clone.kind === "input" && clone.topic === "instrument.registry.v1" && clone.payload.kind === "upsert") {
        clone.payload.instrument.venueSymbol += "_other";
      }
      if (clone.kind === "input" && clone.topic !== "instrument.registry.v1" && clone.topic !== "venue.health.v1") {
        const payload = clone.payload as unknown as { sourceTimestamp: number; receivedTimestamp: number };
        payload.sourceTimestamp += 10;
        payload.receivedTimestamp += 10;
      }
      return clone;
    }));
    const checkpoint: ReplayEvent = { kind: "checkpoint", atMs: at + 100 };
    const alone = await new ReplayRunner(testPolicy).run([...other, checkpoint], "calc.v1");
    const together = await new ReplayRunner(testPolicy).run([...original, ...other, checkpoint], "calc.v1");
    const expiry = (opportunities: typeof together.opportunities) => Date.parse(opportunities.find(
      item => item.underlyingId === "equity:OTHER" && item.strategy === "perp_spread")!.expiresAt);
    // A quoted opportunity lives until its oldest book is 2 s old; these books were sourced at `at`.
    expect(expiry(alone.opportunities)).toBe(at + 2_000);
    expect(expiry(together.opportunities)).toBe(at + 2_000);
  });

  it("advances due timers to the --to bound without flushing future work", async () => {
    const at = 1_790_000_000_000;
    const events = replayFixture();
    events.at(-1)!.atMs = at + 100;
    const full = await new ReplayRunner(testPolicy).run(events, "calc.v1");
    const bounded = await new ReplayRunner(testPolicy).run(events, "calc.v1", { toMs: at + 50 });
    expect(bounded.opportunities).toEqual(full.opportunities);
    expect(Date.parse(bounded.opportunities.find(item => item.strategy === "perp_spread")!.expiresAt)).toBe(at - 10 + 2_000);
  });
});
