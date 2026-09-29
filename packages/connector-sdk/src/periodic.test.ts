import { afterEach, expect, it, vi } from "vitest";
import { withPeriodic } from "./periodic.js";

afterEach(() => vi.useRealTimers());

/** A source that yields each pushed value once it is requested, and records how far it has been read. */
function controlledSource<T>() {
  const pending: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: unknown;
  let reads = 0;
  async function* source() {
    for (;;) {
      reads += 1;
      while (!pending.length && !ended && failure === undefined) await new Promise<void>(resolve => { wake = resolve; });
      if (failure !== undefined) throw failure;
      if (!pending.length) return;
      yield pending.shift()!;
    }
  }
  const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
  return {
    source: source(),
    push: (...values: T[]) => { pending.push(...values); notify(); },
    end: () => { ended = true; notify(); },
    fail: (error: unknown) => { failure = error; notify(); },
    reads: () => reads,
  };
}

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  while (values.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    values.push(next.value);
  }
  return values;
}

it("yields source events and polled events, polling at once and then every interval", async () => {
  vi.useFakeTimers();
  const source = controlledSource<string>();
  let round = 0;
  const poll = vi.fn(async () => [`poll-${++round}`]);
  const merged = withPeriodic(source.source, poll, 60_000, new AbortController().signal);

  expect(await take(merged, 1)).toEqual(["poll-1"]);
  source.push("book-1", "book-2");
  expect(await take(merged, 2)).toEqual(["book-1", "book-2"]);
  expect(poll).toHaveBeenCalledTimes(1);

  const next = merged.next();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await next).toEqual({ done: false, value: "poll-2" });
  expect(poll).toHaveBeenCalledTimes(2);
  await merged.return(undefined);
});

it("reads the source at most one event ahead", async () => {
  vi.useFakeTimers();
  const source = controlledSource<string>();
  const merged = withPeriodic(source.source, async () => ["poll"], 60_000, new AbortController().signal);
  source.push("a", "b", "c", "d");
  expect(await take(merged, 2)).toEqual(["poll", "a"]);
  expect(source.reads()).toBeLessThanOrEqual(2);
  await merged.return(undefined);
});

it("skips a failed poll, reports it and keeps both the source and later polls", async () => {
  vi.useFakeTimers();
  const source = controlledSource<string>();
  const errors: unknown[] = [];
  let round = 0;
  const poll = async () => { round += 1; if (round === 1) throw new Error("venue busy"); return [`poll-${round}`]; };
  const merged = withPeriodic(source.source, poll, 60_000, new AbortController().signal, error => errors.push(error));
  source.push("book-1");
  expect(await take(merged, 1)).toEqual(["book-1"]);
  expect(errors).toHaveLength(1);
  const next = merged.next();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await next).toEqual({ done: false, value: "poll-2" });
  await merged.return(undefined);
});

it("ends with its source and stops polling", async () => {
  vi.useFakeTimers();
  const source = controlledSource<string>();
  const poll = vi.fn(async () => [] as string[]);
  const merged = withPeriodic(source.source, poll, 60_000, new AbortController().signal);
  source.push("book-1");
  source.end();
  expect(await take(merged, 5)).toEqual(["book-1"]);
  expect(await merged.next()).toEqual({ done: true, value: undefined });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(poll).toHaveBeenCalledTimes(1);
});

it("fails with its source", async () => {
  vi.useFakeTimers();
  const source = controlledSource<string>();
  const merged = withPeriodic(source.source, async () => [] as string[], 60_000, new AbortController().signal);
  source.fail(new Error("socket closed"));
  await expect(take(merged, 1)).rejects.toThrow("socket closed");
});
