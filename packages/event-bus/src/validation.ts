import { createHash, randomUUID } from "node:crypto";
import { DeadLetterSchema, parseEvent, type Topic, type TopicPayload } from "./topics.js";

export class InvalidEventError extends Error {
  constructor(readonly code: "INVALID_JSON" | "INVALID_SCHEMA") {
    // Never attach raw payloads, Zod issues, or parser errors to logs/errors.
    super(code);
    this.name = "InvalidEventError";
  }
}

export function encodeEvent<T extends Topic>(topic: T, event: TopicPayload[T]): string {
  try {
    return JSON.stringify(parseEvent(topic, event));
  } catch {
    throw new InvalidEventError("INVALID_SCHEMA");
  }
}

export function decodeEvent<T extends Topic>(topic: T, raw: Buffer | null): TopicPayload[T] {
  let value: unknown;
  try {
    if (raw === null) throw new Error();
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new InvalidEventError("INVALID_JSON");
  }
  try { return parseEvent(topic, value); }
  catch { throw new InvalidEventError("INVALID_SCHEMA"); }
}

export function payloadBytes(event: unknown): Buffer {
  // Non-JSON inputs have no wire representation; use a fixed, non-sensitive
  // sentinel for the hash. Valid canonical events are always JSON serializable.
  try { return Buffer.from(JSON.stringify(event) ?? "[non-json]"); }
  catch { return Buffer.from("[non-json]"); }
}

export function deadLetter(topic: Topic, key: string, raw: Buffer | null, error: InvalidEventError, traceId?: string) {
  return DeadLetterSchema.parse({
    originalTopic: topic, key,
    payloadHash: `sha256:${createHash("sha256").update(raw ?? Buffer.alloc(0)).digest("hex")}`,
    errorCode: error.code,
    // An arbitrary inbound header could contain credentials. Only retain UUIDs.
    traceId: DeadLetterSchema.shape.traceId.safeParse(traceId).success ? traceId : randomUUID(),
  });
}
