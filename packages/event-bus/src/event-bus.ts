import type { Topic, TopicPayload } from "./topics.js";

export interface SubscribeOptions {
  /** Delete the consumer group once the subscription stops. Only for a group that this subscription alone uses,
   * such as a fresh group that replays a topic from the start on every run. A group left behind by a crash expires
   * with the broker's offset retention instead. */
  readonly deleteGroupOnStop?: boolean;
}

export interface EventBus {
  publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]): Promise<void>;
  subscribe<T extends Topic>(
    topic: T,
    groupId: string,
    handler: (event: TopicPayload[T]) => Promise<void>,
    options?: SubscribeOptions,
  ): Promise<() => Promise<void>>;
  /** Delivers events in order, in batches of at most maxBatchSize. A batch is acknowledged only after its handler
   * resolves; a failed batch is redelivered, so handlers must be idempotent. */
  subscribeBatch<T extends Topic>(
    topic: T,
    groupId: string,
    handler: (events: TopicPayload[T][]) => Promise<void>,
    maxBatchSize?: number,
  ): Promise<() => Promise<void>>;
}
