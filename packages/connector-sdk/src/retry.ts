export class RetryAfterError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "RetryAfterError";
  }
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

type RetryAfterCarrier = { retryAfterMs?: unknown };

function retryAfterMs(error: unknown): number | undefined {
  const value = (error as RetryAfterCarrier | undefined)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

const defaultSleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, delayMs));
};

/**
 * Retries a transient operation with capped exponential full-jitter backoff.
 * A venue-provided Retry-After is used verbatim, rather than randomized.
 */
export async function retryWithBackoff<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxBackoffMs = Math.min(options.maxBackoffMs ?? 30_000, 30_000);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be at least one");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      const cap = Math.min(maxBackoffMs, baseDelayMs * (2 ** attempt));
      const delayMs = retryAfterMs(error) ?? Math.min(cap, Math.floor(Math.min(1, Math.max(0, random())) * (cap + 1)));
      await sleep(delayMs);
    }
  }

  throw new Error("retry attempts exhausted");
}
