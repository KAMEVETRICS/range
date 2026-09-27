import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../../packages/event-bus/src/index.js";
import { InstrumentRegistry } from "../../packages/instruments/src/index.js";
import { startOpportunityWorker } from "../../apps/opportunity-worker/src/main.js";
import { createTelemetry, instrumentEventBus } from "../../packages/observability/src/index.js";

const NOW = 1_790_000_000_000;

function instrument(id: string, venue: string) {
  return {
    instrumentId: id, underlyingId: "equity:TSLA", productType: "perpetual" as const,
    venue, venueSymbol: id, quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD",
    contractMultiplier: "1", tickSize: "0.01", lotSize: "0.001", minimumNotional: "10",
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5], opensAt: "00:00", closesAt: "23:59" }] },
    capabilities: ["orderbook", "funding_current"], metadataVersion: 1,
    effectiveFrom: "2026-09-20T00:00:00.000Z", fundingInterval: 28_800_000,
  };
}

function registry() {
  const value = new InstrumentRegistry();
  value.upsert(instrument("ins_a", "venue_a"));
  value.upsert(instrument("ins_b", "venue_b"));
  const members = [value.getCurrent("ins_a")!, value.getCurrent("ins_b")!];
  value.addReviewedMapping({
    underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "test-reviewer",
    reviewedAt: "2026-09-20T00:00:00.000Z",
    members: members.map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
    proof: { contractMultiplier: "fixture", settlementAsset: "fixture", collateralAsset: "fixture", tradingSchedule: "fixture", economicExposure: "fixture" },
  });
  return value;
}

function observation(id: string, venue: string, eventId: string, bid: string, ask: string) {
  return {
    eventId, schemaVersion: 1, venue, instrumentId: id, transport: "websocket" as const,
    sourceTimestamp: NOW - 10, receivedTimestamp: NOW - 5, freshnessBudgetMs: 2_000,
    qualityFlags: [], rawPayloadRefOrHash: `sha256:${eventId}`, eligibility: "live" as const,
    payload: { kind: "order_book" as const, bids: [{ price: bid, quantity: "20" }],
      asks: [{ price: ask, quantity: "20" }], capacityUsd: "2000" },
  };
}

async function publishInputs(bus: InMemoryEventBus) {
  for (const [venue, id] of [["venue_a", "ins_a"], ["venue_b", "ins_b"]] as const) {
    await bus.publish("venue.health.v1", venue, { venue, connectionState: "connected", lastEventAgeMs: 10,
      clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} });
    await bus.publish("funding.observation.v1", id, {
      eventId: `evt_funding_${venue}`, schemaVersion: 1, venue, instrumentId: id, transport: "websocket",
      sourceTimestamp: NOW - 10, receivedTimestamp: NOW - 5, freshnessBudgetMs: 2_000, qualityFlags: [],
      rawPayloadRefOrHash: `sha256:funding_${venue}`, eligibility: "live", payload: { kind: "funding", rateType: "predicted",
        rate: "0.0001", positiveRatePayer: "long", intervalMs: 28_800_000, nextSettlementMs: NOW + 1_000 },
    });
  }
  await bus.publish("book.state.v1", "ins_a", observation("ins_a", "venue_a", "evt_book_a", "99", "100"));
  await bus.publish("book.state.v1", "ins_b", observation("ins_b", "venue_b", "evt_book_b", "125", "126"));
}

describe("assembled fault containment", () => {
  it("invalidates an opportunity when one connector feed becomes stale", async () => {
    const telemetry = createTelemetry({ service: "fault-test", now: () => NOW });
    const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
    const seen: Array<{ opportunityId: string; status: string; rejectionReasons: string[] }> = [];
    await bus.subscribe("opportunity.v1", "fault-assertion", async opportunity => { seen.push(opportunity); });
    const worker = await startOpportunityWorker(bus, registry(), { runtime: "development", now: () => NOW, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    await publishInputs(bus);
    await worker.flush();
    const actionable = seen.find(item => item.status === "actionable");
    expect(actionable).toBeDefined();

    await bus.publish("book.state.v1", "ins_a", {
      ...observation("ins_a", "venue_a", "evt_stale", "99", "100"), eligibility: "reference_only",
    });
    await worker.flush();

    expect(seen).toContainEqual(expect.objectContaining({ opportunityId: actionable!.opportunityId,
      status: "expired", rejectionReasons: expect.arrayContaining(["STALE_INPUT"]) }));
    expect(telemetry.metrics.value("range_stale_rejections_total")).toBeGreaterThanOrEqual(1);
    await worker.stop();
  });

  it("records a sequence-gap fault before the opportunity can remain actionable", async () => {
    const telemetry = createTelemetry({ service: "gap-test", now: () => NOW });
    const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
    await bus.publish("venue.health.v1", "venue_a", { venue: "venue_a", connectionState: "degraded", lastEventAgeMs: 10,
      clockSkewMs: 0, sequenceIntegrity: "gap", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} });
    expect(telemetry.metrics.value("range_book_sequence_gaps_total", { venue: "venue_a" })).toBe(1);
  });
});
