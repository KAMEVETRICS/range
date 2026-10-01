import { afterEach, expect, it, vi } from "vitest";
import { InstrumentSchema } from "@range/domain";
import { InMemoryEventBus } from "@range/event-bus";
import { watchOtherVenueTickers } from "./universe.js";

afterEach(() => vi.useRealTimers());

const instrument = (venue: string, venueSymbol: string, underlyingId: string) => InstrumentSchema.parse({
  instrumentId: `ins_${venue}_${venueSymbol}`, underlyingId, venue, venueSymbol, productType: "perpetual",
  quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD", contractMultiplier: "1", tickSize: "0.01", lotSize: "1",
  minimumNotional: "0", fundingInterval: 28_800_000,
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["orderbook"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
});

it("learns the equity tickers other venues list by replaying the registry, then follows new listings", async () => {
  vi.useFakeTimers();
  const bus = new InMemoryEventBus();
  const list = (venue: string, symbol: string, underlyingId: string) => bus.publish("instrument.registry.v1",
    `ins_${venue}_${symbol}`, { kind: "upsert", instrument: instrument(venue, symbol, underlyingId) });
  await list("extended", "AAPL-USD", "equity:AAPL");
  await list("hyperliquid_hip3", "TSLA", "equity:TSLA");
  await list("bitget", "RNVDAUSDT", "bitget:rNVDA");
  await list("extended", "BTC-USD", "crypto:BTC");

  const subscribe = vi.spyOn(bus, "subscribe");
  const universe = await watchOtherVenueTickers(bus, "bitget", { quietMs: 2_000, maxWaitMs: 30_000 });
  let ready = false;
  void universe.ready.then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect(ready).toBe(true);
  expect([...universe.tickers].sort()).toEqual(["AAPL", "TSLA"]);
  await list("ondo_perps", "NVDA", "equity:NVDA");
  expect(universe.tickers.has("NVDA")).toBe(true);
  await universe.stop();
  // The replay group is used by this watcher alone, so stopping it deletes the group.
  expect(subscribe).toHaveBeenCalledWith("instrument.registry.v1", expect.stringMatching(/^bitget-other-venue-tickers-[0-9a-f-]{36}$/),
    expect.any(Function), { deleteGroupOnStop: true });
});

it("is ready by the maximum wait even while registry updates keep arriving", async () => {
  vi.useFakeTimers();
  const bus = new InMemoryEventBus();
  const universe = await watchOtherVenueTickers(bus, "bitget", { quietMs: 2_000, maxWaitMs: 5_000 });
  let ready = false;
  void universe.ready.then(() => { ready = true; });
  for (let second = 0; second < 5; second++) {
    await bus.publish("instrument.registry.v1", `k${second}`,
      { kind: "upsert", instrument: instrument("extended", `S${second}-USD`, `equity:S${second}`) });
    await vi.advanceTimersByTimeAsync(1_000);
  }

  expect(ready).toBe(true);
  await universe.stop();
});
