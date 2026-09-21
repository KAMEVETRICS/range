/** Absolute source-vs-receive clock difference, expressed in milliseconds. */
export function clockSkewMs(sourceTimestampMs: number, receivedTimestampMs: number): number {
  return Math.abs(sourceTimestampMs - receivedTimestampMs);
}

export function isEpochMilliseconds(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
