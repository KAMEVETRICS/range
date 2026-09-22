import { ConnectorDiagnosticError, waitForRetry } from "@range/connector-sdk";
import { parseBitgetJson, type BitgetCategory } from "./mapper.js";

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;
export type MarketEndpoint = "instruments" | "tickers" | "orderbook";
interface ClientTiming { nowMs?: () => number; sleep?: (ms: number) => Promise<void> }

/** Only these public paths are constructible; there is no credential or arbitrary-header input. */
export class BitgetPublicClient {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  constructor(private readonly request: PublicFetch = fetch, private readonly timing: ClientTiming = {}) {}

  async market(endpoint: MarketEndpoint, category: BitgetCategory, signal: AbortSignal, symbol?: string): Promise<unknown> {
    if (!["instruments", "tickers", "orderbook"].includes(endpoint)) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      const now = this.timing.nowMs ?? Date.now;
      await waitForRetry(Math.max(0, this.nextRequestAt - now()), {signal, sleep:this.timing.sleep});
      this.nextRequestAt = Math.max(now(), this.nextRequestAt) + 50; // Aggregate <=20/sec/IP across our public endpoints.
      const url = new URL(`https://api.bitget.com/api/v3/market/${endpoint}`);
      url.searchParams.set("category", category);
      if (symbol) url.searchParams.set("symbol", symbol);
      if (endpoint === "orderbook") url.searchParams.set("limit", "5");
      const result = await this.request(url.toString(), {
        method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error", credentials: "omit",
      });
      const after = result.headers.get("retry-after");
      const retryMs = after === null ? 1_000 : /^\d+(?:\.\d+)?$/.test(after) ? Math.ceil(Number(after) * 1_000) : Math.max(0, Date.parse(after) - now());
      const delay = Number.isFinite(retryMs) ? retryMs : 1_000;
      if (result.headers.get("x-mbx-used-remain-limit") === "0" || result.status === 429) this.nextRequestAt = Math.max(this.nextRequestAt, now() + delay);
      if (result.status === 429) throw new ConnectorDiagnosticError("RATE_LIMITED", delay);
      if (!result.ok) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      const body = parseBitgetJson(await result.text());
      if (!body || typeof body !== "object" || (body as {code?:unknown}).code !== "00000") throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      return body;
    } catch (error) {
      if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
      if (error instanceof ConnectorDiagnosticError) throw error;
      throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
    } finally { release(); }
  }
}

export interface BitgetSubscription { instType: string; topic: "ticker" | "books5"; symbol: string }
export interface BitgetWebSocketPort { stream(subscriptions: readonly BitgetSubscription[], signal: AbortSignal): AsyncIterable<unknown> }
type SocketFactory = (url: string) => WebSocket;

/** Full books5 snapshots avoid incremental-book reconstruction and resync ambiguity. */
export function createBitgetPublicWebSocket(makeSocket: SocketFactory = url => new WebSocket(url)): BitgetWebSocketPort {
  return {
    async *stream(subscriptions, signal) {
      if (signal.aborted || !subscriptions.length) return;
      if (subscriptions.length > 3_960) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      const queue: unknown[] = [];
      const cleanups: (() => void)[] = [];
      let wake: (() => void) | undefined;
      let failure: ConnectorDiagnosticError | undefined;
      let stopped = false;
      const stop = (failed: boolean) => {
        if (failed) failure = new ConnectorDiagnosticError("ADAPTER_FAILURE");
        stopped = true;
        wake?.();
      };
      const onAbort = () => stop(false);
      signal.addEventListener("abort", onAbort, {once:true});
      try {
        // <=40 subscriptions/socket, below the recommended 50 and hard 1000 channel cap.
        for (let start = 0; start < subscriptions.length; start += 40) {
          const socket = makeSocket("wss://ws.bitget.com/v3/ws/public");
          const args = subscriptions.slice(start, start + 40);
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          let awaitingPong = false;
          const timeout = setTimeout(() => stop(true), 15_000);
          const onOpen = () => {
            clearTimeout(timeout);
            try { socket.send(JSON.stringify({ op:"subscribe", args })); }
            catch { stop(true); return; }
            heartbeat = setInterval(() => {
              if (awaitingPong) { stop(true); return; }
              awaitingPong = true;
              try { socket.send("ping"); }
              catch { stop(true); }
            }, 30_000);
          };
          const onMessage = (message: MessageEvent) => {
            if (message.data === "pong") { awaitingPong = false; return; }
            if (typeof message.data !== "string" || queue.length >= 10_000) { stop(true); return; }
            queue.push(message.data);
            wake?.();
          };
          const onFailure = () => stop(true);
          socket.addEventListener("open", onOpen);
          socket.addEventListener("message", onMessage);
          socket.addEventListener("error", onFailure);
          socket.addEventListener("close", onFailure);
          cleanups.push(() => {
            clearTimeout(timeout); clearInterval(heartbeat);
            socket.removeEventListener("open", onOpen); socket.removeEventListener("message", onMessage);
            socket.removeEventListener("error", onFailure); socket.removeEventListener("close", onFailure);
            socket.close();
          });
        }
        while (!stopped) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise<void>(resolve => { wake = resolve; });
        }
        if (failure && !signal.aborted) throw failure;
      } catch (error) {
        if (!signal.aborted) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      } finally {
        signal.removeEventListener("abort", onAbort);
        for (const cleanup of cleanups) cleanup();
      }
    },
  };
}
