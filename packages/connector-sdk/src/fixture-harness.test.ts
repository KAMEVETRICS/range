import { expect, it } from "vitest";
import { InstrumentSchema, type Instrument } from "@range/domain";
import { RetryAfterError } from "./retry.js";
import { assertAdapterFixture, type AdapterFixture } from "./fixture-harness.js";
import type { ConnectorAdapter, RawSnapshot } from "./types.js";

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

function adapter(timestamp = 1_000): ConnectorAdapter {
  return {
    venue: "fixture",
    async probe() { return { available: true }; },
    async discover() { return [instrument]; },
    async snapshot() { return snapshot(timestamp); },
  };
}

function fixture(overrides: Partial<AdapterFixture> = {}): AdapterFixture {
  let attempts = 0;
  return {
    adapter: adapter(),
    expected: {
      probe: { available: true },
      instrumentIds: [instrument.instrumentId],
      snapshots: [{ instrumentId: instrument.instrumentId, sourceTimestampMs: 1_000 }],
      retryAfterMs: 25,
    },
    parseMalformedMessage: async () => { throw new Error("malformed"); },
    credentialValues: ["fixture-secret"],
    rateLimitAttempt: async () => {
      attempts += 1;
      if (attempts === 1) throw new RetryAfterError("429", 25);
    },
    capture: () => ({ logs: [], requestHeaders: [], health: [], errors: [] }),
    sleep: async () => {},
    ...overrides,
  };
}

it("rejects a fixture whose actual snapshot timestamp differs from its expected normalized timestamp", async () => {
  await expect(assertAdapterFixture(fixture({ adapter: adapter(999) }))).rejects.toThrow("timestamp");
});

it("rejects a fixture whose captured request headers or logs contain a credential", async () => {
  const secret = "fixture-secret";
  await expect(assertAdapterFixture(fixture({
    capture: () => ({
      logs: [`authorization: Bearer ${secret}`],
      requestHeaders: [{ authorization: `Bearer ${secret}` }],
      health: [],
      errors: [],
    }),
  }))).rejects.toThrow("credential");
});
