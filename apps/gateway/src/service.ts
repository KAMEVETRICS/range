import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "@range/config";
import { IntentService, RangeApplication, SqlIntentStore, StorageQueries, VenueViewSchema } from "@range/application";
import { CurrentStateStore, HistoryStore, PostgresRevisionAuthority, type RedisCommands, type SqlPool } from "@range/storage";
import { createTelemetry, createOtlpHttpTraceSink } from "@range/observability";
import { buildServer } from "./server.js";
import { createGatewayClients } from "./service-config.js";

async function main() {
  const config = loadConfig(process.env);
  const token = process.env.RANGE_DEMO_API_TOKEN;
  if (!token || token.length < 24) throw new Error("RANGE_DEMO_API_TOKEN must be at least 24 characters");
  const dashboardToken = process.env.RANGE_DASHBOARD_READ_TOKEN;
  if (!dashboardToken || dashboardToken.length < 24) throw new Error("RANGE_DASHBOARD_READ_TOKEN must be at least 24 characters");
  const manifestInput = JSON.parse(process.env.RANGE_VENUE_MANIFEST_JSON ?? "[]");
  const manifest = VenueViewSchema.pick({ venue: true, capabilities: true, freshnessBudgetMs: true }).array().min(1).parse(manifestInput);
  const sql = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000 }) as unknown as SqlPool & { end(): Promise<void> };
  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) as unknown as RedisCommands & { disconnect(): void };
  const current = new CurrentStateStore(redis, new PostgresRevisionAuthority(sql));
  const history = new HistoryStore(sql);
  const telemetry = createTelemetry({ service: "gateway", secrets: [token, dashboardToken, config.apiTokenPepper],
    traceSink: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? createOtlpHttpTraceSink(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined });
  const application = new RangeApplication(new StorageQueries(current, history, sql, manifest,
    entry => telemetry.logger.info("storage query", entry)));
  const intents = new IntentService(application, new SqlIntentStore(sql));
  const app = buildServer({ application, intents, pepper: config.apiTokenPepper,
    clients: createGatewayClients({ demoToken: token, dashboardToken, pepper: config.apiTokenPepper }),
    mcpAllowedHosts: (process.env.RANGE_ALLOWED_HOSTS ?? "localhost,127.0.0.1,gateway").split(",").map(value => value.trim()),
    log: entry => telemetry.logger.info("gateway request", entry),
    observeLatency: entry => telemetry.metrics.observe("range_gateway_latency_ms", entry.duration_ms, { operation: entry.operation }),
    onIntentExpiry: () => telemetry.metrics.increment("range_intent_expiry_total"),
  });
  app.get("/healthz", async (_request, reply) => {
    try { await sql.query("SELECT 1"); return reply.send({ status: "healthy" }); }
    catch { return reply.code(503).send({ status: "unhealthy" }); }
  });
  app.get("/metrics", async (_request, reply) => reply.type("text/plain; version=0.0.4").send(telemetry.metrics.prometheus()));
  const close = async () => { await app.close(); redis.disconnect(); await sql.end(); };
  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
}

main().catch(error => {
  // Startup errors are deliberately summarized; configuration values and database URLs are never serialized.
  console.error(`Range gateway startup failed: ${error instanceof Error ? error.name : "unknown error"}`); process.exitCode = 1;
});
