import { expect, it } from "vitest";
import { InMemoryEventBus, type EventBus, type Topic, type TopicPayload } from "@range/event-bus";
import { InstrumentSchema, type Instrument } from "@range/domain";
import {
  ConnectorRuntime,
  RetryAfterError,
  assertAdapterFixture,
  retryWithBackoff,
  type ConnectorAdapter,
  type RawSnapshot,
} from "./index.js";

const instrument: Instrument = InstrumentSchema.parse({
  instrumentId: "ins_bitget_RAAPLUSDT", underlyingId: "RAAPL", venue: "bitget", venueSymbol: "RAAPLUSDT",
  quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT", productType: "perpetual",
  contractMultiplier: "1", tickSize: "0.01", lotSize: "1", minimumNotional: "0", fundingInterval: 28_800_000,
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["snapshot"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
});

function snapshot(sourceTimestampMs = 10_000): RawSnapshot {
  return {
    eventId: "evt_source", instrumentId: instrument.instrumentId, sourceTimestampMs, transport: "rest",
    freshnessBudgetMs: 1_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:source", eligibility: "live",
    payload: { kind: "index_price", price: "200" },
  };
}

function fakeAdapter(options: { sourceTimestampMs?: number; disconnectAfter?: number } = {}): ConnectorAdapter {
  return {
    venue: "bitget",
    async probe() { return { available: true }; },
    async discover() { return [instrument]; },
    async snapshot() { return snapshot(options.sourceTimestampMs); },
    stream: options.disconnectAfter === undefined ? undefined : async function* () {
      yield snapshot();
      throw new Error("connection closed");
    },
  };
}

async function published<T extends Topic>(bus: EventBus, topic: T): Promise<TopicPayload[T][]> {
  const seen: TopicPayload[T][] = [];
  await bus.subscribe(topic, `test-${topic}`, async event => { seen.push(event); });
  return seen;
}

it("quarantines observations with excessive clock skew before publication", async () => {
  const bus = new InMemoryEventBus();
  const marketEvents = await published(bus, "market.observation.v1");
  const healthEvents = await published(bus, "venue.health.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ sourceTimestampMs: 1_000 }), eventBus: bus, nowMs: () => 20_000, maxClockSkewMs: 5_000 });

  await runtime.pollOnce();

  expect(runtime.health().connectionState).toBe("quarantined");
  expect(runtime.health().quarantineReason).toBe("CLOCK_SKEW_EXCEEDED");
  expect(marketEvents).toHaveLength(0);
  expect(healthEvents.at(-1)?.connectionState).toBe("quarantined");
});

it("emits degraded venue health when a stream disconnects", async () => {
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ disconnectAfter: 1 }), eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();

  expect(runtime.health().connectionState).toBe("degraded");
  expect(healthEvents.at(-1)?.connectionState).toBe("degraded");
});

it("honors Retry-After before retrying a transient adapter failure", async () => {
  const delays: number[] = [];
  let attempts = 0;

  const result = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts === 1) throw new RetryAfterError("rate limited", 1_234);
    return "recovered";
  }, { sleep: async delayMs => { delays.push(delayMs); } });

  expect(result).toBe("recovered");
  expect(attempts).toBe(2);
  expect(delays).toEqual([1_234]);
});

it("never allows exponential retry backoff above thirty seconds", async () => {
  const delays: number[] = [];
  let attempts = 0;

  await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
  }, {
    baseDelayMs: 100_000,
    maxBackoffMs: 100_000,
    random: () => 1,
    sleep: async delayMs => { delays.push(delayMs); },
  });

  expect(delays).toEqual([30_000]);
});

it("enforces the shared adapter fixture contract without exposing credentials", async () => {
  const credential = "super-secret-token";
  let rateLimitAttempts = 0;

  await expect(assertAdapterFixture({
    adapter: fakeAdapter(),
    malformedMessage: async () => { throw new Error("invalid wire message"); },
    credentialValues: [credential],
    credentialError: async () => { throw new Error(`authorization: Bearer ${credential}`); },
    rateLimitAttempt: async () => {
      rateLimitAttempts += 1;
      if (rateLimitAttempts === 1) throw new RetryAfterError("429", 77);
    },
    sleep: async () => {},
  })).resolves.toBeUndefined();
});

it("rejects an adapter fixture that does not simulate a Retry-After response", async () => {
  await expect(assertAdapterFixture({
    adapter: fakeAdapter(),
    malformedMessage: async () => { throw new Error("invalid wire message"); },
    credentialValues: [],
    credentialError: async () => { throw new Error("safe failure"); },
    rateLimitAttempt: async () => {},
    sleep: async () => {},
  })).rejects.toThrow("Retry-After");
});
