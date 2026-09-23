import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { InMemoryEventBus } from "@range/event-bus";
import { InstrumentRegistry } from "@range/instruments";
import { startOpportunityWorker } from "./main.js";

const COUNT = 10_000;
const T = 1_790_000_000_000;
const registry = new InstrumentRegistry();
const instrument = (id: string, venue: string) => ({
  instrumentId: id, underlyingId: "equity:TSLA", productType: "perpetual" as const,
  venue, venueSymbol: id, quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD",
  contractMultiplier: "1", tickSize: "0.01", lotSize: "0.001", minimumNotional: "10",
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1,2,3,4,5], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["orderbook", "funding_current"], metadataVersion: 1,
  effectiveFrom: "2026-09-20T00:00:00.000Z", fundingInterval: 28_800_000,
});
registry.upsert(instrument("ins_a", "venue_a"));
registry.upsert(instrument("ins_b", "venue_b"));
const a = registry.getCurrent("ins_a")!;
const b = registry.getCurrent("ins_b")!;
registry.addReviewedMapping({
  underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "benchmark fixture",
  reviewedAt: "2026-09-20T00:00:00.000Z",
  members: [a,b].map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
  proof: { contractMultiplier: "fixture", settlementAsset: "fixture", collateralAsset: "fixture", tradingSchedule: "fixture", economicExposure: "fixture" },
});

const bus = new InMemoryEventBus();
const observationStarted = new Map<string, number>();
const evidenceStarted = new Map<string, number>();
const actionableLatencies: number[] = [];
let publishedOpportunities = 0;
let actionableOpportunities = 0;
await bus.subscribe("evidence.bundle.v1", "benchmark-evidence", async evidence => {
  const starts = evidence.sourceEventIds.flatMap(id => observationStarted.has(id) ? [observationStarted.get(id)!] : []);
  if (starts.length) evidenceStarted.set(evidence.evidenceHash, Math.min(...starts));
});
await bus.subscribe("opportunity.v1", "benchmark-count", async opportunity => {
  publishedOpportunities += 1;
  if (opportunity.status !== "actionable") return;
  actionableOpportunities += 1;
  const started = evidenceStarted.get(opportunity.evidenceHash);
  if (started !== undefined) actionableLatencies.push(performance.now() - started);
});

const worker = await startOpportunityWorker(bus, registry, {
  now: () => T, debounceMs: 25, requestedNotionalUsd: "1000", minimumNotionalUsd: "100",
  holdingHorizonMs: 2_000, feesBpsByVenue: { venue_a: "3", venue_b: "3" },
  slippageBpsByVenue: { venue_a: "2", venue_b: "2" }, financingBps: "0",
  gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0",
});

for (const [venue, id] of [["venue_a", "ins_a"], ["venue_b", "ins_b"]] as const) {
  await bus.publish("venue.health.v1", venue, { venue, connectionState: "connected", lastEventAgeMs: 5,
    clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} } as never);
  await bus.publish("funding.observation.v1", id, {
    eventId: `evt_benchmark_funding_${venue}`, schemaVersion: 1, venue, instrumentId: id,
    transport: "websocket", sourceTimestamp: T - 10, receivedTimestamp: T - 5,
    freshnessBudgetMs: 2_000, qualityFlags: [], rawPayloadRefOrHash: `fixture:funding:${venue}`,
    eligibility: "live", payload: { kind: "funding", rateType: "predicted", rate: "0.0001",
      positiveRatePayer: "long", intervalMs: 28_800_000, nextSettlementMs: T + 1_000 },
  } as never);
}

for (let index = 0; index < COUNT; index++) {
  const venue = index % 2 ? "venue_a" : "venue_b";
  const id = index % 2 ? "ins_a" : "ins_b";
  const eventId = `evt_benchmark_${index}`;
  observationStarted.set(eventId, performance.now());
  await bus.publish("book.state.v1", id, {
    eventId, schemaVersion: 1, venue, instrumentId: id,
    transport: "websocket", sourceTimestamp: T - 10, receivedTimestamp: T - 5,
    freshnessBudgetMs: 20_000, qualityFlags: [], rawPayloadRefOrHash: `fixture:${index}`,
    eligibility: "live", payload: { kind: "order_book",
      bids: [{ price: index % 2 ? "125" : "99", quantity: "20" }],
      asks: [{ price: index % 2 ? "126" : "100", quantity: "20" }], capacityUsd: "2000" },
  } as never);
  if ((index + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
}

// Let the final naturally scheduled debounce window and publication chain drain.
await new Promise(resolve => setTimeout(resolve, 100));
await worker.stop();
actionableLatencies.sort((x, y) => x - y);
const p95 = actionableLatencies[Math.ceil(actionableLatencies.length * 0.95) - 1];
const report = {
  fixtureObservations: COUNT,
  publishedOpportunities,
  actionableOpportunities,
  actionableLatencySamples: actionableLatencies.length,
  actionableObservationToPublicationP95Ms: p95 === undefined ? null : Number(p95.toFixed(3)),
  targetMs: 500,
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
  scheduler: "natural fixed-window debounce; no worker.flush calls",
  fixture: "synthetic benchmark only; two reviewed perpetual instruments with eligible health, books, and funding; live mapping seed remains empty",
};
console.log(JSON.stringify(report));
if (p95 === undefined || actionableOpportunities === 0 || p95 >= 500) process.exitCode = 1;
