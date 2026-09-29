import { beforeEach, expect, it, vi } from "vitest";
import type { EachMessagePayload } from "kafkajs";
import { createHash } from "node:crypto";
import { observation } from "./test-fixtures.js";
import { RedpandaEventBus } from "./redpanda.js";

// The broker is the external boundary. Capture sends and commits to exercise the
// real transport's validation and acknowledgement decisions without Docker.
const broker = vi.hoisted(() => ({
  producer: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
  consumer: { connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(), run: vi.fn(), commitOffsets: vi.fn() },
  admin: { connect: vi.fn(), disconnect: vi.fn(), deleteGroups: vi.fn() },
  producerOptions: vi.fn(), consumerOptions: vi.fn(),
}));
vi.mock("kafkajs", () => ({
  Kafka: class {
    producer(options: unknown) { broker.producerOptions(options); return broker.producer; }
    consumer(options: unknown) { broker.consumerOptions(options); return broker.consumer; }
    admin() { return broker.admin; }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [...Object.values(broker.producer), ...Object.values(broker.consumer), ...Object.values(broker.admin)]) {
    method.mockResolvedValue(undefined);
  }
});
const bus = () => new RedpandaEventBus({ clientId: "test", brokers: ["localhost:19092"] });
const delivery = (value: string | null, traceId = "9ca8b23b-0d61-4a91-a2d7-000000000001"): EachMessagePayload => ({
  topic: "market.observation.v1", partition: 2,
  message: {
    key: Buffer.from("bitget:RAAPLUSDT"), value: value === null ? null : Buffer.from(value),
    offset: "9007199254740993", timestamp: "1790000000000", attributes: 0,
    headers: { "trace-id": Buffer.from(traceId) },
  },
  heartbeat: async () => {}, pause: () => () => {},
});
const receive = () => broker.consumer.run.mock.calls[0]![0].eachMessage as (message: EachMessagePayload) => Promise<void>;
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

it("publishes validated messages with keyed ordering and idempotence", async () => {
  const transport = bus();
  await transport.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(1));
  expect(broker.producerOptions).toHaveBeenCalledWith(expect.objectContaining({ idempotent: true, maxInFlightRequests: 1 }));
  const sent = broker.producer.send.mock.calls[0]![0];
  expect(sent).toMatchObject({ topic: "market.observation.v1", acks: -1, messages: [{ key: "bitget:RAAPLUSDT" }] });
  expect(JSON.parse(sent.messages[0].value)).toEqual(observation(1));
  await transport.close();
});

it("batches commits through KafkaJS and resolves a message only after its handler succeeds", async () => {
  const transport = bus();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const seen: unknown[] = [];
  const stop = await transport.subscribe("market.observation.v1", "test", async event => { seen.push(event); await blocked; });
  expect(broker.consumer.run.mock.calls[0]![0]).toMatchObject({ autoCommit: true, autoCommitInterval: 1_000, autoCommitThreshold: 1_000 });
  let resolved = false;
  const processing = receive()(delivery(JSON.stringify(observation(1)))).then(() => { resolved = true; });
  await settled();
  expect(resolved).toBe(false);
  release();
  await processing;
  expect(seen).toEqual([observation(1)]);
  // KafkaJS resolves and commits the offset once eachMessage succeeds; the bus never commits per message itself.
  expect(broker.consumer.commitOffsets).not.toHaveBeenCalled();
  await stop();
  await stop();
  expect(broker.consumer.disconnect).toHaveBeenCalledTimes(1);
  await transport.close();
});

it("deletes a subscription's own consumer group after it stops, and keeps other groups", async () => {
  const transport = bus();
  const stopFresh = await transport.subscribe("instrument.registry.v1", "registry-replay-1", async () => {}, { deleteGroupOnStop: true });
  const stopShared = await transport.subscribe("instrument.registry.v1", "history-instruments", async () => {});
  await stopShared();
  expect(broker.admin.deleteGroups).not.toHaveBeenCalled();
  await stopFresh();
  expect(broker.admin.deleteGroups).toHaveBeenCalledTimes(1);
  expect(broker.admin.deleteGroups).toHaveBeenCalledWith(["registry-replay-1"]);
  // A group can be deleted only once its member has left.
  expect(broker.consumer.disconnect.mock.invocationCallOrder[1]).toBeLessThan(broker.admin.deleteGroups.mock.invocationCallOrder[0]!);
  expect(broker.admin.disconnect).toHaveBeenCalledTimes(1);
  await transport.close();
  expect(broker.admin.deleteGroups).toHaveBeenCalledTimes(1);
});

it("deletes such a group when the bus closes, and still stops if the delete fails", async () => {
  const transport = bus();
  broker.admin.deleteGroups.mockRejectedValue(new Error("broker down"));
  await transport.subscribe("instrument.registry.v1", "registry-replay-2", async () => {}, { deleteGroupOnStop: true });
  await expect(transport.close()).resolves.toBeUndefined();
  expect(broker.admin.deleteGroups).toHaveBeenCalledWith(["registry-replay-2"]);
  expect(broker.admin.disconnect).toHaveBeenCalledTimes(1);
});

it("does not commit or dead-letter transient handler failures", async () => {
  const transport = bus();
  await transport.subscribe("market.observation.v1", "test", async () => { throw new Error("temporary"); });
  await expect(receive()(delivery(JSON.stringify(observation(1))))).rejects.toThrow("temporary");
  expect(broker.consumer.commitOffsets).not.toHaveBeenCalled();
  expect(broker.producer.send).not.toHaveBeenCalled();
  await transport.close();
});

