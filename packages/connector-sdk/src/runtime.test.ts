import { expect, it } from "vitest";
import { InMemoryEventBus, type EventBus, type Topic, type TopicPayload } from "@range/event-bus";
import { InstrumentSchema, type Instrument } from "@range/domain";
import {
  ConnectorRuntime,
  ConnectorDiagnosticError,
  RetryAfterError,
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

it("quarantines future-dated observations with excessive clock skew before publication", async () => {
  const bus = new InMemoryEventBus();
  const marketEvents = await published(bus, "market.observation.v1");
  const healthEvents = await published(bus, "venue.health.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ sourceTimestampMs: 26_000 }), eventBus: bus, nowMs: () => 20_000, maxClockSkewMs: 5_000 });

  await runtime.pollOnce();

  expect(runtime.health().connectionState).toBe("quarantined");
  expect(runtime.health().quarantineReason).toBe("CLOCK_SKEW_EXCEEDED");
  expect(marketEvents).toHaveLength(0);
  expect(healthEvents.at(-1)?.connectionState).toBe("quarantined");
  expect(healthEvents.at(-1)?.clockSkewMs).toBe(6_000);
});

it("publishes old observations as data age rather than quarantining them as clock skew", async () => {
  const bus = new InMemoryEventBus();
  const marketEvents = await published(bus, "market.observation.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ sourceTimestampMs: 1_000 }), eventBus: bus, nowMs: () => 20_000, maxClockSkewMs: 5_000 });

  await runtime.pollOnce();

  expect(runtime.health()).toMatchObject({ connectionState: "connected", clockSkewMs: 0 });
  expect(marketEvents).toHaveLength(1);
});

it("emits degraded venue health when a stream disconnects", async () => {
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ disconnectAfter: 1 }), eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();

  expect(runtime.health().connectionState).toBe("degraded");
  expect(healthEvents.at(-1)?.connectionState).toBe("degraded");
});

it("publishes each discovered instrument before its first market observation", async () => {
  const bus = new InMemoryEventBus();
  const order: string[] = [];
  await bus.subscribe("instrument.registry.v1", "registry-order", async event => {
    order.push(`instrument:${event.kind === "upsert" ? event.instrument.instrumentId : "mapping"}`);
  });
  await bus.subscribe("market.observation.v1", "market-order", async event => { order.push(`market:${event.instrumentId}`); });
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter(), eventBus: bus, nowMs: () => 10_000 });

  await runtime.pollOnce();

  expect(order).toEqual([`instrument:${instrument.instrumentId}`, `market:${instrument.instrumentId}`]);
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

it("reconnects after a stream disconnect and snapshots before the replacement session", async () => {
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const controller = new AbortController();
  let streams = 0;
  let snapshots = 0;
  const adapter: ConnectorAdapter = {
    venue: "bitget",
    async probe() { return { available: true }; },
    async discover() { return [instrument]; },
    async snapshot() { snapshots += 1; return snapshot(); },
    async *stream() {
      streams += 1;
      if (streams === 1) throw new Error("temporary disconnect");
      yield snapshot();
      controller.abort();
    },
  };
  const runtime = new ConnectorRuntime({
    adapter,
    eventBus: bus,
    nowMs: () => 10_000,
    reconnect: { baseDelayMs: 0, sleep: async () => {} },
  });

  await runtime.start(controller.signal);

  expect(streams).toBe(2);
  expect(snapshots).toBe(2);
  const degraded = healthEvents.findIndex(event => event.connectionState === "degraded");
  expect(degraded).toBeGreaterThanOrEqual(0);
  expect(healthEvents.slice(degraded + 1).some(event => event.connectionState === "connected" && event.rateLimit.state === "healthy")).toBe(true);
});

it("marks the first validated numeric sequence in a recovered stream as an explicit reset snapshot", async () => {
  const bus = new InMemoryEventBus();
  const marketEvents = await published(bus, "market.observation.v1");
  const adapter = fakeAdapter();
  adapter.stream = async function* () {
    yield { ...snapshot(), transport: "websocket", sequence: 42,
      sequencePolicy: "contiguous", payload: { kind: "order_book", bids: [], asks: [], capacityUsd: "0" } };
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();

  const sequenced = marketEvents.find(event => event.sequence === 42)!;
  expect(sequenced).toMatchObject({ sequencePolicy: "contiguous", sequenceReset: true });
});

it("retains gap integrity through reconnect until a validated epoch snapshot arrives", async () => {
  const bus = new InMemoryEventBus();
  let session = 0;
  let restSnapshots = 0;
  let releaseValidated!: () => void;
  let releaseDisconnect!: () => void;
  const validatedGate = new Promise<void>(resolve => { releaseValidated = resolve; });
  const disconnectGate = new Promise<void>(resolve => { releaseDisconnect = resolve; });
  let secondSnapshot!: () => void;
  let validatedSnapshot!: () => void;
  const secondSnapshotPublished = new Promise<void>(resolve => { secondSnapshot = resolve; });
  const validatedSnapshotPublished = new Promise<void>(resolve => { validatedSnapshot = resolve; });
  await bus.subscribe("market.observation.v1", "gap-reset-observer", async event => {
    if (event.transport === "rest" && ++restSnapshots === 2) secondSnapshot();
    if (event.sequenceReset === true && event.sequence === 1) validatedSnapshot();
  });
  const adapter = fakeAdapter();
  adapter.stream = async function* () {
    session += 1;
    if (session === 1) {
      yield { ...snapshot(), transport: "websocket", sequence: 42, sequencePolicy: "contiguous" };
      throw new ConnectorDiagnosticError("SEQUENCE_GAP");
    }
    await validatedGate;
    yield { ...snapshot(), eventId: "evt_recovered", transport: "websocket", sequence: 1,
      sequencePolicy: "contiguous" };
    await disconnectGate;
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();
  expect(runtime.health().sequenceIntegrity).toBe("gap");

  const recovered = runtime.runUntilDisconnected();
  await secondSnapshotPublished;
  expect(runtime.health().sequenceIntegrity).toBe("gap");
  releaseValidated();
  await validatedSnapshotPublished;
  expect(runtime.health().sequenceIntegrity).toBe("consistent");
  releaseDisconnect();
  await recovered;
});

it("counts a feed without contiguous sequencing as consistent once it handles a full book snapshot", async () => {
  const book = { kind: "order_book" as const, bids: [{ price: "199", quantity: "1" }], asks: [{ price: "201", quantity: "1" }],
    capacityUsd: "0" };
  const integrityAfter = async (events: ReturnType<typeof snapshot>[], before?: "gap") => {
    const bus = new InMemoryEventBus();
    const adapter = fakeAdapter();
    adapter.stream = async function* () {
      if (before === "gap") throw new ConnectorDiagnosticError("SEQUENCE_GAP");
      yield* events;
    };
    const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000 });
    if (before === "gap") {
      await runtime.runUntilDisconnected();
      adapter.stream = async function* () { yield* events; };
    }
    await runtime.runUntilDisconnected();
    const health = await published(bus, "venue.health.v1");
    return [runtime.health().sequenceIntegrity, health.at(-1)?.sequenceIntegrity];
  };
  // Other events say nothing about a book; a full snapshot is complete by construction.
  expect(await integrityAfter([{ ...snapshot(), transport: "websocket" }])).toEqual(["unknown", "unknown"]);
  expect(await integrityAfter([{ ...snapshot(), transport: "websocket", payload: book }])).toEqual(["consistent", "consistent"]);
  // A gap still needs the contiguous feed's own validated snapshot.
  expect(await integrityAfter([{ ...snapshot(), transport: "websocket", payload: book }], "gap")).toEqual(["gap", "gap"]);
});

it("keeps an in-session gap when another instrument starts its validated sequence", async () => {
  const bus = new InMemoryEventBus();
  const adapter = fakeAdapter();
  const book = { kind: "order_book" as const, bids: [], asks: [], capacityUsd: "0" };
  adapter.stream = async function* () {
    yield { ...snapshot(), transport: "websocket", sequence: 1, sequencePolicy: "contiguous", payload: book };
    yield { ...snapshot(), eventId: "evt_gap", transport: "websocket", sequence: 3, sequencePolicy: "contiguous",
      payload: book };
    yield { ...snapshot(), eventId: "evt_other", instrumentId: "ins_bitget_RMSFTUSDT", transport: "websocket",
      sequence: 1, sequencePolicy: "contiguous", payload: book };
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();

  expect(runtime.health().sequenceIntegrity).toBe("gap");
});

it("publishes the raw-event copy only when enabled, since nothing reads it until the raw archive exists", async () => {
  for (const publishRawEvents of [false, true]) {
    const bus = new InMemoryEventBus();
    const raw = await published(bus, "market.raw.v1");
    const observations = await published(bus, "market.observation.v1");
    const runtime = new ConnectorRuntime({ adapter: fakeAdapter(), eventBus: bus, nowMs: () => 10_000,
      ...(publishRawEvents ? { publishRawEvents } : {}) });

    await runtime.pollOnce();

    expect(observations).toHaveLength(1);
    expect(raw).toHaveLength(publishRawEvents ? 1 : 0);
  }
});

it("republishes unchanged health as a heartbeat while events keep flowing", async () => {
  let now = 10_000;
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const adapter = fakeAdapter();
  adapter.stream = async function* () {
    yield { ...snapshot(now), eventId: "evt_first", transport: "websocket" };
    now = 25_000;
    yield { ...snapshot(now), eventId: "evt_quiet", transport: "websocket" };
    now = 45_000;
    yield { ...snapshot(now), eventId: "evt_heartbeat", transport: "websocket" };
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => now, healthHeartbeatMs: 30_000 });

  await runtime.runUntilDisconnected();

  expect(healthEvents.filter(event => event.connectionState === "connected")).toHaveLength(2);
});

it("does not infer contiguous semantics for unvalidated numeric full snapshots", async () => {
  const bus = new InMemoryEventBus();
  const adapter = fakeAdapter();
  adapter.stream = async function* () {
    yield { ...snapshot(), transport: "websocket", sequence: 100 };
    yield { ...snapshot(), eventId: "evt_jump", transport: "websocket", sequence: 102 };
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000 });

  await runtime.runUntilDisconnected();

  expect(runtime.health().sequenceIntegrity).not.toBe("gap");
});

