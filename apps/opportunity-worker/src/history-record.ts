import { createHash } from "node:crypto";
import type { Topic, TopicPayload } from "@range/event-bus";
import type { StoredEvent } from "@range/storage";

let syntheticEventSequence = 0;
function eventId<T extends Topic>(topic: T, event: TopicPayload[T], acceptedAtMs: number): string {
  const candidate = (event as unknown as { eventId?: unknown }).eventId;
  if (typeof candidate === "string" && candidate.length) return candidate;
  syntheticEventSequence += 1;
  return `evt_${createHash("sha256").update(topic).update(JSON.stringify(event)).update(String(acceptedAtMs))
    .update(String(syntheticEventSequence)).digest("hex")}`;
}

function underlying(event: unknown): string | undefined {
  return event && typeof event === "object" && typeof (event as { underlyingId?: unknown }).underlyingId === "string"
    ? (event as { underlyingId: string }).underlyingId : undefined;
}

/** The record is canonically hashed, so an absent optional field is omitted rather than set to undefined. */
export function historyRecord<T extends Topic>(topic: T, key: string, event: TopicPayload[T],
  context: { archiveId: string; calculationVersion: string }): StoredEvent<T> {
  const receivedTimestamp = (event as unknown as { receivedTimestamp?: unknown }).receivedTimestamp;
  const acceptedAtMs = typeof receivedTimestamp === "number" && Number.isSafeInteger(receivedTimestamp) && receivedTimestamp >= 0
    ? receivedTimestamp : Date.now();
  const underlyingId = underlying(event);
  return { eventId: eventId(topic, event, acceptedAtMs), topic, key, payload: event, acceptedAtMs, archiveId: context.archiveId,
    ...(underlyingId === undefined ? {} : { underlyingId }),
    ...((topic === "opportunity.v1" || topic === "evidence.bundle.v1") ? { calculationVersion: context.calculationVersion } : {}),
  } as StoredEvent<T>;
}
