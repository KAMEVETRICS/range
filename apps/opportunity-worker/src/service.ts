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
import { fundingKeptInHistory, historyRecord, keptInHistory, writeOnceCited } from "./history-record.js";
import { MarketBoard, newestPerInstrument } from "./market-board.js";
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
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) as unknown as RedisCommands & { connect(): Promise<void>; disconnect(): void; ping(): Promise<string> };
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

  // History writers take batches: one transaction and one ordinal block per batch, not per event.
  const persist = <T extends Topic>(topic: T, keyOf: (event: TopicPayload[T]) => string) => (events: TopicPayload[T][]) =>
    writeOnceCited(() => history.appendMany(events.map(event => historyRecord(topic, keyOf(event), event, { archiveId, calculationVersion }))));
  stops.push(await bus.subscribeBatch("instrument.registry.v1", "history-instruments", persist("instrument.registry.v1", () => "registry")));
  const persistBooks = persist("book.state.v1", event => event.instrumentId);
  stops.push(await bus.subscribeBatch("book.state.v1", "history-books", events => persistBooks(events.filter(keptInHistory))));
  const persistFunding = persist("funding.observation.v1", event => event.instrumentId);
  stops.push(await bus.subscribeBatch("funding.observation.v1", "history-funding", events => persistFunding(events.filter(fundingKeptInHistory))));
  stops.push(await bus.subscribeBatch("venue.health.v1", "history-health", persist("venue.health.v1", event => event.venue)));
  stops.push(await bus.subscribeBatch("evidence.bundle.v1", "history-evidence", persist("evidence.bundle.v1", event => event.evidenceHash)));
  stops.push(await bus.subscribeBatch("opportunity.v1", "history-opportunities", persist("opportunity.v1", event => event.opportunityId)));
  stops.push(await bus.subscribeBatch("intent.lifecycle.v1", "history-intents", persist("intent.lifecycle.v1", event => event.idempotencyKey)));

  // Book and funding history older than RANGE_HISTORY_RETENTION_HOURS is deleted every five minutes; 0 keeps it all.
  // Results and their evidence older than RANGE_RESULT_RETENTION_HOURS go first in the same pass, so what their
  // evidence cited is uncited by the time books and funding are trimmed; 0, the default, keeps every result as an audit
  // trail. Each pass is bounded, so a backlog drains over several passes rather than in one long run.
  const retentionHours = Number(process.env.RANGE_HISTORY_RETENTION_HOURS ?? 24);
  if (!Number.isFinite(retentionHours) || retentionHours < 0) throw new Error("RANGE_HISTORY_RETENTION_HOURS must be zero or more");
  const resultRetentionHours = Number(process.env.RANGE_RESULT_RETENTION_HOURS ?? 0);
  if (!Number.isFinite(resultRetentionHours) || resultRetentionHours < 0) throw new Error("RANGE_RESULT_RETENTION_HOURS must be zero or more");
  const stopPruning = new AbortController();
  let pruning: Promise<void> | undefined;
  const cutoff = (hours: number) => Math.floor(Date.now() - hours * 3_600_000);
  // Evidence goes out before its result, and the result is dropped when a newer book arrives first, leaving evidence
  // nothing cites: about 400,000 bundles in 48 hours. Its result could still be recorded while the broker keeps
  // results (6 hours), but never after, so with result retention on, uncited evidence goes after 6 hours. Most evidence
  // that young is still cited, and scanning all of it each pass held up the book trim for hours, so each pass looks
  // only at what crossed the 6-hour line since the last one, and at most an hour back after a restart. Uncited
  // evidence older than that goes at the results' cutoff instead.
  const UNCITED_EVIDENCE_HOURS = 6;
  let evidenceScannedToMs = 0;
  const prune = () => pruning ??= (async () => {
    const options = { maxBatches: 100, signal: stopPruning.signal };
    let results = 0;
    if (resultRetentionHours > 0) {
      const resultsBeforeMs = cutoff(resultRetentionHours);
      const evidenceBeforeMs = Math.max(resultsBeforeMs, cutoff(UNCITED_EVIDENCE_HOURS));
      results = await history.pruneResults(resultsBeforeMs,
        { ...options, evidenceBeforeMs, evidenceAfterMs: Math.max(evidenceScannedToMs, evidenceBeforeMs - 3_600_000) });
      evidenceScannedToMs = evidenceBeforeMs;
    }
    const deleted = retentionHours > 0 ? await history.pruneObservations(cutoff(retentionHours), options) : 0;
    if (deleted || results) telemetry.logger.info("history pruned", { deleted, results, retentionHours, resultRetentionHours });
  })()
    .catch(error => telemetry.logger.error("history pruning failed", { error }))
    .finally(() => { pruning = undefined; });
  const pruneTimer = retentionHours > 0 || resultRetentionHours > 0 ? setInterval(prune, 300_000) : undefined;

  // Canonicalization is intentionally structural only: connector adapters have
  // already validated venue payloads into the shared observation schema. Routing is batched, one broker request per
  // topic per batch: one awaited request per event capped it below the observation rate (about 200 a second), and
  // every book and funding reader fell minutes behind. 200 events stay well under the broker's 1 MiB request limit.
  stops.push(await bus.subscribeBatch("market.observation.v1", "canonical-state-router", async events => {
    const books = events.flatMap(event => event.payload.kind === "order_book"
      ? [{ key: event.instrumentId, event: event as TopicPayload["book.state.v1"] }] : []);
    const funding = events.flatMap(event => event.payload.kind === "funding"
      ? [{ key: event.instrumentId, event: event as TopicPayload["funding.observation.v1"] }] : []);
    if (books.length) await bus.publishMany("book.state.v1", books);
    if (funding.length) await bus.publishMany("funding.observation.v1", funding);
  }, 200));

  const seed = SeedConfigSchema.parse(JSON.parse(await readFile(process.env.RANGE_MAPPING_CONFIG ?? "config/instrument-mappings.json", "utf8")));
  // In-memory registry views replay the whole registry topic on every start (fresh groups, deleted on stop), like the
  // worker's registry.
  const run = randomUUID();
  stops.push(await bus.subscribe("instrument.registry.v1", `reviewed-mapping-seeder-${run}`, createReviewedMappingSeeder(seed,
    (underlyingId, event) => bus.publish("instrument.registry.v1", underlyingId, event)), { deleteGroupOnStop: true }));

  // Without an offline queue, a command sent while the connection is still opening fails, so connect before the
  // current-state consumers start writing rather than on their first write.
  await redis.connect();
  const instrumentUnderlyings = new Map<string, string>();
  const pending = new Map<string, Array<TopicPayload["book.state.v1"] | TopicPayload["funding.observation.v1"]>>();
  const storeObservation = async (topic: "book.state.v1" | "funding.observation.v1", event: TopicPayload[typeof topic]) => {
    const id = instrumentUnderlyings.get(event.instrumentId);
    if (!id) { pending.set(event.instrumentId, [...(pending.get(event.instrumentId) ?? []), event]); return; }
    await current.put(`${topic === "book.state.v1" ? "book" : "funding"}:${event.instrumentId}`, {
      version: event.receivedTimestamp, expiresAt: event.sourceTimestamp + event.freshnessBudgetMs, underlyingId: id, value: event,
    });
  };
  // The market board keeps each instrument's latest top of book and funding for display (the markets overview); the
  // current-state entries above expire with their freshness budgets, which suits trading reads but not a table.
  const board = new MarketBoard();
  let boardVersion = 0;
  const boardTimer = setInterval(() => {
    const at = Date.now();
    boardVersion = Math.max(at, boardVersion + 1);
    current.put("market-board", { version: boardVersion, expiresAt: at + 30_000, value: board.snapshot(at) })
      .catch(error => telemetry.logger.error("market board publish failed", { error }));
  }, 2_000);
  stops.push(await bus.subscribe("instrument.registry.v1", `current-instrument-index-${run}`, async event => {
    if (event.kind !== "upsert") return;
    board.upsertInstrument(event.instrument);
    instrumentUnderlyings.set(event.instrument.instrumentId, event.instrument.underlyingId);
    for (const item of pending.get(event.instrument.instrumentId) ?? []) {
      await storeObservation(item.payload.kind === "order_book" ? "book.state.v1" : "funding.observation.v1", item as never);
    }
    pending.delete(event.instrument.instrumentId);
  }, { deleteGroupOnStop: true }));
  // Batched: only each instrument's newest event is applied and stored, in parallel. One awaited Redis write per event
  // fell minutes behind whenever a burst arrived (after a worker restart, about 40,000 books).
  // Evidence cites live books and funding by event; their times are kept here for as long as a result stays inspectable,
  // so reading a result does not wait for history to record its sources.
  const observationTimes = (events: ReadonlyArray<{ eventId: string; eligibility: string; sourceTimestamp: number; receivedTimestamp: number }>) =>
    current.putObservationTimes(events.filter(event => event.eligibility === "live").map(event =>
      ({ eventId: event.eventId, sourceTimestampMs: event.sourceTimestamp, receivedTimestampMs: event.receivedTimestamp })));
  stops.push(await bus.subscribeBatch("book.state.v1", "current-books", async events => {
    const newest = newestPerInstrument(events);
    for (const event of newest) board.applyBook(event);
    await Promise.all([...newest.map(event => storeObservation("book.state.v1", event)), observationTimes(events)]);
  }));
  stops.push(await bus.subscribeBatch("funding.observation.v1", "current-funding", async events => {
    const newest = newestPerInstrument(events);
    for (const event of newest) board.applyFunding(event);
    await Promise.all([...newest.map(event => storeObservation("funding.observation.v1", event)), observationTimes(events)]);
  }));
  // Connectors republish unchanged health at least every 30 s while their venue sends events, so a record lives for
  // three of those intervals: a venue reads as missing only once its feed or connector has stopped. Readers judge
  // freshness from asOfMs; a venue's freshness budget (2-5 s) is far shorter than the heartbeat.
  const healthTtlMs = 90_000;
  const healthVersions = new Map<string, number>();
  stops.push(await bus.subscribe("venue.health.v1", "current-health", async event => {
    const at = Date.now(); const version = Math.max(at, (healthVersions.get(event.venue) ?? 0) + 1); healthVersions.set(event.venue, version);
    await current.put(`health:${event.venue}`, { version, expiresAt: at + healthTtlMs, value: { health: event, asOfMs: at } });
  }));

  const registry = new InstrumentRegistry();
  const feesBpsByVenue = JSON.parse(process.env.RANGE_FEES_BPS_JSON ?? "{}") as Record<string, string>;
  const slippageBpsByVenue = JSON.parse(process.env.RANGE_SLIPPAGE_BPS_JSON ?? "{}") as Record<string, string>;
  // A worker whose revision authority failed refuses all input until restarted, while its health check still passes:
  // on 2026-10-01 one sat failed for five and a half hours. Exiting lets Docker restart it, rebuilt from the logs; if
  // Postgres is still down, that start fails and Docker retries. Until shutdown is wired up below, it exits at once.
  let exitForRestart: () => void = () => process.exit(1);
  const service = await startPersistentOpportunityWorker(bus, registry, {
    requestedNotionalUsd: process.env.RANGE_REQUESTED_NOTIONAL_USD ?? "10000",
    minimumNotionalUsd: process.env.RANGE_MINIMUM_NOTIONAL_USD ?? "100",
    holdingHorizonMs: Number(process.env.RANGE_HOLDING_HORIZON_MS ?? 28_800_000),
    feesBpsByVenue, slippageBpsByVenue, financingBps: "0", gasAndTransferBps: "0",
    fxConversionBps: "0", uncertaintyBufferBps: "0", calculationVersion,
    onAuthorityLost: () => {
      telemetry.logger.error("revision authority lost; exiting so the container restarts", {});
      exitForRestart();
    },
  }, sql, redis);
  // The pair view, like the market board: the latest evaluation of every reviewed pair, republished every 2 s.
  let pairsVersion = 0;
  const pairsTimer = setInterval(() => {
    const at = Date.now();
    pairsVersion = Math.max(at, pairsVersion + 1);
    current.put("pair-evaluations", { version: pairsVersion, expiresAt: at + 30_000, value: service.worker.pairEvaluations(at) })
      .catch(error => telemetry.logger.error("pair evaluations publish failed", { error }));
  }, 2_000);
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
    clearInterval(pruneTimer); clearInterval(boardTimer); clearInterval(pairsTimer); stopPruning.abort();
    await service.stop(); for (const stop of stops.reverse()) await stop(); await transport.close(); await pruning;
    await new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()));
    redis.disconnect(); await sql.end();
  })();
  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
  // Leaving the consumer groups cleanly lets the restarted worker rejoin without waiting out their session timeout;
  // shutdown can hang on a database that is down, so it gets ten seconds.
  exitForRestart = () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    void close().catch(() => undefined).finally(() => process.exit(1));
  };
}

main().catch(error => {
  // Exit rather than set exitCode: open Redis, Postgres and broker connections would keep a failed process alive,
  // and Docker restarts only a process that exits.
  console.error(`Range worker startup failed: ${error instanceof Error ? error.name : "unknown error"}`); process.exit(1);
});