it("publishes degraded rate-limit health before Retry-After and healthy recovery afterwards", async () => {
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  let calls = 0;
  const adapter = fakeAdapter();
  adapter.snapshot = async () => {
    calls += 1;
    if (calls === 1) throw new RetryAfterError("429", 250);
    return snapshot();
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000, retry: { sleep: async () => {} } });

  await runtime.pollOnce();

  const limited = healthEvents.findIndex(event => event.connectionState === "degraded" && event.rateLimit.state === "limited" && event.rateLimit.retryAfterMs === 250);
  expect(limited).toBeGreaterThanOrEqual(0);
  expect(healthEvents.slice(limited + 1).some(event => event.connectionState === "connected" && event.rateLimit.state === "healthy")).toBe(true);
});

it("does not expose adapter credentials through health events or diagnostic codes", async () => {
  const sentinel = "credential-SENTINEL-123";
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const adapter = fakeAdapter();
  adapter.snapshot = async () => {
    const error = new Error(`authorization: Bearer ${sentinel}`, { cause: new Error(sentinel) });
    Object.assign(error, { headers: { authorization: `Bearer ${sentinel}` } });
    throw error;
  };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000, retry: { sleep: async () => {} } });

  await expect(runtime.pollOnce()).resolves.toBeUndefined();

  expect(runtime.health().errorCounters).toEqual({ ADAPTER_FAILURE: 1 });
  expect(JSON.stringify({ healthEvents, health: runtime.health() })).not.toContain(sentinel);
});

