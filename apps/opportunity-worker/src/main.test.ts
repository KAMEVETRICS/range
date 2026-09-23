import { afterEach, describe, expect, it, vi } from "vitest";
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

function reviewedRegistry() {
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
  return registry;
}

const policy = { now: () => NOW, debounceMs: 0, requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
  feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
  financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" };

async function publishEligibleInputs(bus: InMemoryEventBus) {
  for (const [venue, id] of [["venue_a", "ins_a"], ["venue_b", "ins_b"]] as const) {
    await bus.publish("venue.health.v1", venue, { venue, connectionState: "connected", lastEventAgeMs: 10,
      clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } as never);
    await bus.publish("funding.observation.v1", id, {
      eventId: `evt_funding_${venue}`, schemaVersion: 1, venue, instrumentId: id, transport: "websocket",
      sourceTimestamp: NOW - 10, receivedTimestamp: NOW - 5, freshnessBudgetMs: 2_000, qualityFlags: [],
      rawPayloadRefOrHash: "sha256:funding", eligibility: "live", payload: { kind: "funding", rateType: "predicted",
        rate: "0.0001", positiveRatePayer: "long", intervalMs: 28_800_000, nextSettlementMs: NOW + 1_000 },
    } as never);
  }
  await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_book_a"),
    payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }], asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
  await bus.publish("book.state.v1", "ins_b", { ...book("ins_b", "venue_b", "100.3", "evt_book_b"),
    payload: { kind: "order_book", bids: [{ price: "125", quantity: "20" }], asks: [{ price: "126", quantity: "20" }], capacityUsd: "2000" } } as never);
}

afterEach(() => vi.useRealTimers());

describe("opportunity worker", () => {
  it("publishes within 25ms of the first event during a continuous fast stream", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: unknown[] = [];
    await bus.subscribe("opportunity.v1", "bounded-debounce", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, { ...policy, debounceMs: 25 });
    await bus.publish("book.state.v1", "ins_b", book("ins_b", "venue_b", "100.3", "evt_fast_b") as never);
    for (let index = 0; index < 6; index++) {
      await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", `evt_fast_${index}`),
        sourceTimestamp: NOW - 40 + index, receivedTimestamp: NOW - 30 + index } as never);
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(published.length).toBeGreaterThan(0);
    await worker.stop();
  });

  it("propagates disqualifying book quality flags into rejection", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ status: string; freshness: { qualityFlags: string[] } }> = [];
    await bus.subscribe("opportunity.v1", "quality", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const marker = published.length;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_flagged"), qualityFlags: ["suspect_clock"] } as never);
    await worker.flush();
    expect(published.slice(marker).some(item => item.status === "actionable")).toBe(false);
    expect(published.slice(marker).some(item => item.freshness.qualityFlags.includes("suspect_clock"))).toBe(true);
    await worker.stop();
  });

  it("ignores duplicate and older book snapshots without expiring active lifecycle", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ opportunityId: string; status: string }> = [];
    await bus.subscribe("opportunity.v1", "dedupe", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const actionable = published.find(item => item.status === "actionable")!;
    const before = published.length;
    await bus.publish("book.state.v1", "ins_a", book("ins_a", "venue_a", "100", "evt_book_a") as never);
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_older"), sourceTimestamp: NOW - 100 } as never);
    await worker.flush();
    expect(published.slice(before).some(item => item.opportunityId === actionable.opportunityId && item.status === "expired")).toBe(false);
    await worker.stop();
  });

  it("clears version-pinned market caches before evaluating a replacement mapping", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ status: string }> = [];
    await bus.subscribe("opportunity.v1", "version-pin", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    expect(published.some(item => item.status === "actionable")).toBe(true);
    const marker = published.length;
    await bus.publish("instrument.registry.v1", "ins_a", { kind: "upsert", instrument: {
      ...instrument("ins_a", "venue_a"), contractMultiplier: "2", effectiveFrom: "2026-09-21T00:00:00.000Z",
    } } as never);
    const a = registry.getCurrent("ins_a")!;
    const b = registry.getCurrent("ins_b")!;
    await bus.publish("instrument.registry.v1", "equity:TSLA", { kind: "mapping", mapping: {
      underlyingId: "equity:TSLA", mappingVersion: 2, compatibleExposure: "two shares", reviewer: "reviewer",
      reviewedAt: "2026-09-21T00:00:00.000Z",
      members: [a,b].map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
      proof: { contractMultiplier: "rechecked", settlementAsset: "checked", collateralAsset: "checked", tradingSchedule: "checked", economicExposure: "checked" },
    } } as never);
    await worker.flush();
    expect(published.slice(marker).some(item => item.status === "actionable")).toBe(false);
    await worker.stop();
  });

  it("drops an actionable publication when invalidated during awaited evidence publication", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ status: string }> = [];
    await bus.subscribe("opportunity.v1", "generation", async event => { published.push(event); });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const atEvidence = new Promise<void>(resolve => { reached = resolve; });
    const originalPublish = bus.publish.bind(bus);
    bus.publish = (async (topic: Parameters<typeof originalPublish>[0], key: string, event: never) => {
      if (topic === "evidence.bundle.v1") { reached(); await gate; }
      return originalPublish(topic, key, event);
    }) as typeof bus.publish;
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    const flushing = worker.flush();
    await atEvidence;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_invalidated"), eligibility: "reference_only" } as never);
    release();
    await flushing;
    expect(published.some(item => item.status === "actionable")).toBe(false);
    await worker.stop();
  });

  it("does not register an actionable lifecycle invalidated during awaited opportunity publication", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ opportunityId: string; status: string }> = [];
    await bus.subscribe("opportunity.v1", "publish-generation", async event => { published.push(event); });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const atOpportunity = new Promise<void>(resolve => { reached = resolve; });
    const originalPublish = bus.publish.bind(bus);
    let blocked = false;
    bus.publish = (async (topic: Parameters<typeof originalPublish>[0], key: string, event: never) => {
      if (topic === "opportunity.v1" && !blocked) { blocked = true; reached(); await gate; }
      return originalPublish(topic, key, event);
    }) as typeof bus.publish;
    const worker = await startOpportunityWorker(bus, registry, { ...policy, debounceMs: 25 });
    await publishEligibleInputs(bus);
    const flushing = worker.flush();
    await atOpportunity;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_during_opportunity"), eligibility: "reference_only" } as never);
    release();
    await flushing;
    const stalePublication = published.find(item => item.status === "actionable")!;
    await bus.publish("venue.health.v1", "venue_a", { venue: "venue_a", connectionState: "degraded", lastEventAgeMs: 10,
      clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } as never);
    await worker.flush();
    expect(published.some(item => item.opportunityId === stalePublication.opportunityId && item.status === "expired")).toBe(false);
    await worker.stop();
  });
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
