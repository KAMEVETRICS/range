import { createServer } from "node:http";
import { RedpandaEventBus, type EventBus } from "@range/event-bus";
import { createOtlpHttpTraceSink, createTelemetry, instrumentEventBus } from "@range/observability";
import { ConnectorRuntime } from "./runtime.js";
import type { ConnectorAdapter } from "./types.js";

export async function runConnectorService(adapter: ConnectorAdapter, env: NodeJS.ProcessEnv = process.env,
  options: { beforeStart?: (bus: EventBus) => Promise<void> } = {}) {
  const brokers = (env.REDPANDA_BROKERS ?? "redpanda:9092").split(",").map(value => value.trim()).filter(Boolean);
  if (!brokers.length) throw new Error("REDPANDA_BROKERS is required");
  const secrets = [env.EXTENDED_API_KEY].filter((value): value is string => Boolean(value));
  const telemetry = createTelemetry({ service: `connector-${adapter.venue}`, secrets,
    traceSink: env.OTEL_EXPORTER_OTLP_ENDPOINT ? createOtlpHttpTraceSink(env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined });
  const transport = new RedpandaEventBus({ clientId: `range-${adapter.venue}`, brokers });
  const eventBus = instrumentEventBus(transport, telemetry);
  const runtime = new ConnectorRuntime({ adapter, eventBus, maxClockSkewMs: Number(env.RANGE_MAX_CLOCK_SKEW_MS ?? 5_000) });
  const controller = new AbortController();
  const port = Number(env.HEALTH_PORT ?? 8081);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid HEALTH_PORT");
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      const health = runtime.health();
      const ok = health.connectionState === "connected" && health.sequenceIntegrity !== "gap";
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ service: adapter.venue, status: ok ? "healthy" : "degraded", health }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      response.end(telemetry.metrics.prometheus()); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  await options.beforeStart?.(eventBus);
  const running = runtime.start(controller.signal).catch(error => {
    telemetry.logger.error("connector runtime stopped", { error });
    controller.abort();
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    controller.abort(); await running;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await transport.close();
  })();
  const signal = () => { void close(); };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  return { runtime, telemetry, close };
}
