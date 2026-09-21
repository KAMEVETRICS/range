import type { Topic, TopicPayload } from "./topics.js";

export interface EventBus {
  publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]): Promise<void>;
  subscribe<T extends Topic>(
    topic: T,
    groupId: string,
    handler: (event: TopicPayload[T]) => Promise<void>,
  ): Promise<() => Promise<void>>;
}
