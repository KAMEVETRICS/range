import { ConnectorDiagnosticError, waitForRetry } from "../../../packages/connector-sdk/src/index.js";

export const ONDO_PERPS_API_ORIGIN = "https://api.ondoperps.xyz";
export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;

export class OndoPerpsCredentialRequiredError extends Error {
  constructor() {
    super("Ondo Perps public market data requires credentials");
    this.name = "OndoPerpsCredentialRequiredError";
  }
}

export interface OndoPerpsHttpPort {
  markets(signal: AbortSignal): Promise<unknown>;
  contracts(signal: AbortSignal): Promise<unknown>;
  fundingRates(market: string, signal: AbortSignal): Promise<unknown>;
  fundingHistory(market: string, signal: AbortSignal): Promise<unknown>;
  openInterest(signal: AbortSignal): Promise<unknown>;
  depth(market: string, signal: AbortSignal): Promise<unknown>;
}

interface Timing {
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MARKET = /^[A-Za-z0-9]+-USD\.P$/;
const allowedPaths = new Set([
  "/v1/markets", "/v1/perps/contracts", "/v1/perps/funding_rates",
  "/v1/perps/funding_rate_history", "/v1/perps/open_interest", "/v1/perps/depth",
]);

function retryAfterMs(header: string | null, nowMs: number): number {
  if (header === null) return 10_000;
  const value = header.trim();
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - nowMs;
  if (Number.isNaN(delay)) return 10_000;
  if (!Number.isFinite(delay)) return 60_000;
  return Math.max(1_000, Math.min(60_000, Math.ceil(delay)));
}

/** Fixed-host, unauthenticated, documented GET endpoints only. */
export class OndoPerpsPublicClient implements OndoPerpsHttpPort {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly request: PublicFetch = fetch, private readonly timing: Timing = {}) {}

  private async get(path: string, query: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    if (!allowedPaths.has(path)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      const now = this.timing.nowMs ?? Date.now;
      // At most two requests per second per client, including discovery and research reads.
      await waitForRetry(Math.max(0, this.nextRequestAt - now()), { signal, sleep: this.timing.sleep });
      this.nextRequestAt = Math.max(now(), this.nextRequestAt) + 500;
      const url = `${ONDO_PERPS_API_ORIGIN}${path}${query.size ? `?${query}` : ""}`;
      const response = await this.request(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => undefined);
        throw new OndoPerpsCredentialRequiredError();
      }
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        const delay = retryAfterMs(response.headers.get("retry-after"), now());
        this.nextRequestAt = Math.max(this.nextRequestAt, now() + delay);
        throw new ConnectorDiagnosticError("RATE_LIMITED", delay);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > 2_000_000) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      if (!response.body) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 2_000_000) {
            void reader.cancel().catch(() => undefined);
            throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
          }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (error) {
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      if (error instanceof OndoPerpsCredentialRequiredError || error instanceof ConnectorDiagnosticError) throw error;
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    } finally { release(); }
  }

  markets(signal: AbortSignal): Promise<unknown> { return this.get("/v1/markets", new URLSearchParams(), signal); }
  contracts(signal: AbortSignal): Promise<unknown> { return this.get("/v1/perps/contracts", new URLSearchParams(), signal); }
  openInterest(signal: AbortSignal): Promise<unknown> { return this.get("/v1/perps/open_interest", new URLSearchParams(), signal); }
  fundingRates(market: string, signal: AbortSignal): Promise<unknown> {
    return this.get("/v1/perps/funding_rates", this.marketQuery(market), signal);
  }
  fundingHistory(market: string, signal: AbortSignal): Promise<unknown> {
    const query = this.marketQuery(market);
    query.set("limit", "3");
    return this.get("/v1/perps/funding_rate_history", query, signal);
  }
  depth(market: string, signal: AbortSignal): Promise<unknown> {
    const query = this.marketQuery(market);
    query.set("depth", "10");
    return this.get("/v1/perps/depth", query, signal);
  }
  private marketQuery(market: string): URLSearchParams {
    if (!MARKET.test(market)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    return new URLSearchParams({ market });
  }
}
