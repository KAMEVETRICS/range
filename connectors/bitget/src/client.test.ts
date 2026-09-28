import { afterEach, expect, it, vi } from "vitest";
import { createBitgetPublicWebSocket } from "./client.js";

// Only the socket boundary is replaced: these exercise the production transport's callbacks and iterator.
class SocketDouble {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly failOn: "subscription" | "heartbeat" | "none") {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({}); }
  message(data: string) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
  send(value: string) {
    if (this.failOn !== "none" && (value === "ping") === (this.failOn === "heartbeat")) throw new Error("sensitive-send-context");
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

function singleSocketTransport(controller: AbortController) {
  const sockets: SocketDouble[] = [];
  const transport = createBitgetPublicWebSocket(() => {
    const socket = new SocketDouble("none");
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const iterator = transport.stream([{ instType:"spot", topic:"ticker", symbol:"A" }], controller.signal)[Symbol.asyncIterator]();
  return { sockets, iterator };
}
const snapshotFrame = (topic: string, symbol: string, n: number) =>
  JSON.stringify({ action:"snapshot", arg:{ instType:"spot", topic, symbol }, data:[{ n }], ts:n });
const updateFrame = (n: number) => JSON.stringify({ action:"update", arg:{ instType:"spot", topic:"books5", symbol:"A" }, data:[{ n }], ts:n });

it("conflates full snapshots per channel so a slow consumer gets the newest state without overflowing", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const { sockets, iterator } = singleSocketTransport(controller);
  const first = iterator.next();
  const socket = sockets[0]!;
  socket.emit("open");
  socket.message(snapshotFrame("ticker", "A", 0));
  socket.message(snapshotFrame("books5", "A", 0));
  socket.message(updateFrame(1));
  socket.message(updateFrame(2));
  for (let n = 1; n <= 12_000; n++) socket.message(snapshotFrame("ticker", "A", n));
  socket.message(snapshotFrame("ticker", "B", 0));

  const delivered = [(await first).value];
  for (let index = 0; index < 4; index++) delivered.push((await iterator.next()).value);
  expect(delivered).toEqual([snapshotFrame("ticker", "A", 12_000), snapshotFrame("books5", "A", 0),
    updateFrame(1), updateFrame(2), snapshotFrame("ticker", "B", 0)]);

  const later = iterator.next();
  socket.message(snapshotFrame("ticker", "A", 12_001));
  expect((await later).value).toBe(snapshotFrame("ticker", "A", 12_001));
  controller.abort();
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});

it("still fails closed when messages that cannot be conflated exceed the queue bound", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const { sockets, iterator } = singleSocketTransport(controller);
  const outcome = iterator.next().then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  const socket = sockets[0]!;
  socket.emit("open");
  for (let n = 0; n <= 10_000; n++) socket.message(updateFrame(n));

  expect((await outcome).error).toMatchObject({ code: "ADAPTER_FAILURE" });
  expect(socket.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("caps each ticker channel to one delivery per interval, keeping its newest, while order books flow uncapped", async () => {
  vi.useFakeTimers();
  let clock = 0;
  const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };
  const controller = new AbortController();
  const sockets: SocketDouble[] = [];
  const transport = createBitgetPublicWebSocket(() => {
    const socket = new SocketDouble("none");
    sockets.push(socket);
    return socket as unknown as WebSocket;
  }, { tickerIntervalMs: 5_000, nowMs: () => clock });
  const iterator = transport.stream([{ instType:"spot", topic:"ticker", symbol:"A" }], controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  const socket = sockets[0]!;
  socket.emit("open");
  socket.message(snapshotFrame("ticker", "A", 1));
  expect((await first).value).toBe(snapshotFrame("ticker", "A", 1));

  const second = iterator.next();
  socket.message(snapshotFrame("ticker", "A", 2));
  socket.message(snapshotFrame("books5", "A", 1));
  expect((await second).value).toBe(snapshotFrame("books5", "A", 1));

  let third: unknown;
  void iterator.next().then(result => { third = result.value; });
  await advance(1_000);
  socket.message(snapshotFrame("ticker", "A", 3));
  await advance(3_999);
  expect(third).toBeUndefined();
  await advance(1);
  expect(third).toBe(snapshotFrame("ticker", "A", 3));
  controller.abort();
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});
