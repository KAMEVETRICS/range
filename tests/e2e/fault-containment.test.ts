import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../../packages/event-bus/src/index.js";
import { InstrumentRegistry } from "../../packages/instruments/src/index.js";
import { startOpportunityWorker } from "../../apps/opportunity-worker/src/main.js";
import { createTelemetry, instrumentEventBus } from "../../packages/observability/src/index.js";
import { ConnectorRuntime, type ConnectorAdapter } from "../../packages/connector-sdk/src/index.js";
import { InstrumentSchema } from "../../packages/domain/src/index.js";
import { ExtendedBookStreamMapper } from "../../connectors/extended/src/mapper.js";

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

function observation(id: string, venue: string, eventId: string, bid: string, ask: string, sequence?: string | number,
  sequencePolicy?: "contiguous", sequenceReset?: true) {
  return {
    eventId, schemaVersion: 1, venue, instrumentId: id, transport: "websocket" as const,
    sourceTimestamp: NOW - 10, receivedTimestamp: NOW - 5, freshnessBudgetMs: 2_000,
    qualityFlags: [], rawPayloadRefOrHash: `sha256:${eventId}`, eligibility: "live" as const,
    ...(sequence === undefined ? {} : { sequence }),
    ...(sequencePolicy === undefined ? {} : { sequencePolicy }),
    ...(sequenceReset === undefined ? {} : { sequenceReset }),
    payload: { kind: "order_book" as const, bids: [{ price: bid, quantity: "20" }],
      asks: [{ price: ask, quantity: "20" }], capacityUsd: "2000" },
  };
}

async function publishInputs(bus: InMemoryEventBus, validatedSequence = false) {
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
  await bus.publish("book.state.v1", "ins_a", observation("ins_a", "venue_a", "evt_book_a", "99", "100", 100,
    validatedSequence ? "contiguous" : undefined, validatedSequence ? true : undefined));
  await bus.publish("book.state.v1", "ins_b", observation("ins_b", "venue_b", "evt_book_b", "125", "126", 100));
}

function deterministicClock() {
  let now = NOW;
  let id = 0;
  const tasks = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, delay: number) {
      const key = id++; tasks.set(key, { due: now + delay, callback });
      return () => { tasks.delete(key); };
    },
    advanceBy(ms: number) {
      now += ms;
      for (const [key, task] of [...tasks].sort((a, b) => a[1].due - b[1].due)) {
        if (task.due <= now) { tasks.delete(key); task.callback(); }
      }
    },
  };
}

