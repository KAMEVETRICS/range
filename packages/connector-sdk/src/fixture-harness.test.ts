import { expect, it } from "vitest";
import { InstrumentSchema, type Instrument } from "@range/domain";
import { RetryAfterError } from "./retry.js";
import { assertAdapterFixture, type AdapterFixture } from "./fixture-harness.js";
import type { ConnectorAdapter, FixtureCapableConnectorAdapter, FixtureCaptureSink, RawSnapshot } from "./types.js";

const instrument: Instrument = InstrumentSchema.parse({
  instrumentId: "ins_fixture_RAAPLUSDT", underlyingId: "RAAPL", venue: "fixture", venueSymbol: "RAAPLUSDT",
  quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT", productType: "perpetual",
  contractMultiplier: "1", tickSize: "0.01", lotSize: "1", minimumNotional: "0", fundingInterval: 28_800_000,
  tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1], opensAt: "00:00", closesAt: "23:59" }] },
  capabilities: ["snapshot"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
});

const snapshot = (sourceTimestampMs = 1_000): RawSnapshot => ({
  eventId: "evt_fixture", instrumentId: instrument.instrumentId, sourceTimestampMs, transport: "rest",
  freshnessBudgetMs: 1_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:fixture", eligibility: "live",
  payload: { kind: "index_price", price: "200" },
});

class FixtureAdapter implements ConnectorAdapter, FixtureCapableConnectorAdapter {
  readonly venue = "fixture";
  protected capture: FixtureCaptureSink | undefined;
  private rateLimitCalls = 0;

  async withFixtureCapture<T>(sink: FixtureCaptureSink, operation: () => Promise<T>): Promise<T> {
    this.capture = sink;
    try { return await operation(); }
    finally { this.capture = undefined; }
  }

  async probe() { this.capture?.requestHeaders({ accept: "application/json" }); return { available: true }; }
  async discover() { return [instrument]; }
  async snapshot() { return snapshot(); }
  async parseFixtureMessage(input: unknown): Promise<RawSnapshot> {
    if (input === "malformed") throw new Error("invalid fixture message");
    return snapshot();
  }
  async exerciseFixtureRateLimit(): Promise<void> {
    this.rateLimitCalls += 1;
    if (this.rateLimitCalls === 1) throw new RetryAfterError("429", 25);
  }
}

function fixture(adapter: FixtureAdapter): AdapterFixture {
  return {
    adapter,
    expected: {
      probe: { available: true },
      instrumentIds: [instrument.instrumentId],
      snapshots: [{ instrumentId: instrument.instrumentId, sourceTimestampMs: 1_000 }],
      retryAfterMs: 25,
      malformedMessage: "malformed",
    },
    credentialValues: ["fixture-secret"],
    sleep: async () => {},
  };
}

it("accepts a conforming adapter through an interposed capture sink", async () => {
  await expect(assertAdapterFixture(fixture(new FixtureAdapter()))).resolves.toBeUndefined();
});

it("rejects a broken adapter whose real snapshot path leaves seconds unnormalized", async () => {
  class SecondsAdapter extends FixtureAdapter {
    override async snapshot() { return snapshot(1); }
  }
  await expect(assertAdapterFixture(fixture(new SecondsAdapter()))).rejects.toThrow("timestamp");
});

it("rejects a broken adapter whose real probe path leaks credentials into the installed sink", async () => {
  class LeakingAdapter extends FixtureAdapter {
    override async probe() {
      this.capture?.log("authorization: Bearer fixture-secret");
      return super.probe();
    }
  }
  await expect(assertAdapterFixture(fixture(new LeakingAdapter()))).rejects.toThrow("credential");
});
