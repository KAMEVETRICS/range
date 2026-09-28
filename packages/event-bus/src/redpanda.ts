import { randomUUID } from "node:crypto";
import { Kafka, type KafkaConfig, type Producer } from "kafkajs";
import type { EventBus } from "./event-bus.js";
import type { Topic, TopicPayload } from "./topics.js";
import { deadLetter, decodeEvent, encodeEvent, InvalidEventError, payloadBytes } from "./validation.js";

/** At-least-once consumption: make handlers idempotent. An offset is committed
 * only after its handler succeeds, in batches, so a crash may replay up to about
 * a second of already-handled events.
 */
export class RedpandaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private connection?: Promise<void>;
  private readonly subscriptions = new Set<() => Promise<void>>();
  private closed = false;

  constructor(config: KafkaConfig) {
    this.kafka = new Kafka(config);
    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  }

  async publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]): Promise<void> {
    this.assertOpen();
    let value: string;
    try { value = encodeEvent(topic, event); }
    catch (error) {
      if (error instanceof InvalidEventError && topic !== "range.dead-letter.v1") {
        await this.publish("range.dead-letter.v1", key, deadLetter(topic, key, payloadBytes(event), error));
      }
      throw error;
    }
    await this.connect();
    await this.producer.send({ topic, acks: -1, messages: [{ key, value, headers: { "trace-id": randomUUID() } }] });
  }

  async subscribe<T extends Topic>(topic: T, groupId: string, handler: (event: TopicPayload[T]) => Promise<void>) {
    this.assertOpen();
    const consumer = this.kafka.consumer({ groupId });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= consumer.disconnect().finally(() => { this.subscriptions.delete(stop); });
    this.subscriptions.add(stop);
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({
        // KafkaJS resolves an offset only once eachMessage succeeds, and commits resolved offsets at the end of
        // each fetched batch or every second / 1,000 messages. A failed message is never resolved, so it retries.
        autoCommit: true, autoCommitInterval: 1_000, autoCommitThreshold: 1_000,
        eachMessage: async ({ message }) => {
          let event: TopicPayload[T];
          try { event = decodeEvent(topic, message.value); }
          catch (error) {
            if (!(error instanceof InvalidEventError) || topic === "range.dead-letter.v1") throw error;
            const header = message.headers?.["trace-id"];
            const traceId = typeof header === "string" || Buffer.isBuffer(header) ? header.toString() : undefined;
            await this.publish("range.dead-letter.v1", message.key?.toString() ?? "", deadLetter(
              topic, message.key?.toString() ?? "", message.value, error, traceId,
            ));
            return;
          }
          // Handler errors are transient unless a future explicit contract says
          // otherwise. Let KafkaJS retry; never commit or quarantine them here.
          await handler(event);
        },
      });
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  }

  async close(): Promise<void> {
    // Consumers may still publish dead letters while draining on disconnect.
    await Promise.all([...this.subscriptions].map(stop => stop()));
    this.closed = true;
    if (this.connection) {
      await this.connection;
      await this.producer.disconnect();
      this.connection = undefined;
    }
  }

  private assertOpen() { if (this.closed) throw new Error("Event bus is closed"); }

  private connect(): Promise<void> {
    return this.connection ??= this.producer.connect().catch(error => {
      this.connection = undefined;
      throw error;
    });
  }
}
