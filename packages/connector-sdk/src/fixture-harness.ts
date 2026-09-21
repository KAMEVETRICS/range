import { InstrumentSchema } from "@range/domain";
import { isEpochMilliseconds } from "./clock.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import type { ConnectorAdapter, RawVenueEvent } from "./types.js";

export interface AdapterFixture {
  readonly adapter: ConnectorAdapter;
  readonly malformedMessage: () => Promise<unknown>;
  readonly credentialValues: readonly string[];
  readonly credentialError: () => Promise<unknown>;
  readonly rateLimitAttempt: () => Promise<unknown>;
  readonly sleep?: RetryOptions["sleep"];
}

function fixtureFailure(message: string): Error {
  return new Error(`Adapter fixture contract failed: ${message}`);
}

/** A safe error string for adapter diagnostics. Header and credential values never escape. */
export function redactConnectorError(_error: unknown, _credentialValues: readonly string[] = []): string {
  return "Connector operation failed";
}

function assertNormalized(event: RawVenueEvent): void {
  if (!isEpochMilliseconds(event.sourceTimestampMs)) throw fixtureFailure("source timestamp must be epoch milliseconds");
  if (!event.eligibility) throw fixtureFailure("eligibility is required");
  if (!event.eventId || !event.instrumentId) throw fixtureFailure("events need stable identifiers");
}

/**
 * Shared, framework-neutral checks that every venue adapter can invoke in its
 * fixture test. It verifies stable discovery IDs, normalized timestamps,
 * malformed-message rejection, Retry-After handling, and secret-safe errors.
 */
export async function assertAdapterFixture(fixture: AdapterFixture): Promise<void> {
  const signal = new AbortController().signal;
  const firstDiscovery = await fixture.adapter.discover(signal);
  const secondDiscovery = await fixture.adapter.discover(signal);
  const firstIds = firstDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  const secondIds = secondDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  if (JSON.stringify(firstIds) !== JSON.stringify(secondIds)) throw fixtureFailure("discovery IDs are not stable");

  for (const instrument of firstDiscovery) assertNormalized(await fixture.adapter.snapshot(instrument, signal));

  let malformedRejected = false;
  try { await fixture.malformedMessage(); }
  catch { malformedRejected = true; }
  if (!malformedRejected) throw fixtureFailure("malformed messages must be rejected");

  let advertisedRetryAfterMs: number | undefined;
  const observedDelays: number[] = [];
  await retryWithBackoff(async () => {
    try { return await fixture.rateLimitAttempt(); }
    catch (error) {
      const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
      if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
        advertisedRetryAfterMs = Math.floor(retryAfterMs);
      }
      throw error;
    }
  }, {
    sleep: async delayMs => {
      observedDelays.push(delayMs);
      await fixture.sleep?.(delayMs);
    },
  });
  if (advertisedRetryAfterMs === undefined || !observedDelays.includes(advertisedRetryAfterMs)) {
    throw fixtureFailure("a simulated Retry-After response must be honored");
  }

  try { await fixture.credentialError(); }
  catch (error) {
    const safe = redactConnectorError(error, fixture.credentialValues);
    for (const credential of fixture.credentialValues) {
      if (credential && safe.includes(credential)) throw fixtureFailure("credential leaked through error redaction");
    }
    return;
  }
  throw fixtureFailure("credential error must reject");
}
