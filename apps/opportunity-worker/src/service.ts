import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Redis } from "ioredis";
import pg from "pg";
import { RedpandaEventBus, type Topic, type TopicPayload } from "@range/event-bus";
import { InstrumentRegistry, SeedConfigSchema } from "@range/instruments";
import { createOtlpHttpTraceSink, createTelemetry, instrumentEventBus } from "@range/observability";
import { CurrentStateStore, HistoryStore, PostgresRevisionAuthority, startPersistentOpportunityWorker,
  type RedisCommands, type SqlPool } from "@range/storage";
import { checkWorkerHealth } from "./health.js";
import { historyRecord } from "./history-record.js";
import { createReviewedMappingSeeder } from "./mapping-seeder.js";

const calculationVersion = "range.calc.v1";
const archiveId = "archive_live_redpanda";
const archiveHash = `sha256:${createHash("sha256").update("redpanda://range/live").digest("hex")}`;


async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const brokers = (process.env.REDPANDA_BROKERS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!databaseUrl || !redisUrl || !brokers.length) throw new Error("DATABASE_URL, REDIS_URL, and REDPANDA_BROKERS are required");
  const sql = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5_000 }) as unknown as SqlPool & { end(): Promise<void> };
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) as unknown as RedisCommands & { disconnect(): void; ping(): Promise<string> };
  const telemetry = createTelemetry({ service: "opportunity-worker",
    traceSink: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? createOtlpHttpTraceSink(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined });
  const transport = new RedpandaEventBus({ clientId: "range-opportunity-worker", brokers });
  const bus = instrumentEventBus(transport, telemetry);
  const authority = new PostgresRevisionAuthority(sql);
  const current = new CurrentStateStore(redis, authority);
  const history = new HistoryStore(sql);
  await history.registerCalculation(calculationVersion);
  await history.registerArchive({ archiveId, uri: "redpanda://range/live", contentHash: archiveHash });
  const stops: Array<() => Promise<void>> = [];

  const persist = <T extends Topic>(topic: T, key: string, event: TopicPayload[T]) =>
    history.append(historyRecord(topic, key, event, { archiveId, calculationVersion }));
  stops.push(await bus.subscribe("instrument.registry.v1", "history-instruments", event => persist("instrument.registry.v1", "registry", event)));
  stops.push(await bus.subscribe("book.state.v1", "history-books", event => persist("book.state.v1", event.instrumentId, event)));
  stops.push(await bus.subscribe("funding.observation.v1", "history-funding", event => persist("funding.observation.v1", event.instrumentId, event)));
  stops.push(await bus.subscribe("venue.health.v1", "history-health", event => persist("venue.health.v1", event.venue, event)));
  stops.push(await bus.subscribe("evidence.bundle.v1", "history-evidence", event => persist("evidence.bundle.v1", event.evidenceHash, event)));
  stops.push(await bus.subscribe("opportunity.v1", "history-opportunities", event => persist("opportunity.v1", event.opportunityId, event)));
  stops.push(await bus.subscribe("intent.lifecycle.v1", "history-intents", event => persist("intent.lifecycle.v1", event.idempotencyKey, event)));

  // Canonicalization is intentionally structural only: connector adapters have
  // already validated venue payloads into the shared observation schema.
  stops.push(await bus.subscribe("market.observation.v1", "canonical-state-router", async event => {
    if (event.payload.kind === "order_book") await bus.publish("book.state.v1", event.instrumentId, event as TopicPayload["book.state.v1"]);
    if (event.payload.kind === "funding") await bus.publish("funding.observation.v1", event.instrumentId, event as TopicPayload["funding.observation.v1"]);
  }));

  const seed = SeedConfigSchema.parse(JSON.parse(await readFile(process.env.RANGE_MAPPING_CONFIG ?? "config/instrument-mappings.json", "utf8")));
  // In-memory registry views replay the whole registry topic on every start (fresh groups), like the worker's registry.
  const run = randomUUID();
  stops.push(await bus.subscribe("instrument.registry.v1", `reviewed-mapping-seeder-${run}`, createReviewedMappingSeeder(seed,
    (underlyingId, event) => bus.publish("instrument.registry.v1", underlyingId, event))));

  const instrumentUnderlyings = new Map<string, string>();
  const pending = new Map<string, Array<TopicPayload["book.state.v1"] | TopicPayload["funding.observation.v1"]>>();
  const storeObservation = async (topic: "book.state.v1" | "funding.observation.v1", event: TopicPayload[typeof topic]) => {
    const id = instrumentUnderlyings.get(event.instrumentId);
    if (!id) { pending.set(event.instrumentId, [...(pending.get(event.instrumentId) ?? []), event]); return; }
    await current.put(`${topic === "book.state.v1" ? "book" : "funding"}:${event.instrumentId}`, {
      version: event.receivedTimestamp, expiresAt: event.sourceTimestamp + event.freshnessBudgetMs, underlyingId: id, value: event,
    });
  };
  stops.push(await bus.subscribe("instrument.registry.v1", `current-instrument-index-${run}`, async event => {
    if (event.kind !== "upsert") return;
    instrumentUnderlyings.set(event.instrument.instrumentId, event.instrument.underlyingId);
    for (const item of pending.get(event.instrument.instrumentId) ?? []) {
      await storeObservation(item.payload.kind === "order_book" ? "book.state.v1" : "funding.observation.v1", item as never);
    }
    pending.delete(event.instrument.instrumentId);
  }));
  stops.push(await bus.subscribe("book.state.v1", "current-books", event => storeObservation("book.state.v1", event)));
  stops.push(await bus.subscribe("funding.observation.v1", "current-funding", event => storeObservation("funding.observation.v1", event)));
  const budgets = new Map<string, number>((JSON.parse(process.env.RANGE_VENUE_MANIFEST_JSON ?? "[]") as Array<{ venue: string; freshnessBudgetMs: number }>)
    .map(item => [item.venue, item.freshnessBudgetMs]));
  const healthVersions = new Map<string, number>();
  stops.push(await bus.subscribe("venue.health.v1", "current-health", async event => {
    const at = Date.now(); const version = Math.max(at, (healthVersions.get(event.venue) ?? 0) + 1); healthVersions.set(event.venue, version);
    await current.put(`health:${event.venue}`, { version,
      expiresAt: at + (budgets.get(event.venue) ?? 5_000), value: { health: event, asOfMs: at } });
  }));

  const registry = new InstrumentRegistry();
  const feesBpsByVenue = JSON.parse(process.env.RANGE_FEES_BPS_JSON ?? "{}") as Record<string, string>;
  const slippageBpsByVenue = JSON.parse(process.env.RANGE_SLIPPAGE_BPS_JSON ?? "{}") as Record<string, string>;
  const service = await startPersistentOpportunityWorker(bus, registry, {
    requestedNotionalUsd: process.env.RANGE_REQUESTED_NOTIONAL_USD ?? "10000",
    minimumNotionalUsd: process.env.RANGE_MINIMUM_NOTIONAL_USD ?? "100",
    holdingHorizonMs: Number(process.env.RANGE_HOLDING_HORIZON_MS ?? 28_800_000),
    feesBpsByVenue, slippageBpsByVenue, financingBps: "0", gasAndTransferBps: "0",
    fxConversionBps: "0", uncertaintyBufferBps: "0", calculationVersion,
  }, sql, redis);
  let subscriptionsReady = true;
  const healthServer = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      const health = await checkWorkerHealth({ subscriptionsReady, sql, redis });
      response.writeHead(health.statusCode, { "content-type": "application/json" }).end(JSON.stringify(health.body)); return;
    }
    if (request.url === "/metrics") { response.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(telemetry.metrics.prometheus()); return; }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { healthServer.once("error", reject); healthServer.listen(Number(process.env.HEALTH_PORT ?? 8081), "0.0.0.0", resolve); });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    subscriptionsReady = false;
    await service.stop(); for (const stop of stops.reverse()) await stop(); await transport.close();
    await new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()));
    redis.disconnect(); await sql.end();
  })();
  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
}

main().catch(error => {
  console.error(`Range worker startup failed: ${error instanceof Error ? error.name : "unknown error"}`); process.exitCode = 1;
});
