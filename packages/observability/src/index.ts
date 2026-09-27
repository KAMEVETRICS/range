import type { EventBus, Topic, TopicPayload } from "@range/event-bus";
import { createLogger } from "./logger.js";
import { MetricRegistry } from "./metrics.js";
import { createTracer, currentCorrelation, traceIdForEvent, type Correlation } from "./tracing.js";

export * from "./logger.js";
export * from "./metrics.js";
export * from "./tracing.js";

export interface TelemetryOptions {
  service: string;
  secrets?: readonly string[];
  logSink?: (line: string) => void;
  traceSink?: (span: Parameters<NonNullable<Parameters<typeof createTracer>[0]["sink"]>>[0]) => void | Promise<void>;
  now?: () => number;
}

export function createTelemetry(options: TelemetryOptions) {
  const metrics = new MetricRegistry();
  return {
    service: options.service,
    metrics,
    logger: createLogger({ service: options.service, secrets: options.secrets, sink: options.logSink, now: options.now }),
    tracer: createTracer({ service: options.service, secrets: options.secrets, sink: options.traceSink, now: options.now }),
    now: options.now ?? Date.now,
  };
}

export type RangeTelemetry = ReturnType<typeof createTelemetry>;

function correlation(event: unknown): Correlation {
  if (!event || typeof event !== "object") return {};
  const value = event as Record<string, unknown>;
  const eventId = typeof value.eventId === "string" ? value.eventId : undefined;
  const opportunityId = typeof value.opportunityId === "string" ? value.opportunityId : undefined;
  const evidenceHash = typeof value.evidenceHash === "string" ? value.evidenceHash : undefined;
  const seed = eventId ?? opportunityId ?? evidenceHash;
  return {
    ...(seed ? { trace_id: traceIdForEvent(seed) } : currentCorrelation()),
    ...(eventId ? { event_id: eventId } : {}),
    ...(opportunityId ? { opportunity_id: opportunityId } : {}),
    ...(evidenceHash ? { evidence_hash: evidenceHash } : {}),
  };
}

function recordEvent<T extends Topic>(topic: T, event: TopicPayload[T], telemetry: RangeTelemetry): void {
  const value = event as unknown as Record<string, unknown>;
  if (topic === "market.observation.v1" || topic === "book.state.v1" || topic === "funding.observation.v1") {
    const source = Number(value.sourceTimestamp);
    const received = Number(value.receivedTimestamp);
    const venue = String(value.venue ?? "unknown");
    if (Number.isFinite(source) && Number.isFinite(received)) {
      telemetry.metrics.observe("range_connector_lag_ms", Math.max(0, received - source), { venue });
      telemetry.metrics.observe("range_event_lag_ms", Math.max(0, telemetry.now() - received), { topic });
    }
  }
  if (topic === "venue.health.v1") {
    const venue = String(value.venue ?? "unknown");
    const skew = Number(value.clockSkewMs);
    if (Number.isFinite(skew)) telemetry.metrics.set("range_clock_skew_ms", Math.max(0, skew), { venue });
    if (value.sequenceIntegrity === "gap") telemetry.metrics.increment("range_book_sequence_gaps_total", { venue });
    if (value.connectionState === "reconnecting") telemetry.metrics.increment("range_connector_reconnects_total", { venue });
  }
  if (topic === "opportunity.v1") {
    const reasons = Array.isArray(value.rejectionReasons) ? value.rejectionReasons : [];
    if (reasons.includes("STALE_INPUT")) telemetry.metrics.increment("range_stale_rejections_total");
    const freshness = value.freshness as Record<string, unknown> | undefined;
    const age = Number(freshness?.oldestInputMs);
    if (Number.isFinite(age)) telemetry.metrics.observe("range_opportunity_age_ms", Math.max(0, age));
  }
}

/** Decorates the real bus; validation, retention, delivery and failure behavior
 * remain owned by the wrapped implementation. */
export function instrumentEventBus(bus: EventBus, telemetry: RangeTelemetry): EventBus {
  return {
    async publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]) {
      const fields = correlation(event);
      await telemetry.tracer.span(`event.publish ${topic}`, fields, async span => {
        span.setAttribute("topic", topic); span.setAttribute("key", key);
        recordEvent(topic, event, telemetry);
        await bus.publish(topic, key, event);
      });
    },
    async subscribe<T extends Topic>(topic: T, groupId: string, handler: (event: TopicPayload[T]) => Promise<void>) {
      return bus.subscribe(topic, groupId, async event => telemetry.tracer.span(`event.consume ${topic}`, correlation(event), async span => {
        span.setAttribute("topic", topic); span.setAttribute("group_id", groupId);
        await handler(event);
      }));
    },
  };
}
