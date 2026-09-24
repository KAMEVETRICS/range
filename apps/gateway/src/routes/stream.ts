import type { EventPageItem, RangeApplication, RequestContext } from "@range/application";

export interface StreamSink {
  write(chunk: string): boolean;
  end(): unknown;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}
export interface StreamOptions {
  afterOrdinal: number; maxQueue: number; maxClients: number; pollMs: number; heartbeatMs: number; maxFrameBytes: number;
  underlying?: string; expiresAtMs?: number; now?: () => number; onClose?: () => void;
}
/** The durable event-log tail is the subscription source. Its commit-ordered
 * cursor survives gateway restart; queue entries retain references, not rendered
 * actionable payloads, and are revalidated against storage at send time. */
export class StreamSession {
  private readonly queue: EventPageItem[] = [];
  private cursor: number;
  private closed = false;
  private blocked = false;
  private reading = false;
  private draining = false;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly options: StreamOptions;
  private readonly onDrain = () => { this.blocked = false; void this.drain(); };
  private readonly onClose = () => this.close();
  constructor(private readonly application: RangeApplication, private readonly context: RequestContext, private readonly sink: StreamSink,
    options: Partial<StreamOptions> & Pick<StreamOptions, "afterOrdinal">) {
    this.options = { maxQueue: 32, maxClients: 100, pollMs: 1000, heartbeatMs: 15_000, maxFrameBytes: 262_144, ...options };
    for (const value of [this.options.maxQueue, this.options.pollMs, this.options.heartbeatMs, this.options.maxFrameBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid stream bound");
    }
    if (this.options.maxQueue > 1000 || this.options.maxFrameBytes > 1_048_576) throw new Error("Invalid stream bound");
    this.cursor = options.afterOrdinal;
    this.sink.on("drain", this.onDrain); this.sink.on("close", this.onClose); this.sink.on("error", this.onClose);
  }
  start() {
    if (this.closed || this.timer) return;
    this.heartbeat();
    this.timer = setInterval(() => { void this.poll(); }, this.options.pollMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.options.heartbeatMs);
    this.timer.unref(); this.heartbeatTimer.unref();
    void this.poll();
  }
  private expired() {
    return this.options.expiresAtMs !== undefined && (this.options.now ?? Date.now)() >= this.options.expiresAtMs;
  }
  heartbeat() {
    if (this.expired()) return this.close();
    if (!this.closed && !this.blocked) {
      try { this.blocked = !this.sink.write(": heartbeat\n\n"); } catch { this.close(); }
    }
  }
  async poll() {
    if (this.expired()) return this.close();
    if (this.closed || this.reading || this.draining) return;
    this.reading = true;
    try {
      // Drain replay in bounded pages. A full page is backlog, not transport
      // backpressure; only a blocked sink may exhaust the pending queue.
      for (let page = 0; page < 4 && !this.closed; page++) {
        const room = this.options.maxQueue - this.queue.length;
        const limit = room + (this.blocked ? 1 : 0);
        if (limit < 1) return;
        const events = await this.application.queries.readEvents(this.context, this.cursor, limit);
        if (this.closed) return;
        for (const item of events) {
          if (!Number.isSafeInteger(item.ordinal) || item.ordinal <= this.cursor) throw new Error("Invalid durable cursor order");
          this.cursor = item.ordinal;
          if (item.event.topic !== "opportunity.v1" && item.event.topic !== "venue.health.v1") continue;
          // Health is global and must reach subscriptions filtered by underlying.
          if (this.options.underlying && item.event.topic === "opportunity.v1" && item.event.underlyingId !== this.options.underlying) continue;
          if (this.queue.length >= this.options.maxQueue) return this.close();
          this.queue.push(item);
        }
        if (!this.blocked) await this.drain();
        if (this.blocked || events.length < limit) return;
      }
    } catch { this.close(); }
    finally { this.reading = false; }
  }
  async drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    // A drain signal means the transport has room again. Public for transports
    // whose writable notification is supplied by their own event loop.
    this.blocked = false;
    try {
      while (this.queue.length && !this.closed && !this.blocked) {
        if (this.expired()) return this.close();
        const item = this.queue.shift()!;
        const delivery = await this.application.streamEvent(item, this.context);
        if (!delivery || this.closed) continue;
        const frame = `id: evt_${item.ordinal}\nevent: ${delivery.event}\ndata: ${JSON.stringify(delivery.body)}\n\n`;
        if (Buffer.byteLength(frame) > this.options.maxFrameBytes) return this.close();
        this.blocked = !this.sink.write(frame);
      }
    } catch { this.close(); }
    finally { this.draining = false; }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer); clearInterval(this.heartbeatTimer); this.queue.length = 0;
    this.sink.off("drain", this.onDrain); this.sink.off("close", this.onClose); this.sink.off("error", this.onClose);
    this.sink.end(); this.options.onClose?.();
  }
}
