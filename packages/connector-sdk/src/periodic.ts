/**
 * Merges a source stream with the results of a periodic poll. The poll runs at once and then every intervalMs; its
 * events are yielded between source events, in arrival order. The source is read at most one event ahead, so its own
 * backpressure holds. The merged stream ends with the source and fails with it; a failed poll is reported to
 * onPollError and tried again at the next interval.
 */
export async function* withPeriodic<T>(source: AsyncIterable<T>, poll: (signal: AbortSignal) => Promise<readonly T[]>,
  intervalMs: number, signal: AbortSignal, onPollError: (error: unknown) => void = () => {}): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const polled: T[] = [];
  const stopPolling = new AbortController();
  const pollSignal = AbortSignal.any([signal, stopPolling.signal]);
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runPoll = async () => {
    try { polled.push(...await poll(pollSignal)); }
    catch (error) { if (!pollSignal.aborted) onPollError(error); }
    if (pollSignal.aborted) return;
    wake?.();
    timer = setTimeout(() => void runPoll(), intervalMs);
  };
  void runPoll();
  let next: Promise<IteratorResult<T>> | undefined;
  try {
    for (;;) {
      if (polled.length) { yield polled.shift()!; continue; }
      if (!next) {
        next = iterator.next();
        next.catch(() => {}); // Raced below; a rejection while polled events drain must not go unhandled.
      }
      const polledArrived = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
      const result = await Promise.race([next, polledArrived]);
      wake = undefined;
      if (result === undefined) continue;
      next = undefined;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    stopPolling.abort();
    clearTimeout(timer);
    // An async iterator returns only after its pending read settles.
    if (next) void next.then(() => iterator.return?.(), () => {});
    else await iterator.return?.();
  }
}
