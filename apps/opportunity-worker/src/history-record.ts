import { createHash } from "node:crypto";
import type { Topic, TopicPayload } from "@range/event-bus";
import { CitationPendingError, type StoredEvent } from "@range/storage";

/**
 * Evidence cites books and funding a second or two before their own history writers record them, and a result cites its
 * evidence the same way. Such a batch waits and tries again here: thrown straight to the broker client, each one crashed
 * its consumer through retries and a rebalance (about 1,600 errors an hour). Fifteen tries a second apart stay inside
 * the broker's 30 s session timeout; after that the error goes to the broker client as before.
 */
export async function writeOnceCited(write: () => Promise<void>,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { attempts = 15, delayMs = 1_000, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) } = options;
  for (let attempt = 1; ; attempt++) {
    try { return await write(); }
    catch (error) {
      if (!(error instanceof CitationPendingError) || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

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

/**
 * History keeps executable books only. Reference-only books (every bulk-read venue, and Bitget listings outside the
 * reviewed set) are display data: they feed the market board, never opportunities or evidence, and were most of the
 * books written to Postgres.
 */
export function keptInHistory(book: { readonly eligibility: string }): boolean {
  return book.eligibility === "live";
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