it.each([
  ['{"apiSecret":"NEVER_LOG"}', "INVALID_SCHEMA"],
  ['{"apiSecret":"NEVER_LOG"', "INVALID_JSON"],
  [null, "INVALID_JSON"],
])("quarantines an invalid consumed payload and resolves it only after durable dead-letter send", async (raw, code) => {
  const transport = bus();
  const handler = vi.fn();
  await transport.subscribe("market.observation.v1", "test", handler);
  let release!: () => void;
  broker.producer.send.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  let resolved = false;
  const processing = receive()(delivery(raw)).then(() => { resolved = true; });
  await vi.waitFor(() => expect(broker.producer.send).toHaveBeenCalledTimes(1));
  expect(handler).not.toHaveBeenCalled();
  expect(resolved).toBe(false);
  const sent = broker.producer.send.mock.calls[0]![0];
  expect(sent.topic).toBe("range.dead-letter.v1");
  expect(JSON.parse(sent.messages[0].value)).toEqual({
    originalTopic: "market.observation.v1", key: "bitget:RAAPLUSDT",
    payloadHash: `sha256:${createHash("sha256").update(raw ?? "").digest("hex")}`,
    errorCode: code, traceId: "9ca8b23b-0d61-4a91-a2d7-000000000001",
  });
  expect(JSON.stringify(sent)).not.toContain("NEVER_LOG");
  release();
  await processing;
  expect(resolved).toBe(true);
  expect(broker.consumer.commitOffsets).not.toHaveBeenCalled();
  await transport.close();
});

it("keeps invalid messages uncommitted if the dead-letter broker send fails", async () => {
  const transport = bus();
  await transport.subscribe("market.observation.v1", "test", async () => {});
  broker.producer.send.mockRejectedValue(new Error("broker down"));
  await expect(receive()(delivery("{}"))).rejects.toThrow("broker down");
  expect(broker.consumer.commitOffsets).not.toHaveBeenCalled();
  await transport.close();
});

it("validates before publishing and rejects without sending to the original topic", async () => {
  const transport = bus();
  await expect(transport.publish("market.observation.v1", "key", { ...observation(1), eligibility: undefined } as never)).rejects.toThrow("INVALID_SCHEMA");
  expect(broker.producer.send.mock.calls.map(call => call[0].topic)).toEqual(["range.dead-letter.v1"]);
  await transport.close();
});

const batchMessage = (value: string, offset: string) => ({
  key: Buffer.from("bitget:RAAPLUSDT"), value: Buffer.from(value), offset, timestamp: "1790000000000", attributes: 0,
  headers: { "trace-id": Buffer.from("9ca8b23b-0d61-4a91-a2d7-000000000001") },
});
const receiveBatch = () => broker.consumer.run.mock.calls[0]![0].eachBatch as (payload: unknown) => Promise<void>;
function batchOf(messages: ReturnType<typeof batchMessage>[]) {
  const resolveOffset = vi.fn();
  return { resolveOffset, payload: { batch: { topic: "market.observation.v1", partition: 0, messages }, resolveOffset,
    heartbeat: vi.fn(async () => {}), isRunning: () => true, isStale: () => false } };
}

it("delivers bounded batches and resolves each one only after its handler succeeds", async () => {
  const transport = bus();
  const batches: unknown[][] = [];
  await transport.subscribeBatch("market.observation.v1", "test", async events => { batches.push(events.map(event => event.sequence)); }, 2);
  expect(broker.consumer.run.mock.calls[0]![0]).toMatchObject({
    autoCommit: true, autoCommitInterval: 1_000, autoCommitThreshold: 1_000, eachBatchAutoResolve: false });
  const { payload, resolveOffset } = batchOf([1, 2, 3].map(n => batchMessage(JSON.stringify(observation(n)), String(10 + n))));

  await receiveBatch()(payload);

  expect(batches).toEqual([[1, 2], [3]]);
  expect(resolveOffset.mock.calls).toEqual([["12"], ["13"]]);
  expect(broker.consumer.commitOffsets).not.toHaveBeenCalled();
  await transport.close();
});

it("leaves a failed batch unresolved so it is redelivered", async () => {
  const transport = bus();
  await transport.subscribeBatch("market.observation.v1", "test", async () => { throw new Error("temporary"); });
  const { payload, resolveOffset } = batchOf([batchMessage(JSON.stringify(observation(1)), "11")]);

  await expect(receiveBatch()(payload)).rejects.toThrow("temporary");
  expect(resolveOffset).not.toHaveBeenCalled();
  expect(broker.producer.send).not.toHaveBeenCalled();
  await transport.close();
});

it("dead-letters an invalid message between batches without reordering valid events", async () => {
  const transport = bus();
  const batches: unknown[][] = [];
  await transport.subscribeBatch("market.observation.v1", "test", async events => { batches.push(events.map(event => event.sequence)); });
  const { payload, resolveOffset } = batchOf([batchMessage(JSON.stringify(observation(1)), "11"),
    batchMessage('{"apiSecret":"NEVER_LOG"}', "12"), batchMessage(JSON.stringify(observation(3)), "13")]);

  await receiveBatch()(payload);

  expect(batches).toEqual([[1], [3]]);
  expect(resolveOffset.mock.calls).toEqual([["11"], ["12"], ["13"]]);
  expect(broker.producer.send.mock.calls.map(call => call[0].topic)).toEqual(["range.dead-letter.v1"]);
  expect(JSON.stringify(broker.producer.send.mock.calls)).not.toContain("NEVER_LOG");
  await transport.close();
});
