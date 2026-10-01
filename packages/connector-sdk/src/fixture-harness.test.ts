import { expect, it } from "vitest";
import { InstrumentSchema, type Instrument } from "@range/domain";
import { RetryAfterError } from "./retry.js";
import { assertAdapterFixture, type AdapterFixture, type AdapterFixtureFactory, type AdapterFixturePorts } from "./fixture-harness.js";
import type { ConnectorAdapter, FixtureCapableConnectorAdapter, RawSnapshot } from "./types.js";

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
  private rateLimitCalls = 0;

  constructor(protected readonly ports: AdapterFixturePorts) {}

  async probe() { this.ports.http.recordRequest({ accept: "application/json" }); return { available: true }; }
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

function fixture(factory: AdapterFixtureFactory): AdapterFixture {
  return {
    factory,
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

it("accepts a conforming factory that receives harness-owned ports", async () => {
  const factory: AdapterFixtureFactory = ports => {
    expect(Object.keys(ports).sort()).toEqual(["clock", "diagnostics", "http"]);
    expect(Object.keys(ports.http)).toEqual(["recordRequest"]);
    expect(Object.keys(ports.diagnostics).sort()).toEqual(["error", "log"]);
    return new FixtureAdapter(ports);
  };
  await expect(assertAdapterFixture(fixture(factory))).resolves.toBeUndefined();
});

it("rejects a broken factory whose real snapshot path leaves seconds unnormalized", async () => {
  const factory: AdapterFixtureFactory = ports => new class extends FixtureAdapter {
    override async snapshot() { return snapshot(1); }
  }(ports);
  await expect(assertAdapterFixture(fixture(factory))).rejects.toThrow("timestamp");
});

it("rejects a broken factory that leaks through mandatory logger and HTTP ports", async () => {
  const factory: AdapterFixtureFactory = ports => new class extends FixtureAdapter {
    override async probe() {
      this.ports.diagnostics.log("authorization: Bearer fixture-secret");
      this.ports.http.recordRequest({ authorization: "Bearer fixture-secret" });
      return super.probe();
    }
  }(ports);
  await expect(assertAdapterFixture(fixture(factory))).rejects.toThrow("credential");
});