it("does not expose forged diagnostic metadata through venue health", async () => {
  const sentinel = "forged-health-secret";
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const forged = Object.create(ConnectorDiagnosticError.prototype) as ConnectorDiagnosticError;
  Object.assign(forged as object, {
    code: "RATE_LIMITED", retryAfterMs: 12, name: sentinel, message: sentinel,
    cause: new Error(sentinel), metadata: { headers: { authorization: sentinel } },
  });
  const adapter = fakeAdapter();
  adapter.snapshot = async () => { throw forged; };
  const runtime = new ConnectorRuntime({ adapter, eventBus: bus, nowMs: () => 10_000, retry: { sleep: async () => {} } });

  await expect(runtime.pollOnce()).resolves.toBeUndefined();

  expect(runtime.health().errorCounters).toEqual({ RATE_LIMITED: 1 });
  expect(JSON.stringify({ healthEvents, health: runtime.health() })).not.toContain(sentinel);
});

it("continues REST polling until cancellation instead of stopping after the clean snapshot", async () => {
  const bus = new InMemoryEventBus();
  const controller = new AbortController();
  let snapshots = 0;
  const adapter = fakeAdapter();
  adapter.snapshot = async () => {
    snapshots += 1;
    if (snapshots === 2) controller.abort();
    return snapshot();
  };
  const runtime = new ConnectorRuntime({
    adapter,
    eventBus: bus,
    nowMs: () => 10_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  await runtime.start(controller.signal);

  expect(snapshots).toBe(2);
});

it("publishes a health update when clock skew changes without a connection-state transition", async () => {
  const bus = new InMemoryEventBus();
  const healthEvents = await published(bus, "venue.health.v1");
  const runtime = new ConnectorRuntime({ adapter: fakeAdapter({ sourceTimestampMs: 11_000 }), eventBus: bus, nowMs: () => 10_000 });

  await runtime.pollOnce();

  expect(healthEvents.some(event => event.connectionState === "connected" && event.clockSkewMs === 1_000)).toBe(true);
});

it("ends the persistent lifecycle cleanly when cancellation arrives during reconnect backoff", async () => {
  const bus = new InMemoryEventBus();
  const controller = new AbortController();
  const adapter: ConnectorAdapter = {
    venue: "bitget",
    async probe() { return { available: true }; },
    async discover() { return [instrument]; },
    async snapshot() { return snapshot(); },
    async *stream() { throw new Error("disconnect"); },
  };
  const runtime = new ConnectorRuntime({
    adapter,
    eventBus: bus,
    nowMs: () => 10_000,
    reconnect: {
      sleep: async () => {
        controller.abort();
        await new Promise<void>(() => {});
      },
    },
  });

  await expect(runtime.start(controller.signal)).resolves.toBeUndefined();
});
