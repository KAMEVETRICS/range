import { expect, it } from "vitest";
import { observation } from "./test-fixtures.js";
import { InMemoryEventBus } from "./in-memory.js";
import type { TopicPayload } from "./topics.js";

it("preserves order for one venue-instrument key", async () => {
  const bus = new InMemoryEventBus();
  const seen: (number | string)[] = [];
  await bus.subscribe("market.observation.v1", "test", async event => {
    seen.push(event.sequence ?? 0);
  });
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(1));
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(2));
  expect(seen).toEqual([1, 2]);
});

it("serializes concurrent handlers for a key and isolates payload mutations between groups", async () => {
  const bus = new InMemoryEventBus();
  const seen: (string | number | undefined)[] = [];
  await bus.subscribe("market.observation.v1", "mutator", async event => {
    await new Promise(resolve => setTimeout(resolve, event.sequence === 1 ? 20 : 0));
    seen.push(event.sequence);
    event.sequence = 999;
  });
  const other: (string | number | undefined)[] = [];
  await bus.subscribe("market.observation.v1", "other", async event => { other.push(event.sequence); });
  await Promise.all([1, 2].map(sequence => bus.publish("market.observation.v1", "key", observation(sequence))));
  expect(seen).toEqual([1, 2]);
  expect(other).toEqual([1, 2]);
});

it("replays a new group and resumes a stopped group after its successful offset", async () => {
  const bus = new InMemoryEventBus();
  await bus.publish("market.observation.v1", "key", observation(1));
  const seen: (number | string | undefined)[] = [];
  const stop = await bus.subscribe("market.observation.v1", "first", async event => { seen.push(event.sequence); });
  await stop();
  await stop();
  await bus.publish("market.observation.v1", "key", observation(2));
  await bus.subscribe("market.observation.v1", "first", async event => { seen.push(event.sequence); });
  expect(seen).toEqual([1, 2]);
  const replay: (number | string | undefined)[] = [];
  await bus.subscribe("market.observation.v1", "new", async event => { replay.push(event.sequence); });
  expect(replay).toEqual([1, 2]);
});

it("forgets a group deleted on stop, so reusing its ID replays from the start", async () => {
  const bus = new InMemoryEventBus();
  await bus.publish("market.observation.v1", "key", observation(1));
  const seen: (number | string | undefined)[] = [];
  const stop = await bus.subscribe("market.observation.v1", "fresh", async event => { seen.push(event.sequence); },
    { deleteGroupOnStop: true });
  await stop();
  await bus.subscribe("market.observation.v1", "fresh", async event => { seen.push(event.sequence); });
  expect(seen).toEqual([1, 1]);
});

it("does not advance a failed handler past its event", async () => {
  const bus = new InMemoryEventBus();
  let fail = true;
  const seen: (number | string | undefined)[] = [];
  await bus.subscribe("market.observation.v1", "test", async event => {
    if (fail) throw new Error("temporary");
    seen.push(event.sequence);
  });
  await expect(bus.publish("market.observation.v1", "key", observation(1))).rejects.toThrow("temporary");
  fail = false;
  await bus.publish("market.observation.v1", "key", observation(2));
  expect(seen).toEqual([1, 2]);
});

it("delivers each event to only one subscriber per group", async () => {
  const bus = new InMemoryEventBus();
  const seen: (number | string | undefined)[] = [];
  const handler = async (event: TopicPayload["market.observation.v1"]) => { seen.push(event.sequence); };
  await bus.subscribe("market.observation.v1", "shared", handler);
  await bus.subscribe("market.observation.v1", "shared", handler);
  await bus.publish("market.observation.v1", "key", observation(1));
  expect(seen).toEqual([1]);
});

it.each([
  { eligibility: undefined },
  { sourceTimestamp: "2026-09-20T00:00:00Z" },
  { apiSecret: "DO_NOT_EXPOSE" },
])("dead-letters invalid publications without credentials: %j", async patch => {
  const bus = new InMemoryEventBus();
  const dead: TopicPayload["range.dead-letter.v1"][] = [];
  const seen: unknown[] = [];
  await bus.subscribe("range.dead-letter.v1", "audit", async event => { dead.push(event); });
  await bus.subscribe("market.observation.v1", "test", async event => { seen.push(event); });
  await expect(bus.publish("market.observation.v1", "key", { ...observation(1), ...patch } as never))
    .rejects.toThrow("INVALID_SCHEMA");
  expect(seen).toEqual([]);
  expect(dead).toEqual([{
    originalTopic: "market.observation.v1", key: "key", payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    errorCode: "INVALID_SCHEMA", traceId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  }]);
  expect(JSON.stringify(dead)).not.toContain("DO_NOT_EXPOSE");
});

it("does not recurse when a dead-letter publication itself is invalid", async () => {
  const bus = new InMemoryEventBus();
  await expect(bus.publish("range.dead-letter.v1", "key", {} as never)).rejects.toThrow("INVALID_SCHEMA");
});

it("delivers batch subscriptions in order, replaying from the start for a new group", async () => {
  const bus = new InMemoryEventBus();
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(1));
  const batches: (number | string | undefined)[][] = [];
  await bus.subscribeBatch("market.observation.v1", "batch", async events => { batches.push(events.map(event => event.sequence)); });
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(2));
  expect(batches.flat()).toEqual([1, 2]);
  expect(batches.every(batch => batch.length > 0)).toBe(true);
});
