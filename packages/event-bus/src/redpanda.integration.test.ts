import { expect, it, vi } from "vitest";
import { RedpandaContainer } from "@testcontainers/redpanda";
import { Kafka, logLevel } from "kafkajs";
import { RedpandaEventBus } from "./redpanda.js";
import { observation } from "./test-fixtures.js";
import type { EventBus } from "./event-bus.js";
import type { TopicPayload } from "./topics.js";

// Intentionally unconditional: missing Docker is a failed integration gate, not
// a passing skipped test. Run unit tests explicitly when Docker is unavailable.
it("replays one key in order after restarting the consumer with a new group", async () => {
  const container = await new RedpandaContainer("docker.redpanda.com/redpandadata/redpanda:v26.2.3")
    .withStartupTimeout(120_000).start();
  const config = { clientId: "range-contract", brokers: [container.getBootstrapServers()], logLevel: logLevel.NOTHING };
  const kafka = new Kafka(config);
  const admin = kafka.admin();
  const rawProducer = kafka.producer();
  const first = new RedpandaEventBus(config);
  const restarted = new RedpandaEventBus(config);
  try {
    await admin.connect();
    await admin.createTopics({ topics: [
      { topic: "market.observation.v1", numPartitions: 3, replicationFactor: 1 },
      { topic: "range.dead-letter.v1", numPartitions: 1, replicationFactor: 1 },
    ] });
    const firstSeen: (number | string | undefined)[] = [];
    const contract: EventBus = first;
    await contract.subscribe("market.observation.v1", "original", async event => { firstSeen.push(event.sequence); });
    await contract.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(1));
    await contract.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(2));
    await vi.waitFor(() => expect(firstSeen).toEqual([1, 2]), { timeout: 30_000 });
    await first.close();

    const replay: (number | string | undefined)[] = [];
    await restarted.subscribe("market.observation.v1", "new-group", async event => { replay.push(event.sequence); });
    await vi.waitFor(() => expect(replay).toEqual([1, 2]), { timeout: 30_000 });

    // Exercise the consume boundary with a producer that bypasses our schemas.
    const dead: TopicPayload["range.dead-letter.v1"][] = [];
    await restarted.subscribe("range.dead-letter.v1", "audit", async event => { dead.push(event); });
    await rawProducer.connect();
    await rawProducer.send({ topic: "market.observation.v1", messages: [{
      key: "bitget:RAAPLUSDT", value: '{"apiSecret":"DO_NOT_COPY"}',
      headers: { "trace-id": "9ca8b23b-0d61-4a91-a2d7-000000000001" },
    }] });
    await vi.waitFor(() => expect(dead).toHaveLength(1), { timeout: 30_000 });
    expect(dead[0]).toMatchObject({ originalTopic: "market.observation.v1", key: "bitget:RAAPLUSDT", errorCode: "INVALID_SCHEMA" });
    expect(JSON.stringify(dead)).not.toContain("DO_NOT_COPY");
    expect(replay).toEqual([1, 2]);
  } finally {
    // Container shutdown must still run if a client cleanup fails.
    try { await Promise.allSettled([first.close(), restarted.close(), rawProducer.disconnect(), admin.disconnect()]); }
    finally { await container.stop(); }
  }
}, 180_000);
