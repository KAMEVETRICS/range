import { expect, it } from "vitest";
import { createHyperliquidPublicWebSocket } from "./client.js";

class FakeSocket extends EventTarget {
  readonly sent: unknown[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { /* nothing to release */ }
}

it("subscribes fast books only for the coins asked to be fast", async () => {
  const socket = new FakeSocket();
  const port = createHyperliquidPublicWebSocket(() => socket as unknown as WebSocket);
  const controller = new AbortController();
  const stream = port.stream(["xyz:NVDA", "xyz:SNDK"], controller.signal, new Set(["xyz:NVDA"]))[Symbol.asyncIterator]();
  const first = stream.next();
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ channel: "pong" }) }));
  expect(await first).toEqual({ done: false, value: { channel: "pong" } });
  expect(socket.sent).toEqual([
    { method: "subscribe", subscription: { type: "l2Book", coin: "xyz:NVDA", fast: true } },
    { method: "subscribe", subscription: { type: "l2Book", coin: "xyz:SNDK" } },
  ]);
  controller.abort();
  await stream.return?.(undefined);
});
