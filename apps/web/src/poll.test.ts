import { afterEach, expect, it, vi } from "vitest";
import { pollWhileIdle } from "./api/poll.js";

afterEach(() => vi.useRealTimers());

it("skips ticks while the previous load is still running, so a stalled connection piles nothing up", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const load = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const stop = pollWhileIdle(load, 1_000);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(load).toHaveBeenCalledTimes(2);
  stop();
});

it("keeps polling after a failed load, and waits for the first tick when not immediate", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async () => { throw new Error("offline"); });
  const stop = pollWhileIdle(load, 1_000, { immediate: false });
  expect(load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(load).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(load).toHaveBeenCalledTimes(3);
});

it("skips a tick when told to, as while the page is hidden", async () => {
  vi.useFakeTimers();
  let hidden = true;
  const load = vi.fn(async () => undefined);
  const stop = pollWhileIdle(load, 1_000, { immediate: false, skip: () => hidden });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(load).not.toHaveBeenCalled();
  hidden = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(load).toHaveBeenCalledTimes(1);
  stop();
});
