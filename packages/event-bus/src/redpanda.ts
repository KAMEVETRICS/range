import { randomUUID } from "node:crypto";
import { Kafka, type ConsumerRunConfig, type KafkaConfig, type KafkaMessage, type Producer } from "kafkajs";
import type { EventBus, SubscribeOptions } from "./event-bus.js";
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

  subscribe<T extends Topic>(topic: T, groupId: string, handler: (event: TopicPayload[T]) => Promise<void>,
    options: SubscribeOptions = {}) {
    return this.consume(topic, groupId, options, {
      eachMessage: async ({ message }) => {
        const decoded = this.decode(topic, message);
        if ("deadLetter" in decoded) { await decoded.deadLetter(); return; }
        // Handler errors are transient unless a future explicit contract says
        // otherwise. Let KafkaJS retry; never commit or quarantine them here.
        await handler(decoded.event);
      },
    });
  }

  subscribeBatch<T extends Topic>(topic: T, groupId: string, handler: (events: TopicPayload[T][]) => Promise<void>,
    maxBatchSize = 500) {
    return this.consume(topic, groupId, {}, {
      // Offsets are resolved per delivered chunk below, never for a whole fetched batch up front.
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        let chunk: Array<{ offset: string; event: TopicPayload[T] }> = [];
        const deliver = async () => {
          if (!chunk.length) return;
          await handler(chunk.map(item => item.event));
          resolveOffset(chunk.at(-1)!.offset);
          chunk = [];
          await heartbeat();
        };
        for (const message of batch.messages) {
          if (!isRunning() || isStale()) return;
          const decoded = this.decode(topic, message);
          if ("deadLetter" in decoded) {
            await deliver();
            await decoded.deadLetter();
            resolveOffset(message.offset);
            continue;
          }
          chunk.push({ offset: message.offset, event: decoded.event });
          if (chunk.length >= maxBatchSize) await deliver();
        }
        await deliver();
      },
    });
  }

  private decode<T extends Topic>(topic: T, message: KafkaMessage): { event: TopicPayload[T] } | { deadLetter: () => Promise<void> } {
    try { return { event: decodeEvent(topic, message.value) }; }
    catch (error) {
      if (!(error instanceof InvalidEventError) || topic === "range.dead-letter.v1") throw error;
      const header = message.headers?.["trace-id"];
      const traceId = typeof header === "string" || Buffer.isBuffer(header) ? header.toString() : undefined;
      const key = message.key?.toString() ?? "";
      return { deadLetter: () => this.publish("range.dead-letter.v1", key, deadLetter(topic, key, message.value, error, traceId)) };
    }
  }

  private async consume(topic: Topic, groupId: string, options: SubscribeOptions,
    handlers: Pick<ConsumerRunConfig, "eachMessage" | "eachBatch" | "eachBatchAutoResolve">): Promise<() => Promise<void>> {
    this.assertOpen();
    const consumer = this.kafka.consumer({ groupId });
    let stopping: Promise<void> | undefined;
    // The group can be deleted only after its member has left.
    const stop = () => stopping ??= consumer.disconnect()
      .then(() => options.deleteGroupOnStop ? this.deleteGroup(groupId) : undefined)
      .finally(() => { this.subscriptions.delete(stop); });
    this.subscriptions.add(stop);
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({
        // KafkaJS resolves an offset only once its handler succeeds, and commits resolved offsets at the end of
        // each fetched batch or every second / 1,000 messages. A failed message is never resolved, so it retries.
        autoCommit: true, autoCommitInterval: 1_000, autoCommitThreshold: 1_000, ...handlers,
      });
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  }

  /** Best effort: a group this fails to delete expires with the broker's offset retention. */
  private async deleteGroup(groupId: string): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteGroups([groupId]);
    } catch { /* left to offset retention */ }
    finally { await admin.disconnect().catch(() => {}); }
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
