import { afterEach, expect, it, vi } from "vitest";
import { createBitgetPublicWebSocket } from "./client.js";

// Only the socket boundary is replaced: these exercise the production transport's callbacks and iterator.
class SocketDouble {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly failOn: "subscription" | "heartbeat") {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({}); }
  send(value: string) {
    if ((value === "ping") === (this.failOn === "heartbeat")) throw new Error("sensitive-send-context");
    this.sent.push(value);
  }
  close() { this.closed = true; }
}

afterEach(() => vi.useRealTimers());

for (const failOn of ["subscription", "heartbeat"] as const) {
  it(`turns ${failOn} send exceptions into sanitized stream failure and cleans every socket`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const sockets: SocketDouble[] = [];
    const transport = createBitgetPublicWebSocket(url => {
      expect(url).toBe("wss://ws.bitget.com/v3/ws/public");
      const socket = new SocketDouble(failOn);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const subscriptions = Array.from({length:41}, (_, index) => ({ instType:"usdt-futures", topic:"ticker" as const, symbol:`TEST${index}` }));
    const iterator = transport.stream(subscriptions, controller.signal)[Symbol.asyncIterator]();
    const outcome = iterator.next().then(value => ({value, error:undefined}), (error:unknown) => ({value:undefined, error}));
    try {
      expect(sockets).toHaveLength(2);
      expect(() => sockets[0]!.emit("open")).not.toThrow();
      if (failOn === "heartbeat") {
        sockets[1]!.emit("open");
        expect(sockets[0]!.sent[0]).toContain('"op":"subscribe"');
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const result = await outcome;
      expect(result.error).toMatchObject({code:"ADAPTER_FAILURE",message:"Connector adapter operation failed"});
      expect(String(result.error)).not.toContain("sensitive-send-context");
      expect(sockets.every(socket => socket.closed)).toBe(true);
      expect(sockets.every(socket => [...socket.listeners.values()].every(listeners => listeners.size === 0))).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      controller.abort();
      await outcome;
    }
  });
}
