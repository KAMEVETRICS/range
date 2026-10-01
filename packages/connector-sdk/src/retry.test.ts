import { expect, it, vi } from "vitest";
import { ConnectorDiagnosticError, RetryAfterError, retryWithBackoff, waitForRetry } from "./retry.js";

it("clears the default timer when a long retry wait is aborted", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const pending = waitForRetry(30 * 86_400_000, { signal: controller.signal });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not finish a long default retry wait before its deadline", async () => {
  vi.useFakeTimers({ now: new Date("2026-09-22T10:00:00Z") });
  try {
    const duration = 30 * 86_400_000;
    let settled = false;
    const pending = waitForRetry(duration, {}).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("aborts during a long Retry-After wait without making another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let waiting = false;

  const pending = retryWithBackoff(async () => {
    attempts += 1;
    throw new RetryAfterError("429", 60_000);
  }, {
    signal: controller.signal,
    sleep: async () => {
      waiting = true;
      controller.abort();
      await new Promise<void>(() => {});
    },
  });

  await expect(pending).rejects.toMatchObject({ code: "ABORTED", message: "Connector operation aborted" });
  expect(waiting).toBe(true);
  expect(attempts).toBe(1);
});

it("sanitizes a custom retry-wait failure before it leaves the SDK", async () => {
  const sentinel = "retry-wait-secret";

  const pending = retryWithBackoff(async () => {
    throw new RetryAfterError("429", 1);
  }, {
    sleep: async () => { throw new Error(sentinel); },
  });

  await expect(pending).rejects.toMatchObject({ code: "ADAPTER_FAILURE", message: "Connector adapter operation failed" });
  await expect(pending).rejects.not.toThrow(sentinel);
});

it("creates a fresh safe diagnostic when an adapter forges and mutates a diagnostic error", async () => {
  const sentinel = "forged-diagnostic-secret";
  // An adapter can forge the exported error's prototype and arbitrary own
  // fields even though diagnostics created by the SDK freeze their identity.
  const forged = Object.create(ConnectorDiagnosticError.prototype) as ConnectorDiagnosticError;
  Object.assign(forged as object, {
    code: "RATE_LIMITED",
    retryAfterMs: 12,
    name: sentinel,
    message: sentinel,
    cause: new Error(sentinel),
    metadata: { authorization: sentinel },
  });

  const pending = retryWithBackoff(async () => { throw forged; }, { maxAttempts: 1 });

  await expect(pending).rejects.toMatchObject({
    code: "RATE_LIMITED",
    retryAfterMs: 12,
    name: "ConnectorDiagnosticError",
    message: "Venue rate limit encountered",
  });
  await expect(pending).rejects.not.toThrow(sentinel);
});
