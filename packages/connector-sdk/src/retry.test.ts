import { expect, it } from "vitest";
import { RetryAfterError, retryWithBackoff } from "./retry.js";

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