describe("assembled fault containment", () => {
  it("invalidates an opportunity when one connector feed becomes stale", async () => {
    const clock = deterministicClock();
    const telemetry = createTelemetry({ service: "fault-test", now: clock.now });
    const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
    const seen: Array<{ opportunityId: string; status: string; rejectionReasons: string[] }> = [];
    await bus.subscribe("opportunity.v1", "fault-assertion", async opportunity => { seen.push(opportunity); });
    const worker = await startOpportunityWorker(bus, registry(), { runtime: "development", now: clock.now,
      schedule: clock.schedule, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    await publishInputs(bus);
    await worker.flush();
    const actionable = seen.find(item => item.status === "actionable");
    expect(actionable).toBeDefined();

    // Freeze every input feed. The worker's real TTL timer, not a synthetic
    // reference-only event, must withdraw the opportunity.
    clock.advanceBy(2_001);
    await worker.settle();

    expect(seen).toContainEqual(expect.objectContaining({ opportunityId: actionable!.opportunityId,
      status: "expired", rejectionReasons: expect.arrayContaining(["STALE_INPUT"]) }));
    expect(telemetry.metrics.value("range_stale_rejections_total")).toBeGreaterThanOrEqual(1);
    await worker.stop();
  });

  it("records a sequence-gap fault before the opportunity can remain actionable", async () => {
    const telemetry = createTelemetry({ service: "gap-test", now: () => NOW });
    const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
    const seen: Array<{ opportunityId: string; status: string; rejectionReasons: string[] }> = [];
    await bus.subscribe("opportunity.v1", "gap-assertion", async opportunity => { seen.push(opportunity); });
    const worker = await startOpportunityWorker(bus, registry(), { runtime: "development", now: () => NOW, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    await publishInputs(bus, true);
    await worker.flush();
    const actionable = seen.find(item => item.status === "actionable");
    expect(actionable).toBeDefined();

    await bus.publish("book.state.v1", "ins_a",
      observation("ins_a", "venue_a", "evt_gap_102", "99", "100", 102, "contiguous"));
    await worker.flush();

    expect(seen).toContainEqual(expect.objectContaining({ opportunityId: actionable!.opportunityId,
      status: "expired", rejectionReasons: expect.arrayContaining(["BOOK_SEQUENCE_GAP"]) }));
    const blockedAt = seen.length;
    const gapRevision = worker.currentRevision("equity:TSLA");
    await bus.publish("book.state.v1", "ins_a",
      observation("ins_a", "venue_a", "evt_opaque_during_gap", "99", "100", "opaque", "contiguous"));
    await bus.publish("book.state.v1", "ins_a",
      observation("ins_a", "venue_a", "evt_still_gapped_103", "99", "100", 103, "contiguous"));
    await worker.flush();
    expect(worker.currentRevision("equity:TSLA")).toBe(gapRevision);
    expect(seen.slice(blockedAt).some(item => item.status === "actionable")).toBe(false);

    await bus.publish("book.state.v1", "ins_a", {
      ...observation("ins_a", "venue_a", "evt_clean_reset", "99", "100", 1, "contiguous", true),
      sourceTimestamp: NOW - 9, receivedTimestamp: NOW - 4,
    });
    await worker.flush();
    expect(seen.slice(blockedAt).some(item => item.status === "actionable")).toBe(true);
    await worker.stop();
  });

  it("expires an existing opportunity from a genuine Extended RFQ mapper gap health event", async () => {
    const telemetry = createTelemetry({ service: "extended-gap-test", now: () => NOW });
    const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
    const seen: Array<{ opportunityId: string; status: string; rejectionReasons: string[] }> = [];
    await bus.subscribe("opportunity.v1", "extended-gap-assertion", async opportunity => { seen.push(opportunity); });
    const rfqInstrument = InstrumentSchema.parse({ ...instrument("ins_a", "venue_a"), metadata: { isRfq: true } });
    const mapper = new ExtendedBookStreamMapper(rfqInstrument);
    let releaseGap!: () => void;
    const gapGate = new Promise<void>(resolve => { releaseGap = resolve; });
    const frame = (sequence: number, timestamp: number) => ({
      ts: timestamp, type: sequence === 1 ? "SNAPSHOT" as const : "DELTA" as const,
      data: { m: rfqInstrument.venueSymbol, b: [{ p: "99", q: "20", c: "20" }],
        a: [{ p: "100", q: "20", c: "20" }] }, seq: sequence,
    });
    const adapter: ConnectorAdapter = {
      venue: "venue_a",
      async probe() { return { available: true }; },
      async discover() { return [rfqInstrument]; },
      async snapshot() {
        return {
          eventId: "evt_extended_rest", instrumentId: rfqInstrument.instrumentId,
          sourceTimestampMs: NOW - 20, transport: "rest", freshnessBudgetMs: 2_000,
          qualityFlags: [], rawPayloadRefOrHash: "sha256:extended-rest", eligibility: "reference_only",
          payload: { kind: "order_book", bids: [], asks: [], capacityUsd: "0" },
        };
      },
      async *stream() {
        yield mapper.map(frame(1, NOW - 10));
        await gapGate;
        yield mapper.map(frame(3, NOW - 9));
      },
    };
    let firstSequence!: () => void;
    const firstSequencePublished = new Promise<void>(resolve => { firstSequence = resolve; });
    const connectorObservations: number[] = [];
    await bus.subscribe("market.observation.v1", "extended-gap-observations", async event => {
      if (event.sequence === 1) firstSequence();
      if (typeof event.sequence === "number") connectorObservations.push(event.sequence);
    });
    const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => NOW });
    const runtimeSession = runtime.runUntilDisconnected();
    await firstSequencePublished;

    const worker = await startOpportunityWorker(bus, registry(), { runtime: "development", now: () => NOW, debounceMs: 0,
      requestedNotionalUsd: "1000", minimumNotionalUsd: "100", holdingHorizonMs: 2_000,
      feesBpsByVenue: { venue_a: "3", venue_b: "3" }, slippageBpsByVenue: { venue_a: "2", venue_b: "2" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0" });
    await publishInputs(bus);
    await worker.flush();
    const actionable = seen.find(item => item.status === "actionable");
    expect(actionable).toBeDefined();

    releaseGap();
    await runtimeSession;
    await worker.flush();

    expect(connectorObservations).toEqual([1]);
    expect(runtime.health()).toMatchObject({ connectionState: "degraded", sequenceIntegrity: "gap" });
    expect(seen).toContainEqual(expect.objectContaining({ opportunityId: actionable!.opportunityId,
      status: "expired", rejectionReasons: expect.arrayContaining(["BOOK_SEQUENCE_GAP"]) }));
    expect(seen).not.toContainEqual(expect.objectContaining({ opportunityId: actionable!.opportunityId,
      status: "expired", rejectionReasons: expect.arrayContaining(["VENUE_DEGRADED"]) }));
    expect(telemetry.metrics.value("range_book_sequence_gaps_total", { venue: "venue_a" })).toBe(1);
    await worker.stop();
  });
});
