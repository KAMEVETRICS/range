import { describe, expect, it } from "vitest";
import { parseEvent } from "@range/event-bus";
import { ReplayRunner, type ReplayEvent } from "./replay.js";
import type { WorkerPolicy } from "../../../apps/opportunity-worker/src/main.js";

export const testPolicy: WorkerPolicy = {
  runtime: "development", requestedNotionalUsd: "100", minimumNotionalUsd: "10", holdingHorizonMs: 1000,
  feesBpsByVenue: { a: "0", b: "0" }, slippageBpsByVenue: { a: "0", b: "0" },
  financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0",
};
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
  return events;
}

describe("deterministic replay", () => {
  it("rebuilds through the live evaluator with identical hashes after restart", async () => {
    const first = await new ReplayRunner(testPolicy).run(replayFixture(), "calc.v1");
    const second = await new ReplayRunner(testPolicy).run(replayFixture(), "calc.v1");
    expect(second.opportunities).toEqual(first.opportunities);
    expect(second.evidence.map(item => item.evidenceHash)).toEqual(first.evidence.map(item => item.evidenceHash));
    expect(first.evidence.length).toBe(2);
    expect(first.opportunities.every(item => item.status === "rejected" && item.rejectionReasons.includes("UNKNOWN_INSTRUMENT_EQUIVALENCE"))).toBe(true);
  });

  it("reports missing, additional and changed evidence hashes at recorded checkpoints", async () => {
    const fixture = replayFixture();
    const checkpoint = fixture.at(-1)!;
    if (checkpoint.kind !== "checkpoint") throw new Error("fixture");
    checkpoint.expectedEvidenceHashes = [`sha256:${"0".repeat(64)}`];
    const result = await new ReplayRunner(testPolicy).run(fixture, "calc.v1");
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.expected).toEqual([`sha256:${"0".repeat(64)}`]);
    expect(result.drift[0]?.actual).toHaveLength(2);
  });

  it("rejects time regression instead of changing the recorded acceptance order", async () => {
    const events = replayFixture();
    events.at(-1)!.atMs = 1;
    await expect(new ReplayRunner(testPolicy).run(events, "calc.v1")).rejects.toThrow(/time/i);
  });
});
