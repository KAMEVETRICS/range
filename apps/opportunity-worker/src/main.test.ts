import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "@range/event-bus";
import { InstrumentRegistry } from "@range/instruments";
import { startOpportunityWorker } from "./main.js";

const NOW = 1_790_000_000_000;

function instrument(id: string, venue: string) {
  return {
    instrumentId: id, underlyingId: "equity:TSLA", productType: "perpetual" as const,
    venue, venueSymbol: id, quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD",
    contractMultiplier: "1", tickSize: "0.01", lotSize: "0.001", minimumNotional: "10",
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1,2,3,4,5], opensAt: "00:00", closesAt: "23:59" }] },
    capabilities: ["orderbook", "funding_current"], metadataVersion: 1,
    effectiveFrom: "2026-09-20T00:00:00.000Z", fundingInterval: 28_800_000,
  };
}

function book(id: string, venue: string, sidePrice: string, eventId: string) {
  return {
    eventId, schemaVersion: 1, venue, instrumentId: id, transport: "websocket" as const,
    sourceTimestamp: NOW - 50, receivedTimestamp: NOW - 40, freshnessBudgetMs: 2_000,
    qualityFlags: [], rawPayloadRefOrHash: "sha256:raw", eligibility: "live" as const,
    payload: { kind: "order_book" as const,
      bids: [{ price: sidePrice, quantity: "20" }], asks: [{ price: sidePrice === "100" ? "100.1" : "100.4", quantity: "20" }], capacityUsd: "2000" },
  };
}

describe("opportunity worker", () => {
  it("publishes an informative rejected candidate without reviewed mapping", async () => {
    const bus = new InMemoryEventBus();
    const registry = new InstrumentRegistry();
    registry.upsert(instrument("ins_a", "venue_a"));
    registry.upsert(instrument("ins_b", "venue_b"));
    const published: unknown[] = [];
    await bus.subscribe("opportunity.v1", "assert", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, { now: () => NOW, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_book_a"),
      payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }], asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await bus.publish("book.state.v1", "ins_b", { ...book("ins_b", "venue_b", "100.3", "evt_book_b"),
      payload: { kind: "order_book", bids: [{ price: "125", quantity: "20" }], asks: [{ price: "126", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    expect(published.some(item => (item as { status?: string }).status === "actionable")).toBe(false);
    expect(published.some(item => (item as { rejectionReasons?: string[] }).rejectionReasons?.includes("UNKNOWN_INSTRUMENT_EQUIVALENCE"))).toBe(true);
    await worker.stop();
  });

  it("expires an actionable result when its book changes to reference-only", async () => {
    const bus = new InMemoryEventBus();
    const registry = new InstrumentRegistry();
    registry.upsert(instrument("ins_a", "venue_a"));
    registry.upsert(instrument("ins_b", "venue_b"));
    const a = registry.getCurrent("ins_a")!;
    const b = registry.getCurrent("ins_b")!;
    registry.addReviewedMapping({
      underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
      reviewedAt: "2026-09-20T00:00:00.000Z",
      members: [a,b].map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
      proof: { contractMultiplier: "checked", settlementAsset: "checked", collateralAsset: "checked", tradingSchedule: "checked", economicExposure: "checked" },
    });
    const published: Array<{ opportunityId: string; status: string }> = [];
    await bus.subscribe("opportunity.v1", "assert-active", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, { now: () => NOW, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    for (const venue of ["venue_a", "venue_b"]) {
      await bus.publish("venue.health.v1", venue, { venue, connectionState: "connected", lastEventAgeMs: 10,
        clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" },
        capabilityChanges: [], errorCounters: {} } as never);
      await bus.publish("funding.observation.v1", venue, {
        eventId: `evt_funding_${venue}`, schemaVersion: 1, venue,
        instrumentId: venue === "venue_a" ? "ins_a" : "ins_b", transport: "websocket",
        sourceTimestamp: NOW - 10, receivedTimestamp: NOW - 5, freshnessBudgetMs: 2_000,
        qualityFlags: [], rawPayloadRefOrHash: "sha256:raw", eligibility: "live",
        payload: { kind: "funding", rateType: "predicted", rate: "0.0001", positiveRatePayer: "long",
          intervalMs: 28_800_000, nextSettlementMs: NOW + 1_000 },
      } as never);
    }
    await bus.publish("funding.observation.v1", "venue_a", {
      eventId: "evt_funding_venue_a_new", schemaVersion: 1, venue: "venue_a", instrumentId: "ins_a",
      transport: "websocket", sourceTimestamp: NOW - 8, receivedTimestamp: NOW - 4,
      freshnessBudgetMs: 2_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:new",
      eligibility: "live", payload: { kind: "funding", rateType: "predicted", rate: "0.0001",
        positiveRatePayer: "long", intervalMs: 28_800_000, nextSettlementMs: NOW + 1_000 },
    } as never);
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_book_a"),
      payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }], asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await bus.publish("book.state.v1", "ins_b", { ...book("ins_b", "venue_b", "100.3", "evt_book_b"),
      payload: { kind: "order_book", bids: [{ price: "125", quantity: "20" }], asks: [{ price: "126", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    const actionable = published.find(item => item.status === "actionable");
    expect(actionable).toBeDefined();
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_book_ref"), eligibility: "reference_only",
      payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }], asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    expect(published.some(item => item.opportunityId === actionable!.opportunityId && item.status === "expired")).toBe(true);
    await worker.stop();
  });
});
