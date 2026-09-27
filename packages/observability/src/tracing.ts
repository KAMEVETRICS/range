import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { redactTelemetry } from "./logger.js";

export interface Correlation {
  trace_id?: string;
  event_id?: string;
  opportunity_id?: string;
  evidence_hash?: string;
}

export interface ExportedSpan extends Correlation {
  service: string;
  name: string;
  span_id: string;
  started_at: string;
  duration_ms: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
}

export interface TracerOptions {
  service: string;
  secrets?: readonly string[];
  sink?: (span: ExportedSpan) => void | Promise<void>;
  now?: () => number;
}

const context = new AsyncLocalStorage<Required<Pick<Correlation, "trace_id">> & Correlation>();
const traceId = () => `rng_trace_${randomUUID()}`;

/** Stable trace reconstruction lets a consumer correlate an event even when a
 * broker implementation cannot expose transport headers to the EventBus port. */
export function traceIdForEvent(seed: string): string {
  return `rng_trace_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

export function currentCorrelation(): Correlation | undefined { return context.getStore(); }

export function createTracer(options: TracerOptions) {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? (() => {});
  return {
    async span<T>(name: string, correlation: Correlation, operation: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T> | T): Promise<T> {
      const parent = currentCorrelation();
      const merged = { ...parent, ...correlation, trace_id: correlation.trace_id ?? parent?.trace_id ?? traceId() };
      const start = now();
      const attributes: Record<string, unknown> = {};
      let status: ExportedSpan["status"] = "ok";
      try {
        return await context.run(merged, () => operation({ setAttribute(key, value) { attributes[key] = value; } }));
      } catch (error) {
        status = "error";
        attributes.error = error;
        throw error;
      } finally {
        const sanitized = redactTelemetry({ service: options.service, name, span_id: randomUUID().replaceAll("-", "").slice(0, 16),
          ...merged, started_at: new Date(start).toISOString(), duration_ms: Math.max(0, now() - start), status, attributes }, options.secrets) as ExportedSpan;
        await sink(sanitized);
      }
    },
  };
}

export type RangeTracer = ReturnType<typeof createTracer>;

/** Minimal OTLP/HTTP JSON exporter. Export failures are isolated from the
 * observed request so telemetry cannot take the data path down. */
export function createOtlpHttpTraceSink(baseUrl: string, request: typeof fetch = fetch) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;
  return async (span: ExportedSpan): Promise<void> => {
    const attributes = Object.entries({ ...span.attributes, event_id: span.event_id, opportunity_id: span.opportunity_id,
      evidence_hash: span.evidence_hash }).filter(([, value]) => value !== undefined).map(([key, value]) => ({
      key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
    }));
    const traceId = span.trace_id?.replace(/^rng_trace_/, "").replace(/-/g, "").padEnd(32, "0").slice(0, 32);
    try {
      await request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: span.service } }] },
          scopeSpans: [{ scope: { name: "@range/observability" }, spans: [{ traceId, spanId: span.span_id,
            name: span.name, startTimeUnixNano: `${BigInt(Date.parse(span.started_at)) * 1_000_000n}`,
            endTimeUnixNano: `${BigInt(Date.parse(span.started_at) + span.duration_ms) * 1_000_000n}`,
            attributes, status: { code: span.status === "ok" ? 1 : 2 } }] }] }],
      }), signal: AbortSignal.timeout(2_000) });
    } catch { /* exporter availability never controls market-data correctness */ }
  };
}
