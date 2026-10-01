import { afterEach, expect, it, vi } from "vitest";
import { createOtlpHttpTraceSink, createTracer, type ExportedSpan } from "./tracing.js";

afterEach(() => vi.useRealTimers());

const span = (index: number): ExportedSpan => ({
  service: "connector-bitget", name: `publish ${index}`, span_id: index.toString(16).padStart(16, "0"),
  trace_id: `rng_trace_${"a".repeat(32)}`, event_id: `evt_${index}`, started_at: "2026-09-28T00:00:00.000Z",
  duration_ms: 3, status: "ok", attributes: { topic: "market.observation.v1" },
});
type Body = { resourceSpans: Array<{ resource: { attributes: unknown[] }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Body;
const namesSent = (request: ReturnType<typeof vi.fn>) => request.mock.calls.flatMap(call =>
  bodyOf(call).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans.map(item => item.name))));

it("never makes a traced operation wait for the collector", async () => {
  vi.useFakeTimers();
  const request = vi.fn(() => new Promise<Response>(() => {}));
  const tracer = createTracer({ service: "opportunity-worker", sink: createOtlpHttpTraceSink("http://collector:4318", request as never) });

  await expect(tracer.span("consume", {}, async () => "handled")).resolves.toBe("handled");
  expect(request).not.toHaveBeenCalled();
});

it("exports queued spans together in one OTLP request per interval", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (_url: string, _init: RequestInit) => new Response());
  const sink = createOtlpHttpTraceSink("http://collector:4318/", request as never);
  for (const index of [1, 2, 3]) sink(span(index));
  expect(request).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1_000);

  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe("http://collector:4318/v1/traces");
  const [resource] = bodyOf(request.mock.calls[0]!).resourceSpans;
  expect(resource!.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "connector-bitget" } }]);
  expect(namesSent(request)).toEqual(["publish 1", "publish 2", "publish 3"]);
  expect(resource!.scopeSpans[0]!.spans[0]).toMatchObject({ traceId: "a".repeat(32), spanId: "0000000000000001",
    startTimeUnixNano: "1790553600000000000", endTimeUnixNano: "1790553600003000000", status: { code: 1 } });
  expect(resource!.scopeSpans[0]!.spans[0]!.attributes).toEqual(expect.arrayContaining([
    { key: "topic", value: { stringValue: "market.observation.v1" } }, { key: "event_id", value: { stringValue: "evt_1" } }]));
});

it("bounds memory while the collector stalls: one request in flight, overflow spans dropped", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const request = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { release = () => resolve(new Response()); }))
    .mockImplementation(async () => new Response());
  const sink = createOtlpHttpTraceSink("http://collector:4318", request as never, { maxQueueSize: 4, maxExportBatchSize: 2 });
  for (let index = 1; index <= 10; index++) sink(span(index));

  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(namesSent(request)).toEqual(["publish 1", "publish 2", "publish 3", "publish 4", "publish 5", "publish 6"]);
});

it("swallows export failures and keeps exporting later spans", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockRejectedValueOnce(new Error("collector down")).mockResolvedValue(new Response());
  const sink = createOtlpHttpTraceSink("http://collector:4318", request as never);
  sink(span(1));
  await vi.advanceTimersByTimeAsync(1_000);
  sink(span(2));
  await vi.advanceTimersByTimeAsync(1_000);

  expect(namesSent(request)).toEqual(["publish 1", "publish 2"]);
});
