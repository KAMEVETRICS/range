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
let published = 0;
await bus.subscribe("opportunity.v1", "benchmark-count", async () => { published += 1; });
const worker = await startOpportunityWorker(bus, registry, {
  now: () => T, debounceMs: 25, requestedNotionalUsd: "1000", minimumNotionalUsd: "100",
  holdingHorizonMs: 2_000, feesBpsByVenue: { venue_a: "3", venue_b: "3" },
  slippageBpsByVenue: { venue_a: "2", venue_b: "2" }, financingBps: "0",
  gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0",
});
const latencies: number[] = [];
for (let batch = 0; batch < COUNT / 100; batch++) {
  const started: number[] = [];
  for (let offset = 0; offset < 100; offset++) {
    const index = batch * 100 + offset;
    const venue = index % 2 ? "venue_a" : "venue_b";
    const id = index % 2 ? "ins_a" : "ins_b";
    started.push(performance.now());
    await bus.publish("book.state.v1", id, {
      eventId: `evt_benchmark_${index}`, schemaVersion: 1, venue, instrumentId: id,
      transport: "websocket", sourceTimestamp: T - 10, receivedTimestamp: T - 5,
      freshnessBudgetMs: 2_000, qualityFlags: [], rawPayloadRefOrHash: `fixture:${index}`,
      eligibility: "live", payload: { kind: "order_book",
        bids: [{ price: index % 2 ? "100" : "100.3", quantity: "20" }],
        asks: [{ price: index % 2 ? "100.1" : "100.4", quantity: "20" }], capacityUsd: "2000" },
    } as never);
  }
  await worker.flush();
  const finished = performance.now();
  for (const start of started) latencies.push(finished - start);
}
await worker.stop();
latencies.sort((x,y) => x-y);
const p95 = latencies[Math.ceil(COUNT * 0.95) - 1]!;
const report = {
  fixtureObservations: COUNT, publishedOpportunities: published,
  p95ObservationToPublicationMs: Number(p95.toFixed(3)), targetMs: 500,
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
  fixture: "synthetic; two reviewed perpetual instruments; no funding inputs, so all candidates rejected",
};
console.log(JSON.stringify(report));
if (published === 0 || p95 >= 500) process.exitCode = 1;
