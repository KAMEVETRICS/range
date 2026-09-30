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

/** Channel identity of a full books5/ticker snapshot; any other message is never conflated. */
function snapshotChannel(data: string): string | undefined {
  try {
    const frame = JSON.parse(data) as { action?: unknown; arg?: { instType?: unknown; topic?: unknown; symbol?: unknown } };
    const arg = frame.arg;
    if (frame.action !== "snapshot" || typeof arg?.instType !== "string" || typeof arg.topic !== "string"
      || typeof arg.symbol !== "string") return undefined;
    return `${arg.instType}:${arg.topic}:${arg.symbol}`;
  } catch { return undefined; }
}

/** Full books5 snapshots avoid incremental-book reconstruction and resync ambiguity. */
export function createBitgetPublicWebSocket(makeSocket: SocketFactory = url => new WebSocket(url),
  options: { tickerIntervalMs?: number; bookIntervalMs?: number; fastBookSymbols?: ReadonlySet<string>; fastBookIntervalMs?: number;
    nowMs?: () => number } = {}): BitgetWebSocketPort {
  const intervals: Record<string, number> = { ticker: options.tickerIntervalMs ?? 0, books5: options.bookIntervalMs ?? 0 };
  const nowMs = options.nowMs ?? Date.now;
  // Executable books must stay inside the evaluator's 2 s quote budget, so their symbols refresh faster.
  const intervalOf = (channel: string) => {
    const [, topic = "", symbol = ""] = channel.split(":");
    if (topic === "books5" && options.fastBookSymbols?.has(symbol)) return options.fastBookIntervalMs ?? 0;
    return intervals[topic] ?? 0;
  };
  return {
    async *stream(subscriptions, signal) {
      if (signal.aborted || !subscriptions.length) return;
      if (subscriptions.length > 3_960) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      // Full snapshots supersede their predecessors, so a slow consumer receives each channel's newest state.
      // A refreshed channel keeps its queue position, so busy channels cannot starve quiet ones. Ticker and books5
      // channels are also delivered at most once per tickerIntervalMs / bookIntervalMs (uncapped when 0).
      const pending = new Map<string, string>();
      const deliveredAt = new Map<string, number>();
      let dueTimer: ReturnType<typeof setTimeout> | undefined;
      let unconflated = 0;
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
            if (typeof message.data !== "string") { stop(true); return; }
            const key = snapshotChannel(message.data) ?? `unconflated:${unconflated++}`;
            if (!pending.has(key) && pending.size >= 10_000) { stop(true); return; }
            pending.set(key, message.data);
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
          const now = nowMs();
          let next: [string, string] | undefined;
          let nextDueAt = Number.POSITIVE_INFINITY;
          for (const entry of pending) {
            const dueAt = (deliveredAt.get(entry[0]) ?? Number.NEGATIVE_INFINITY) + intervalOf(entry[0]);
            if (dueAt <= now) { next = entry; break; }
            nextDueAt = Math.min(nextDueAt, dueAt);
          }
          if (next) {
            pending.delete(next[0]);
            if (intervalOf(next[0]) > 0) deliveredAt.set(next[0], now);
            yield next[1];
            continue;
          }
          await new Promise<void>(resolve => {
            wake = resolve;
            if (Number.isFinite(nextDueAt)) dueTimer = setTimeout(resolve, nextDueAt - now);
          });
          clearTimeout(dueTimer);
        }
        if (failure && !signal.aborted) throw failure;
      } catch (error) {
        if (!signal.aborted) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
      } finally {
        clearTimeout(dueTimer);
        signal.removeEventListener("abort", onAbort);
        for (const cleanup of cleanups) cleanup();
      }
    },
  };
}
