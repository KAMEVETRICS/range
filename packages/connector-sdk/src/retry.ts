export type ConnectorDiagnosticCode = "ABORTED" | "RATE_LIMITED" | "SEQUENCE_GAP" | "ADAPTER_FAILURE";

const diagnosticMessages: Record<ConnectorDiagnosticCode, string> = {
  ABORTED: "Connector operation aborted",
  RATE_LIMITED: "Venue rate limit encountered",
  SEQUENCE_GAP: "Validated book sequence gap",
  ADAPTER_FAILURE: "Connector adapter operation failed",
};

/** Safe outward-facing error: it deliberately retains no adapter message, cause, or headers. */
export class ConnectorDiagnosticError extends Error {
  readonly code!: ConnectorDiagnosticCode;
  readonly retryAfterMs?: number;

  constructor(code: ConnectorDiagnosticCode, retryAfterMs?: number) {
    super(diagnosticMessages[code]);
    Object.defineProperties(this, {
      code: { value: code, enumerable: true, writable: false, configurable: false },
      retryAfterMs: { value: retryAfterMs, enumerable: true, writable: false, configurable: false },
      name: { value: "ConnectorDiagnosticError", enumerable: false, writable: false, configurable: false },
      message: { value: diagnosticMessages[code], enumerable: false, writable: false, configurable: false },
    });
  }
}

export class RetryAfterError extends Error {
  constructor(_message: string, readonly retryAfterMs: number) {
    super("Venue requested retry");
    this.name = "RetryAfterError";
  }
}

export interface RetryContext {
  readonly attempt: number;
  readonly delayMs: number;
  readonly code: ConnectorDiagnosticCode;
  readonly retryAfterMs?: number;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onRetry?: (context: RetryContext) => void | Promise<void>;
}

type RetryAfterCarrier = { retryAfterMs?: unknown };

export function safeRetryAfterMs(error: unknown): number | undefined {
  let value: unknown;
  try { value = (error as RetryAfterCarrier | undefined)?.retryAfterMs; }
  catch { return undefined; }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function toConnectorDiagnostic(error: unknown): ConnectorDiagnosticError {
  if (error instanceof ConnectorDiagnosticError) {
    let code: unknown;
    try { code = error.code; } catch { code = undefined; }
    if (code === "ABORTED" || code === "RATE_LIMITED" || code === "SEQUENCE_GAP" || code === "ADAPTER_FAILURE") {
      return new ConnectorDiagnosticError(code, safeRetryAfterMs(error));
    }
  }
  const retryAfterMs = safeRetryAfterMs(error);
  return new ConnectorDiagnosticError(retryAfterMs === undefined ? "ADAPTER_FAILURE" : "RATE_LIMITED", retryAfterMs);
}

function aborted(signal?: AbortSignal): ConnectorDiagnosticError | undefined {
  return signal?.aborted ? new ConnectorDiagnosticError("ABORTED") : undefined;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Own the timer so cancellation can clear it, even for a multi-day cooldown. */
async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.max(0, Math.ceil(delayMs));
  if (!Number.isSafeInteger(deadline)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  do {
    await new Promise<void>((resolve, reject) => {
      const remaining = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.min(remaining, MAX_TIMER_DELAY_MS));
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new ConnectorDiagnosticError("ABORTED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  } while (Date.now() < deadline);
}

export function backoffDelayMs(attempt: number, options: RetryOptions, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxBackoffMs = Math.min(options.maxBackoffMs ?? 30_000, 30_000);
  const cap = Math.min(maxBackoffMs, baseDelayMs * (2 ** attempt));
  const random = options.random ?? Math.random;
  return Math.min(cap, Math.floor(Math.min(1, Math.max(0, random())) * (cap + 1)));
}

/** Waits with prompt cancellation even when a test or adapter injects a long custom sleep. */
export async function waitForRetry(delayMs: number, options: Pick<RetryOptions, "sleep" | "signal">): Promise<void> {
  const preflight = aborted(options.signal);
  if (preflight) throw preflight;
  if (!options.sleep) {
    await defaultSleep(delayMs, options.signal);
    return;
  }
  const sleep = options.sleep;
  if (!options.signal) {
    try { await sleep(delayMs); }
    catch (error) { throw toConnectorDiagnostic(error); }
    return;
  }
  const signal = options.signal;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new ConnectorDiagnosticError("ABORTED"));
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<void>;
    try { pending = sleep(delayMs); }
    catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(toConnectorDiagnostic(error));
      return;
    }
    pending.then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      error => { signal.removeEventListener("abort", onAbort); reject(toConnectorDiagnostic(error)); },
    );
  });
}

/** Retries with capped full jitter; raw adapter errors never leave this boundary. */
export async function retryWithBackoff<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be at least one");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const preflight = aborted(options.signal);
    if (preflight) throw preflight;
    try {
      return await operation(options.signal);
    } catch (error) {
      const cancelled = aborted(options.signal);
      if (cancelled) throw cancelled;
      const diagnostic = toConnectorDiagnostic(error);
      if (attempt === maxAttempts - 1) throw diagnostic;
      const delayMs = backoffDelayMs(attempt, options, diagnostic.retryAfterMs);
      await options.onRetry?.({ attempt, delayMs, code: diagnostic.code, retryAfterMs: diagnostic.retryAfterMs });
      await waitForRetry(delayMs, options);
    }
  }
  throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
}
