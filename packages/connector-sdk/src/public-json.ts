import { ConnectorDiagnosticError, waitForRetry } from "./retry.js";

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PublicJsonClientOptions {
  /** The venue's fixed https origin. */
  readonly origin: string;
  /** The only paths the client will request. */
  readonly paths: readonly string[];
  /** Minimum spacing between requests (default 250 ms). */
  readonly minIntervalMs?: number;
  /** Largest response accepted (default 4 MB). */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: PublicFetch;
  readonly nowMs?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_RETRY_AFTER_MS = 10_000;

function retryAfterMs(header: string | null, nowMs: number): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  const value = header.trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - nowMs;
  if (!Number.isSafeInteger(delay) || delay < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.max(1_000, delay);
}

/**
 * Unauthenticated GETs of JSON market data from one venue: a fixed origin and path allowlist, no credentials or
 * redirects, requests spaced apart, rate limits honored, and bounded response size. Errors carry no venue content.
 */
export class PublicJsonClient {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly paths: ReadonlySet<string>;

  constructor(private readonly options: PublicJsonClientOptions) {
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(options.origin)) throw new Error("PublicJsonClient origin must be a bare https origin");
    this.paths = new Set(options.paths);
  }

  async get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    if (!this.paths.has(path)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    const now = this.options.nowMs ?? Date.now;
    try {
      await previous;
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      while (this.nextRequestAt > now()) {
        await waitForRetry(Math.min(this.nextRequestAt - now(), MAX_TIMER_MS), { signal, sleep: this.options.sleep });
      }
      this.nextRequestAt = Math.max(now(), this.nextRequestAt) + (this.options.minIntervalMs ?? 250);
      const search = new URLSearchParams(query);
      const response = await (this.options.fetch ?? fetch)(`${this.options.origin}${path}${search.size ? `?${search}` : ""}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15_000)]),
      });
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        const delay = retryAfterMs(response.headers.get("retry-after"), now());
        this.nextRequestAt = Math.max(this.nextRequestAt, now() + delay);
        throw new ConnectorDiagnosticError("RATE_LIMITED", delay);
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.readBounded(response.body)));
    } catch (error) {
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      if (error instanceof ConnectorDiagnosticError) throw error;
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    } finally { release(); }
  }

  private async readBounded(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const limit = this.options.maxBytes ?? 4_000_000;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > limit) {
          void reader.cancel().catch(() => undefined);
          throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
        }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
}
