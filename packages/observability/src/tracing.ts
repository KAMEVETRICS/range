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

function otlpSpan(span: ExportedSpan) {
  const attributes = Object.entries({ ...span.attributes, event_id: span.event_id, opportunity_id: span.opportunity_id,
    evidence_hash: span.evidence_hash }).filter(([, value]) => value !== undefined).map(([key, value]) => ({
    key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
  }));
  const traceId = span.trace_id?.replace(/^rng_trace_/, "").replace(/-/g, "").padEnd(32, "0").slice(0, 32);
  return { traceId, spanId: span.span_id, name: span.name,
    startTimeUnixNano: `${BigInt(Date.parse(span.started_at)) * 1_000_000n}`,
    endTimeUnixNano: `${BigInt(Date.parse(span.started_at) + span.duration_ms) * 1_000_000n}`,
    attributes, status: { code: span.status === "ok" ? 1 : 2 } };
}

function otlpBody(spans: readonly ExportedSpan[]) {
  const byService = new Map<string, ExportedSpan[]>();
  for (const span of spans) {
    const group = byService.get(span.service) ?? [];
    group.push(span);
    byService.set(span.service, group);
  }
  return { resourceSpans: [...byService].map(([service, group]) => ({
    resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
    scopeSpans: [{ scope: { name: "@range/observability" }, spans: group.map(otlpSpan) }],
  })) };
}

export interface OtlpTraceSinkOptions {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMs?: number;
}

/** OTLP/HTTP JSON exporter with an OpenTelemetry-style batch processor. Spans queue in memory and export in the
 * background, one request at a time; a full queue drops new spans. Telemetry never delays or fails the data path. */
export function createOtlpHttpTraceSink(baseUrl: string, request: typeof fetch = fetch, options: OtlpTraceSinkOptions = {}) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;
  const maxQueueSize = options.maxQueueSize ?? 2_048;
  const maxExportBatchSize = options.maxExportBatchSize ?? 512;
  const scheduledDelayMs = options.scheduledDelayMs ?? 1_000;
  const queue: ExportedSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exporting = false;
  const schedule = () => {
    if (timer || exporting || !queue.length) return;
    timer = setTimeout(() => { timer = undefined; void exportBatch(); }, scheduledDelayMs);
    timer.unref?.();
  };
  const exportBatch = async () => {
    if (exporting || !queue.length) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    exporting = true;
    const batch = queue.splice(0, maxExportBatchSize);
    try {
      await request(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpBody(batch)), signal: AbortSignal.timeout(2_000) });
    } catch { /* exporter availability never controls market-data correctness */ }
    finally {
      exporting = false;
      if (queue.length >= maxExportBatchSize) void exportBatch();
      else schedule();
    }
  };
  return (span: ExportedSpan): void => {
    if (queue.length >= maxQueueSize) return;
    queue.push(span);
    if (queue.length >= maxExportBatchSize) void exportBatch();
    else schedule();
  };
}
