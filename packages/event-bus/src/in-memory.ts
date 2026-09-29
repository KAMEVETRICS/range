import { createHash } from "node:crypto";
import type { EventBus, SubscribeOptions } from "./event-bus.js";
import type { Topic, TopicPayload } from "./topics.js";
import { deadLetter, decodeEvent, encodeEvent, InvalidEventError, payloadBytes } from "./validation.js";

type RecordEntry = { key: string; raw: Buffer };
type Group = {
  offset: number;
  handlers: Set<(raw: Buffer) => Promise<void>>;
  pending: Promise<void>;
};

/** Deterministic, process-local log. Groups replay from the beginning on first
 * subscription, resume successful offsets, and share deliveries among members.
 * publish waits for active handlers; failed handlers retry on the next publish
 * or subscription. Retention is unbounded, so use this for tests/local workloads.
 */
export class InMemoryEventBus implements EventBus {
  private readonly logs = new Map<Topic, RecordEntry[]>();
  private readonly groups = new Map<Topic, Map<string, Group>>();

  async publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]): Promise<void> {
    let raw: string;
    try { raw = encodeEvent(topic, event); }
    catch (error) {
      if (error instanceof InvalidEventError && topic !== "range.dead-letter.v1") {
        await this.publish("range.dead-letter.v1", key, deadLetter(topic, key, payloadBytes(event), error));
      }
      throw error;
    }
    const log = this.logs.get(topic) ?? [];
    this.logs.set(topic, log);
    log.push({ key, raw: Buffer.from(raw) });
    await Promise.all([...this.groups.get(topic)?.values() ?? []].map(group => this.drain(topic, group)));
  }

  async subscribe<T extends Topic>(topic: T, groupId: string, handler: (event: TopicPayload[T]) => Promise<void>,
    options: SubscribeOptions = {}) {
    const groups = this.groups.get(topic) ?? new Map<string, Group>();
    this.groups.set(topic, groups);
    const group = groups.get(groupId) ?? { offset: 0, handlers: new Set(), pending: Promise.resolve() };
    groups.set(groupId, group);
    const consume = async (raw: Buffer) => { await handler(decodeEvent(topic, raw)); };
    group.handlers.add(consume);
    try { await this.drain(topic, group); }
    catch (error) { group.handlers.delete(consume); throw error; }
    return async () => {
      group.handlers.delete(consume);
      await group.pending;
      if (options.deleteGroupOnStop && !group.handlers.size && groups.get(groupId) === group) groups.delete(groupId);
    };
  }

  /** Each event is its own batch here; batching only pays off against a real broker. */
  subscribeBatch<T extends Topic>(topic: T, groupId: string, handler: (events: TopicPayload[T][]) => Promise<void>) {
    return this.subscribe(topic, groupId, event => handler([event]));
  }

  private drain(topic: Topic, group: Group): Promise<void> {
    const pending = group.pending.then(async () => {
      const log = this.logs.get(topic) ?? [];
      while (group.offset < log.length && group.handlers.size > 0) {
        const record = log[group.offset]!;
        const handlers = [...group.handlers];
        const bucket = createHash("sha256").update(record.key).digest().readUInt32BE(0) % handlers.length;
        // Decode for each delivery, so handlers cannot mutate retained records
        // or another consumer group's view of an event.
        await handlers[bucket]!(record.raw);
        group.offset += 1;
      }
    });
    group.pending = pending.catch(() => {});
    return pending;
  }
}
