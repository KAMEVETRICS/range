import { ConnectorDiagnosticError, waitForRetry } from "@range/connector-sdk";

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;
interface ClientTiming { readonly nowMs?: () => number; readonly sleep?: (ms: number) => Promise<void> }

export type HyperliquidInfoRequest =
  | { readonly type: "perpDexs" }
  | { readonly type: "perpCategories" }
  | { readonly type: "metaAndAssetCtxs"; readonly dex: string }
  | { readonly type: "l2Book"; readonly coin: string }
  | { readonly type: "fundingHistory"; readonly coin: string; readonly startTime: number; readonly endTime?: number };

const requestTypes = new Set<HyperliquidInfoRequest["type"]>([
  "perpDexs",
  "perpCategories",
  "metaAndAssetCtxs",
  "l2Book",
  "fundingHistory",
]);

function requestWeight(request: HyperliquidInfoRequest): number {
  if (request.type === "l2Book") return 2;
  // fundingHistory returns at most 500 rows and incurs additional weight per
  // 20 returned rows. Reserve the full documented response-size allowance so
  // a following request cannot outrun the aggregate IP budget.
  if (request.type === "fundingHistory") return 20 + Math.ceil(500 / 20);
  return 20;
}

/** Public `/info` only: callers cannot supply credentials, arbitrary headers, or exchange actions. */
export class HyperliquidPublicClient {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly request: PublicFetch = fetch,
    private readonly timing: ClientTiming = {},
  ) {}

  private async info(body: HyperliquidInfoRequest, signal: AbortSignal): Promise<unknown> {
    if (!requestTypes.has(body.type)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      const now = this.timing.nowMs ?? Date.now;
      await waitForRetry(Math.max(0, this.nextRequestAt - now()), { signal, sleep: this.timing.sleep });
      // Hyperliquid permits 1200 REST weight/minute. One weight-unit every
      // 50ms is a conservative shared-client leaky bucket.
      this.nextRequestAt = Math.max(now(), this.nextRequestAt) + requestWeight(body) * 50;
      const response = await this.request("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
        credentials: "omit",
      });
      const retryAfter = response.headers.get("retry-after");
      const parsedRetryMs = retryAfter === null
        ? 10_000
        : /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Math.ceil(Number(retryAfter) * 1_000)
          : Math.max(0, Date.parse(retryAfter) - now());
      const retryAfterMs = Number.isFinite(parsedRetryMs) ? parsedRetryMs : 10_000;
      if (response.status === 429) {
        this.nextRequestAt = Math.max(this.nextRequestAt, now() + retryAfterMs);
        throw new ConnectorDiagnosticError("RATE_LIMITED", retryAfterMs);
      }
      if (!response.ok) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      return JSON.parse(await response.text());
    } catch (error) {
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      if (error instanceof ConnectorDiagnosticError) throw error;
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    } finally {
      release();
    }
  }

  perpDexs(signal: AbortSignal): Promise<unknown> {
    return this.info({ type: "perpDexs" }, signal);
  }

  perpCategories(signal: AbortSignal): Promise<unknown> {
    return this.info({ type: "perpCategories" }, signal);
  }

  metaAndAssetCtxs(dex: string, signal: AbortSignal): Promise<unknown> {
    return this.info({ type: "metaAndAssetCtxs", dex }, signal);
  }

  l2Book(coin: string, signal: AbortSignal): Promise<unknown> {
    return this.info({ type: "l2Book", coin }, signal);
  }

  fundingHistory(coin: string, startTime: number, signal: AbortSignal, endTime?: number): Promise<unknown> {
    return this.info({ type: "fundingHistory", coin, startTime, ...(endTime === undefined ? {} : { endTime }) }, signal);
  }
}

export interface HyperliquidWebSocketPort {
  /** `fastCoins` subscribe with `fast: true`: a book about every 0.5 s instead of every 5 s on HIP-3 dexes. */
  stream(coins: readonly string[], signal: AbortSignal, fastCoins?: ReadonlySet<string>): AsyncIterable<unknown>;
}

type SocketFactory = (url: string) => WebSocket;

/** Public l2Book subscriptions only; this surface cannot submit post/action messages. */
export function createHyperliquidPublicWebSocket(
  makeSocket: SocketFactory = url => new WebSocket(url),
): HyperliquidWebSocketPort {
  return {
    async *stream(requestedCoins, signal, fastCoins: ReadonlySet<string> = new Set<string>()) {
      const coins = [...new Set(requestedCoins)];
      if (signal.aborted || coins.length === 0) return;
      if (coins.length > 1_000) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      const socket = makeSocket("wss://api.hyperliquid.xyz/ws");
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      let stopped = false;
      let failure = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stop = (failed: boolean) => {
        failure ||= failed;
        stopped = true;
        wake?.();
      };
      const timeout = setTimeout(() => stop(true), 15_000);
      const onAbort = () => stop(false);
      const onOpen = () => {
        clearTimeout(timeout);
        try {
          for (const coin of coins) {
            const subscription = fastCoins.has(coin) ? { type: "l2Book", coin, fast: true } : { type: "l2Book", coin };
            socket.send(JSON.stringify({ method: "subscribe", subscription }));
          }
          heartbeat = setInterval(() => {
            try { socket.send(JSON.stringify({ method: "ping" })); }
            catch { stop(true); }
          }, 30_000);
        } catch {
          stop(true);
        }
      };
      const onMessage = (message: MessageEvent) => {
        if (typeof message.data !== "string" || queue.length >= 10_000) {
          stop(true);
          return;
        }
        try { queue.push(JSON.parse(message.data)); }
        catch { stop(true); return; }
        wake?.();
      };
      const onFailure = () => stop(true);
      signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
      try {
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
        clearTimeout(timeout);
        clearInterval(heartbeat);
        signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
        socket.close();
      }
    },
  };
}
