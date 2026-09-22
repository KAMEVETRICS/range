import { ConnectorDiagnosticError, waitForRetry } from "@range/connector-sdk";

export const EXTENDED_API_ORIGIN = "https://api.starknet.extended.exchange";
export const EXTENDED_STREAM_ORIGIN = "wss://api.starknet.extended.exchange";

export type ReadonlyFetch = (url: string, init: RequestInit) => Promise<Response>;

interface ClientTiming {
  readonly nowMs?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly userAgent?: string;
  readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_MESSAGE_BYTES = 256_000;

type CancellableBody = { cancel(reason?: unknown): Promise<unknown> };

/** Starts cleanup without awaiting provider-controlled streams or retaining their failure details. */
function cancelBodySafely(body: CancellableBody | null | undefined): void {
  if (!body) return;
  try { void body.cancel().catch(() => undefined); }
  catch { /* Static outward diagnostics deliberately discard cancellation details. */ }
}

export class ExtendedCredentialError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super("Extended read-only credential rejected");
    this.name = "ExtendedCredentialError";
    this.status = status;
  }
}

export interface ExtendedHttpPort {
  markets(apiKey: string, signal: AbortSignal): Promise<unknown>;
  orderBook(market: string, apiKey: string, signal: AbortSignal): Promise<unknown>;
}

function validatedApiKey(apiKey: string): string {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("EXTENDED_API_KEY is required for the Extended read-only connector");
  }
  return apiKey.trim();
}

function retryDelay(response: Response, nowMs: number): number {
  const header = response.headers.get("retry-after");
  if (header === null) return 1_000;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Math.ceil(Number(header) * 1_000);
  const delay = Date.parse(header) - nowMs;
  return Number.isFinite(delay) && delay >= 0 ? delay : 1_000;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      cancelBodySafely(response.body);
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    }
  }
  if (!response.body) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        cancelBodySafely(reader);
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ConnectorDiagnosticError) throw error;
    cancelBodySafely(reader);
    throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new ConnectorDiagnosticError("ADAPTER_FAILURE"); }
}

/** Fixed-host, GET-only client. No account, order, transfer, or withdrawal method exists. */
export class ExtendedReadonlyClient implements ExtendedHttpPort {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly request: ReadonlyFetch = fetch,
    private readonly timing: ClientTiming = {},
  ) {}

  private async get(path: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
    const credential = validatedApiKey(apiKey);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      const now = this.timing.nowMs ?? Date.now;
      await waitForRetry(Math.max(0, this.nextRequestAt - now()), { signal, sleep: this.timing.sleep });
      // Default tier is 1,000 requests/minute/IP. One request every 60ms is conservative.
      this.nextRequestAt = Math.max(now(), this.nextRequestAt) + 60;
      const url = new URL(path, `${EXTENDED_API_ORIGIN}/`);
      if (url.origin !== EXTENDED_API_ORIGIN || !url.pathname.startsWith("/api/v1/info/")) {
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      const response = await this.request(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": this.timing.userAgent ?? "range-market-intelligence/0.1",
          "X-Api-Key": credential,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
        credentials: "omit",
      });
      if (response.status === 401 || response.status === 403) {
        cancelBodySafely(response.body);
        throw new ExtendedCredentialError(response.status);
      }
      if (response.status === 429) {
        const retryAfterMs = retryDelay(response, now());
        this.nextRequestAt = Math.max(this.nextRequestAt, now() + retryAfterMs);
        cancelBodySafely(response.body);
        throw new ConnectorDiagnosticError("RATE_LIMITED", retryAfterMs);
      }
      if (!response.ok) {
        cancelBodySafely(response.body);
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      const parsed = JSON.parse(await readBoundedBody(
        response,
        this.timing.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      )) as unknown;
      if (!parsed || typeof parsed !== "object" || (parsed as { status?: unknown }).status !== "OK") {
        throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      }
      return parsed;
    } catch (error) {
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      if (error instanceof ConnectorDiagnosticError || error instanceof ExtendedCredentialError) throw error;
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    } finally {
      release();
    }
  }

  markets(apiKey: string, signal: AbortSignal): Promise<unknown> {
    return this.get("/api/v1/info/markets", apiKey, signal);
  }

  orderBook(market: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
    if (!/^[A-Za-z0-9_.:-]+$/.test(market)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    return this.get(`/api/v1/info/markets/${encodeURIComponent(market)}/orderbook`, apiKey, signal);
  }
}

export interface ExtendedStreamRequest {
  readonly market: string;
  readonly book: "standard" | "rfq_real";
}

export interface ExtendedWebSocketPort {
  stream(requests: readonly ExtendedStreamRequest[], signal: AbortSignal): AsyncIterable<unknown>;
}

type SocketFactory = (url: string) => WebSocket;

interface ExtendedWebSocketOptions {
  readonly maxMessageBytes?: number;
}

function boundedSocketText(data: unknown, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  }
  if (typeof data === "string") {
    if (data.length > maximumBytes) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    const encoded = new TextEncoder().encode(data);
    if (encoded.byteLength > maximumBytes) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    return data;
  }
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : undefined;
  if (!bytes || bytes.byteLength > maximumBytes) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ConnectorDiagnosticError("ADAPTER_FAILURE"); }
}

/** Public market-data sockets only. Browsers provide their User-Agent during the handshake. */
export function createExtendedPublicWebSocket(
  makeSocket: SocketFactory = url => new WebSocket(url),
  options: ExtendedWebSocketOptions = {},
): ExtendedWebSocketPort {
  return {
    async *stream(requests, signal) {
      const unique = [...new Map(requests.map(request => [`${request.book}:${request.market}`, request])).values()];
      if (signal.aborted || unique.length === 0) return;
      if (unique.length > 100) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      let stopped = false;
      let failure = false;
      const sockets: WebSocket[] = [];
      const cleanups: (() => void)[] = [];
      const stop = (failed: boolean) => {
        failure ||= failed;
        stopped = true;
        wake?.();
      };
      const onAbort = () => stop(false);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (const request of unique) {
          if (!/^[A-Za-z0-9_.:-]+$/.test(request.market)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
          const route = request.book === "rfq_real" ? "orderbooks/rfq" : "orderbooks";
          const url = `${EXTENDED_STREAM_ORIGIN}/stream.extended.exchange/v1/${route}/${encodeURIComponent(request.market)}`;
          const socket = makeSocket(url);
          sockets.push(socket);
          const timeout = setTimeout(() => stop(true), 15_000);
          const onOpen = () => clearTimeout(timeout);
          const onMessage = (message: MessageEvent) => {
            if (queue.length >= 10_000) {
              stop(true);
              return;
            }
            try {
              const text = boundedSocketText(
                message.data,
                options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
              );
              queue.push(JSON.parse(text));
            }
            catch { stop(true); return; }
            wake?.();
          };
          const onFailure = () => stop(true);
          socket.addEventListener("open", onOpen);
          socket.addEventListener("message", onMessage);
          socket.addEventListener("error", onFailure);
          socket.addEventListener("close", onFailure);
          cleanups.push(() => {
            clearTimeout(timeout);
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("error", onFailure);
            socket.removeEventListener("close", onFailure);
            socket.close();
          });
        }
        while (!stopped) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
        if (failure && !signal.aborted) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      } finally {
        signal.removeEventListener("abort", onAbort);
        for (const cleanup of cleanups) cleanup();
      }
    },
  };
}
