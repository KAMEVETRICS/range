import { ConnectorDiagnosticError } from "../../../packages/connector-sdk/src/index.js";
import { mapQfexBbo, mapQfexFunding, type QfexBbo, type QfexFunding } from "./mapper.js";

export const QFEX_MARKET_DATA_URL = "wss://mds.qfex.com/";
type SocketFactory = (url: string) => WebSocket;

const CONNECT_TIMEOUT_MS = 15_000;
/** Best prices for every market stream continuously; a socket this quiet is replaced. */
const SILENT_MS = 60_000;
const MAX_MESSAGE_BYTES = 1_000_000;

export interface QfexMarketState {
  readonly bbo: ReadonlyMap<string, QfexBbo>;
  readonly funding: ReadonlyMap<string, QfexFunding>;
  /** When the socket last delivered anything: every market's best prices are current as of then. */
  readonly asOfMs: number;
}

/**
 * QFEX's public market-data socket (no key needed): one subscription to the bbo and funding channels for every market
 * ("*"). The socket opens on first use and is replaced when it closes or falls silent; readers get the latest state.
 */
export class QfexMarketDataFeed {
  private readonly bbo = new Map<string, QfexBbo>();
  private readonly funding = new Map<string, QfexFunding>();
  private socket: WebSocket | undefined;
  private subscribed: Promise<void> | undefined;
  private lastMessageAtMs = 0;

  constructor(private readonly makeSocket: SocketFactory = url => new WebSocket(url), private readonly nowMs: () => number = Date.now) {}

  async latest(signal: AbortSignal): Promise<QfexMarketState> {
    if (this.socket && this.nowMs() - this.lastMessageAtMs > SILENT_MS) this.close();
    this.subscribed ??= this.connect();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new ConnectorDiagnosticError("ABORTED"));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      this.subscribed!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    return { bbo: this.bbo, funding: this.funding, asOfMs: this.lastMessageAtMs };
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.subscribed = undefined;
    try { socket?.close(); } catch { /* already closed */ }
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.makeSocket(QFEX_MARKET_DATA_URL);
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => fail(), CONNECT_TIMEOUT_MS);
      const fail = () => {
        clearTimeout(timer);
        if (this.socket === socket) this.close();
        if (!settled) { settled = true; reject(new ConnectorDiagnosticError("ADAPTER_FAILURE")); }
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", channels: ["bbo", "funding"], symbols: ["*"] }));
      });
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_BYTES) { fail(); return; }
        let message: unknown;
        try { message = JSON.parse(event.data); } catch { fail(); return; }
        this.lastMessageAtMs = this.nowMs();
        const bbo = mapQfexBbo(message);
        if (bbo) this.bbo.set(bbo.symbol, bbo);
        const funding = mapQfexFunding(message);
        if (funding) this.funding.set(funding.symbol, funding);
        if (!settled && (message as { type?: unknown } | null)?.type === "subscribed") {
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
