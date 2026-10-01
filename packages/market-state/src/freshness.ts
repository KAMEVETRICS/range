import type { BookMetadata } from "./order-book.js";

export function bookAgeMs(metadata: BookMetadata, nowMs: number): number | undefined {
  if (!Number.isSafeInteger(nowMs) || nowMs < metadata.sourceTimestamp) return undefined;
  return nowMs - metadata.sourceTimestamp;
}

export function isFreshBook(metadata: BookMetadata, nowMs: number): boolean {
  const age = bookAgeMs(metadata, nowMs);
  return age !== undefined && age <= metadata.freshnessBudgetMs;
}
