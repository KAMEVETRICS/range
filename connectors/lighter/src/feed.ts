import { ConnectorDiagnosticError } from "../../../packages/connector-sdk/src/index.js";
import { mapLighterStatsMessage, type LighterMarketStats } from "./mapper.js";

export const LIGHTER_STREAM_URL = "wss://mainnet.zklighter.elliot.ai/stream";
type SocketFactory = (url: string) => WebSocket;

const CONNECT_TIMEOUT_MS = 15_000;
/** The all-markets channel updates every few seconds; a socket this quiet is replaced. */
const SILENT_MS = 60_000;
const MAX_MESSAGE_BYTES = 2_000_000;

export interface LighterStatsSnapshot {
  readonly stats: ReadonlyMap<string, LighterMarketStats>;
  /** When the socket last delivered anything: every market's stats are current as of then. */
  readonly asOfMs: number;
}

/**
 * Lighter's public market_stats/all channel: one subscription carries every market's best prices and funding, where
 * REST would need a read per market against 60 requests a minute. The socket opens on first use and is replaced when
 * it closes or falls silent; readers get the latest stats per market.
 */
export class LighterMarketStatsFeed {
  private readonly stats = new Map<string, LighterMarketStats>();
  private socket: WebSocket | undefined;
  private subscribed: Promise<void> | undefined;
  private lastMessageAtMs = 0;

  constructor(private readonly makeSocket: SocketFactory = url => new WebSocket(url), private readonly nowMs: () => number = Date.now) {}

  async latest(signal: AbortSignal): Promise<LighterStatsSnapshot> {
    if (this.socket && this.nowMs() - this.lastMessageAtMs > SILENT_MS) this.close();
    this.subscribed ??= this.connect();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new ConnectorDiagnosticError("ABORTED"));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      this.subscribed!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    return { stats: this.stats, asOfMs: this.lastMessageAtMs };
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.subscribed = undefined;
    try { socket?.close(); } catch { /* already closed */ }
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.makeSocket(LIGHTER_STREAM_URL);
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => fail(), CONNECT_TIMEOUT_MS);
      const fail = () => {
        clearTimeout(timer);
        if (this.socket === socket) this.close();
        if (!settled) { settled = true; reject(new ConnectorDiagnosticError("ADAPTER_FAILURE")); }
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all" }));
      });
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_BYTES) { fail(); return; }
        let message: unknown;
        try { message = JSON.parse(event.data); } catch { fail(); return; }
        this.lastMessageAtMs = this.nowMs();
        if ((message as { type?: unknown } | null)?.type === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
        // Snapshots and updates carry each changed market's full stats, so a row replaces the market's last one.
        for (const row of mapLighterStatsMessage(message)) this.stats.set(row.symbol, row);
        if (!settled && (message as { type?: unknown }).type === "subscribed/market_stats") {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
    });
  }
}
