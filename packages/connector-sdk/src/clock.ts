/**
 * How far a source timestamp is ahead of receipt, in milliseconds. An older timestamp is data age, not skew:
 * venues stamp books with their last change, and freshness budgets already reject stale inputs.
 */
export function clockSkewMs(sourceTimestampMs: number, receivedTimestampMs: number): number {
  return Math.max(0, sourceTimestampMs - receivedTimestampMs);
}

export function isEpochMilliseconds(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
