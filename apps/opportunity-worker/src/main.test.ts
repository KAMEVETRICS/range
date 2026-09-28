import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "@range/event-bus";
import { isCurrentAtRevision, type Opportunity } from "@range/domain";
import { InstrumentRegistry } from "@range/instruments";
import { startOpportunityWorker } from "./main.js";
import { createInMemoryRevisionAuthority, type RevisionAuthority } from "./revision-authority.js";

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

const policy = { runtime: "development" as const, now: () => NOW, debounceMs: 0, requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
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
  it("evaluates and routes health without copying every unrelated instrument that has a book", async () => {
    const bus = new InMemoryEventBus();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "unrelated-books", async event => { seen.push(event); });
    const registry = reviewedRegistry();
    for (let index = 0; index < 50; index++) {
      registry.upsert({ ...instrument(`ins_other_${index}`, "venue_other"), underlyingId: `equity:OTHER${index}` });
    }
    const worker = await startOpportunityWorker(bus, registry, policy);
    for (let index = 0; index < 50; index++) {
      await bus.publish("book.state.v1", `ins_other_${index}`,
        book(`ins_other_${index}`, "venue_other", "100", `evt_other_${index}`) as never);
    }
    await worker.flush();
    const copies = vi.spyOn(registry, "getCurrent");

    await publishEligibleInputs(bus);
    await worker.flush();

    expect(seen.some(event => event.status === "actionable")).toBe(true);
    expect(copies.mock.calls.length).toBeLessThan(50);
    await worker.stop();
  });

  it("preserves the numeric high-water through a malformed sequence invalidation", async () => {
    const bus = new InMemoryEventBus();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "opaque-sequence-replay", async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, reviewedRegistry(), policy);
    await publishEligibleInputs(bus);
    for (const [sequence, offset] of [["101", -3], ["opaque", -2]] as const) {
      await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", `evt_${sequence}`),
        sequence, sourceTimestamp: NOW + offset, receivedTimestamp: NOW + offset } as never);
      await worker.flush();
    }
    const revision = worker.currentRevision("equity:TSLA");
    const marker = seen.length;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_stale_100"),
      sequence: "100", sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1 } as never);
    await worker.flush();
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    expect(seen.slice(marker).some(event => event.status === "actionable")).toBe(false);
    expect(seen.filter(event => event.status === "actionable").some(event => worker.isCurrent(event))).toBe(false);
    await worker.stop();
  });

  it("does not revive an invalid newer book with an older live snapshot", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "invalid-book-replay", async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const before = worker.currentRevision("equity:TSLA");
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_crossed_new"),
      sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1,
      payload: { kind: "order_book", bids: [{ price: "101", quantity: "20" }],
        asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    const invalidRevision = worker.currentRevision("equity:TSLA");
    expect(invalidRevision).toBeGreaterThan(before);
    const marker = seen.length;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_delayed_old"),
      sourceTimestamp: NOW - 25, receivedTimestamp: NOW - 1,
      payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }],
        asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    expect(worker.currentRevision("equity:TSLA")).toBe(invalidRevision);
    expect(seen.slice(marker).some(event => event.status === "actionable")).toBe(false);
    await worker.stop();
  });

  it("rejects a lower sequence at equal source time even when received later", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "sequence-replay", async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_crossed_seq_101"),
      sequence: "101", sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 2,
      payload: { kind: "order_book", bids: [{ price: "101", quantity: "20" }],
        asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    const revision = worker.currentRevision("equity:TSLA");
    const marker = seen.length;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_delayed_seq_100"),
      sequence: "100", sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1,
      payload: { kind: "order_book", bids: [{ price: "99", quantity: "20" }],
        asks: [{ price: "100", quantity: "20" }], capacityUsd: "2000" } } as never);
    await worker.flush();
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    expect(seen.slice(marker).some(event => event.status === "actionable")).toBe(false);
    await worker.stop();
  });

  it("does not drop a sequence boundary when a later snapshot omits sequence", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const worker = await startOpportunityWorker(bus, registry, policy);
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_seq_101"),
      sequence: "101", sourceTimestamp: NOW - 2 } as never);
    const revision = worker.currentRevision("equity:TSLA");
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_unsequenced"),
      sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1 } as never);
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    await worker.stop();
  });

  it.each([undefined, null, 0])("fails closed when authority advance rejects %s", async reason => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const backing = createInMemoryRevisionAuthority();
    let failNext = false;
    const authority: RevisionAuthority = {
      kind: "volatile",
      async advance(underlyingId) {
        if (failNext) { failNext = false; return Promise.reject(reason); }
        return backing.advance(underlyingId);
      },
      read: underlyingId => backing.read(underlyingId),
    };
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", `authority-falsy-${String(reason)}`, async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, registry, { ...policy, revisionAuthority: authority });
    await publishEligibleInputs(bus);
    await worker.flush();
    const actionable = seen.find(event => event.status === "actionable")!;
    failNext = true;
    await expect(bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_authority_fails"),
      sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1, eligibility: "reference_only" } as never))
      .rejects.toThrow(/revision authority unavailable/i);
    expect(worker.isCurrent(actionable)).toBe(false);
    expect(() => worker.currentRevision("equity:TSLA")).toThrow(/revision authority unavailable/i);
    await worker.stop();
  });

  it.each([undefined, null, 0])("fails production startup when authority read rejects %s", async reason => {
    const authority: RevisionAuthority = {
      kind: "durable",
      advance: async () => 1,
      read: async () => Promise.reject(reason),
    };
    await expect(startOpportunityWorker(new InMemoryEventBus(), reviewedRegistry(), {
      ...policy, runtime: "production", revisionAuthority: authority,
    })).rejects.toThrow(/revision authority unavailable/i);
  });

  it("does not advance currentness for stale or unchanged registry upserts", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "no-registry-reevaluation", async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const revision = worker.currentRevision("equity:TSLA");
    const publications = seen.length;
    await bus.publish("instrument.registry.v1", "ins_a", { kind: "upsert", instrument: instrument("ins_a", "venue_a") } as never);
    await bus.publish("instrument.registry.v1", "ins_a", { kind: "upsert", instrument: {
      ...instrument("ins_a", "venue_a"), effectiveFrom: "2026-09-19T00:00:00.000Z",
    } } as never);
    await worker.flush();
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    expect(seen).toHaveLength(publications);
    await worker.stop();
  });

  it("does not poison currentness when a duplicate reviewed mapping is rejected", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const revision = worker.currentRevision("equity:TSLA");
    const mapping = registry.listReviewedMappings()[0]!;
    await bus.publish("instrument.registry.v1", "equity:TSLA", { kind: "mapping", mapping } as never);
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    await bus.publish("venue.health.v1", "venue_a", { venue: "venue_a", connectionState: "disconnected",
      lastEventAgeMs: 1_000, clockSkewMs: 0, sequenceIntegrity: "consistent",
      rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } as never);
    expect(worker.currentRevision("equity:TSLA")).toBeGreaterThan(revision);
    await worker.stop();
  });

  it("fails closed in production without a durable revision authority", async () => {
    await expect(startOpportunityWorker(new InMemoryEventBus(), reviewedRegistry(), {
      ...policy, runtime: "production",
    })).rejects.toThrow(/durable revision authority/i);
    await expect(startOpportunityWorker(new InMemoryEventBus(), reviewedRegistry(), {
      ...policy, runtime: "production", revisionAuthority: createInMemoryRevisionAuthority(),
    })).rejects.toThrow(/durable revision authority/i);
  });

  it("ignores a forbidden cross-underlying registry reassignment and keeps old output versioned", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const seen: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "identity-reassignment", async event => { seen.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const oldActionable = seen.find(event => event.status === "actionable")!;
    const revision = worker.currentRevision("equity:TSLA");
    await bus.publish("instrument.registry.v1", "ins_a", { kind: "upsert", instrument: {
      ...instrument("ins_a", "venue_a"), underlyingId: "equity:MSFT",
      effectiveFrom: "2026-09-22T00:00:00.000Z",
    } } as never);
    expect(registry.getCurrent("ins_a")?.instrument.underlyingId).toBe("equity:TSLA");
    expect(worker.currentRevision("equity:TSLA")).toBe(revision);
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_after_reassignment"),
      sourceTimestamp: NOW - 1, receivedTimestamp: NOW - 1, eligibility: "reference_only" } as never);
    expect(worker.isCurrent(oldActionable)).toBe(false);
    expect(isCurrentAtRevision(oldActionable, worker.currentRevision("equity:TSLA"), NOW)).toBe(false);
    await worker.stop();
  });
  it("drains the final naturally scheduled sentinel before resolving", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    let sentinelSeen = false;
    const seenEvidenceIds: string[][] = [];
    await bus.subscribe("evidence.bundle.v1", "drain-sentinel", async event => {
      seenEvidenceIds.push([...event.sourceEventIds]);
      if (event.sourceEventIds.includes("evt_final_sentinel")) sentinelSeen = true;
    });
    const worker = await startOpportunityWorker(bus, registry, { ...policy, debounceMs: 25 });
    await publishEligibleInputs(bus);
    await bus.publish("book.state.v1", "ins_b", { ...book("ins_b", "venue_b", "100.3", "evt_final_sentinel"), receivedTimestamp: NOW - 4,
      payload: { kind: "order_book", bids: [{ price: "125", quantity: "20" }], asks: [{ price: "200", quantity: "20" }], capacityUsd: "2000" } } as never);
    let drained = false;
    const draining = worker.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(24);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(sentinelSeen, JSON.stringify(seenEvidenceIds)).toBe(true);
    await worker.stop();
  });

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

  it("ignores a new event id with equal source time and older receive time", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ opportunityId: string; status: string }> = [];
    await bus.subscribe("opportunity.v1", "equal-source-older-receive", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    const actionable = published.find(item => item.status === "actionable")!;
    const before = published.length;
    await bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_old_receive"), receivedTimestamp: NOW - 60 } as never);
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

  it("cancels an evaluation invalidated during awaited evidence publication", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const published: Array<{ status: string }> = [];
    await bus.subscribe("opportunity.v1", "generation", async event => { published.push(event); });
    let invalidationAccepted = false;
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
    const invalidating = bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_invalidated"), eligibility: "reference_only" } as never)
      .then(() => { invalidationAccepted = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(invalidationAccepted).toBe(true);
    release();
    await flushing;
    await invalidating;
    expect(published.some(item => item.status === "actionable")).toBe(false);
    await worker.flush();
    expect(published.at(-1)?.status).not.toBe("actionable");
    await worker.stop();
  });

  it("marks an in-flight actionable stale when invalidation is accepted", async () => {
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
    let invalidationAccepted = false;
    let actionableCurrentOnDelivery = true;
    await bus.subscribe("opportunity.v1", "publication-order", async event => {
      if (event.status === "actionable" && invalidationAccepted) actionableCurrentOnDelivery = worker.isCurrent(event);
    });
    bus.publish = (async (topic: Parameters<typeof originalPublish>[0], key: string, event: never) => {
      if (topic === "opportunity.v1" && !blocked) { blocked = true; reached(); await gate; }
      return originalPublish(topic, key, event);
    }) as typeof bus.publish;
    const worker = await startOpportunityWorker(bus, registry, { ...policy, debounceMs: 25 });
    await publishEligibleInputs(bus);
    const flushing = worker.flush();
    await atOpportunity;
    const invalidating = bus.publish("book.state.v1", "ins_a", { ...book("ins_a", "venue_a", "100", "evt_during_opportunity"), eligibility: "reference_only" } as never)
      .then(() => { invalidationAccepted = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(invalidationAccepted).toBe(true);
    release();
    await flushing;
    await invalidating;
    await worker.flush();
    expect(actionableCurrentOnDelivery).toBe(false);
    expect(published.at(-1)?.status).not.toBe("actionable");
    await worker.stop();
  });
  it.each(["book", "funding", "health", "registry"] as const)(
    "accepts a %s invalidation awaited by a reentrant opportunity subscriber", async kind => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const worker = await startOpportunityWorker(bus, registry, policy);
    const seen: Array<{ status: string; stateRevision: number; opportunityId: string }> = [];
    let currentDuringCallback = true;
    let nested = false;
    await bus.subscribe("opportunity.v1", "reentrant-invalidation", async event => {
      seen.push(event);
      if (event.status !== "actionable" || nested) return;
      nested = true;
      if (kind === "book") {
        await bus.publish("book.state.v1", "ins_a", {
          ...book("ins_a", "venue_a", "100", "evt_reentrant_ref"), eligibility: "reference_only",
          receivedTimestamp: NOW - 1,
        } as never);
      } else if (kind === "funding") {
        await bus.publish("funding.observation.v1", "ins_a", {
          eventId: "evt_reentrant_funding", schemaVersion: 1, venue: "venue_a", instrumentId: "ins_a",
          transport: "websocket", sourceTimestamp: NOW - 2, receivedTimestamp: NOW - 1,
          freshnessBudgetMs: 2_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:reentrant",
          eligibility: "reference_only", payload: { kind: "funding", rateType: "predicted",
            rate: "0.0002", positiveRatePayer: "long", intervalMs: 28_800_000, nextSettlementMs: NOW + 1_000 },
        } as never);
      } else if (kind === "health") {
        await bus.publish("venue.health.v1", "venue_a", { venue: "venue_a", connectionState: "disconnected",
          lastEventAgeMs: 1_000, clockSkewMs: 0, sequenceIntegrity: "consistent",
          rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } as never);
      } else {
        await bus.publish("instrument.registry.v1", "ins_a", { kind: "upsert", instrument: {
          ...instrument("ins_a", "venue_a"), contractMultiplier: "2", effectiveFrom: "2026-09-21T00:00:00.000Z",
        } } as never);
      }
      currentDuringCallback = worker.isCurrent(event);
    });
    await publishEligibleInputs(bus);
    await worker.flush();
    expect(nested).toBe(true);
    expect(currentDuringCallback).toBe(false);
    const actionable = seen.find(event => event.status === "actionable")!;
    const expiry = seen.find(event => event.opportunityId === actionable.opportunityId && event.status === "expired")!;
    expect(expiry.stateRevision).toBeGreaterThan(actionable.stateRevision);
    await worker.stop();
  }, 1000);

  it("checks currentness against accepted revisions despite broker ack and reordered output delivery", async () => {
    const bus = new InMemoryEventBus();
    const registry = reviewedRegistry();
    const delivered: Opportunity[] = [];
    await bus.subscribe("opportunity.v1", "async-delivery", async event => { delivered.push(event); });
    const originalPublish = bus.publish.bind(bus);
    let releaseActionable: (() => Promise<void>) | undefined;
    let releaseInvalidation: (() => Promise<void>) | undefined;
    bus.publish = (async (topic: Parameters<typeof originalPublish>[0], key: string, event: never) => {
      if (topic === "opportunity.v1" && (event as { status: string }).status === "actionable" && !releaseActionable) {
        releaseActionable = () => originalPublish(topic, key, event);
        return; // Simulate a broker ack before subscriber delivery.
      }
      if (topic === "book.state.v1" && (event as { eventId: string }).eventId === "evt_async_ref") {
        releaseInvalidation = () => originalPublish(topic, key, event);
        return; // The worker has not accepted this input yet.
      }
      return originalPublish(topic, key, event);
    }) as typeof bus.publish;
    const worker = await startOpportunityWorker(bus, registry, policy);
    await publishEligibleInputs(bus);
    await worker.flush();
    expect(releaseActionable).toBeDefined();
    const revisionBefore = worker.currentRevision("equity:TSLA");
    await bus.publish("book.state.v1", "ins_a", {
      ...book("ins_a", "venue_a", "100", "evt_async_ref"), eligibility: "reference_only",
      receivedTimestamp: NOW - 1,
    } as never);
    expect(worker.currentRevision("equity:TSLA")).toBe(revisionBefore);
    await releaseInvalidation!();
    expect(worker.currentRevision("equity:TSLA")).toBeGreaterThan(revisionBefore);
    await worker.flush();
    await releaseActionable!(); // Delivers stale actionable after the expiry.
    const stale = delivered.at(-1)!;
    expect(stale.status).toBe("actionable");
    expect(worker.isCurrent(stale)).toBe(false);
    expect(delivered.some(event => event.opportunityId === stale.opportunityId &&
      event.status === "expired" && event.stateRevision > stale.stateRevision)).toBe(true);
    await worker.stop();
  });
  it("publishes an informative rejected candidate without reviewed mapping", async () => {
    const bus = new InMemoryEventBus();
    const registry = new InstrumentRegistry();
    registry.upsert(instrument("ins_a", "venue_a"));
    registry.upsert(instrument("ins_b", "venue_b"));
    const published: unknown[] = [];
    await bus.subscribe("opportunity.v1", "assert", async event => { published.push(event); });
    const worker = await startOpportunityWorker(bus, registry, { runtime: "development", now: () => NOW, debounceMs: 0,
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
    const worker = await startOpportunityWorker(bus, registry, { runtime: "development", now: () => NOW, debounceMs: 0,
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
