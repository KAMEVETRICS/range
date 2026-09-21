import { InstrumentSchema } from "@range/domain";
import { isEpochMilliseconds } from "./clock.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import type { ConnectorAdapter, RawVenueEvent } from "./types.js";

export interface AdapterFixture {
  readonly adapter: ConnectorAdapter;
  readonly expected: {
    readonly probe: { readonly available: boolean };
    readonly instrumentIds: readonly string[];
    readonly snapshots: readonly { readonly instrumentId: string; readonly sourceTimestampMs: number }[];
    readonly retryAfterMs: number;
  };
  /** Invoke the adapter's real parser with malformed input; it must reject. */
  readonly parseMalformedMessage: () => Promise<unknown>;
  readonly credentialValues: readonly string[];
  /** Exercise the adapter's actual rate-limit observable path. */
  readonly rateLimitAttempt: () => Promise<unknown>;
  /** Captures outward observables before fixture redaction. */
  readonly capture: () => {
    readonly logs: readonly unknown[];
    readonly requestHeaders: readonly unknown[];
    readonly health: readonly unknown[];
    readonly errors: readonly unknown[];
  };
  readonly sleep?: RetryOptions["sleep"];
}

function fixtureFailure(message: string): Error {
  return new Error(`Adapter fixture contract failed: ${message}`);
}

/** Safe diagnostic text for any adapter error; no message, cause, or headers are retained. */
export function redactConnectorError(_error: unknown, _credentialValues: readonly string[] = []): string {
  return "Connector operation failed";
}

function assertNormalized(event: RawVenueEvent, expected: AdapterFixture["expected"]["snapshots"][number]): void {
  if (!isEpochMilliseconds(event.sourceTimestampMs)) throw fixtureFailure("source timestamp must be epoch milliseconds");
  if (!event.eligibility) throw fixtureFailure("eligibility is required");
  if (!event.eventId || !event.instrumentId) throw fixtureFailure("events need stable identifiers");
  if (event.instrumentId !== expected.instrumentId || event.sourceTimestampMs !== expected.sourceTimestampMs) {
    throw fixtureFailure("normalized timestamp or instrument ID differs from the exact expected value");
  }
}

function containsCredential(value: unknown, credentials: readonly string[], visited = new Set<unknown>()): boolean {
  if (typeof value === "string") return credentials.some(credential => credential.length > 0 && value.includes(credential));
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  return Reflect.ownKeys(value).some(key => containsCredential(String(key), credentials, visited)
    || containsCredential((value as Record<PropertyKey, unknown>)[key], credentials, visited));
}

/**
 * Shared, framework-neutral checks every adapter runs against its real adapter
 * paths. The harness inspects captured outbound observables before any error
 * sanitization can hide a credential leak.
 */
export async function assertAdapterFixture(fixture: AdapterFixture): Promise<void> {
  const signal = new AbortController().signal;
  const probe = await fixture.adapter.probe(signal);
  if (probe.available !== fixture.expected.probe.available) throw fixtureFailure("probe result differs from expectation");

  const firstDiscovery = await fixture.adapter.discover(signal);
  const secondDiscovery = await fixture.adapter.discover(signal);
  const firstIds = firstDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  const secondIds = secondDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  if (JSON.stringify(firstIds) !== JSON.stringify(secondIds) || JSON.stringify(firstIds) !== JSON.stringify(fixture.expected.instrumentIds)) {
    throw fixtureFailure("discovery IDs are not stable or do not match expectation");
  }
  if (firstDiscovery.length !== fixture.expected.snapshots.length) throw fixtureFailure("snapshot expectation count differs from discovery");
  for (const [index, instrument] of firstDiscovery.entries()) {
    assertNormalized(await fixture.adapter.snapshot(instrument, signal), fixture.expected.snapshots[index]!);
  }

  let malformedRejected = false;
  try { await fixture.parseMalformedMessage(); }
  catch { malformedRejected = true; }
  if (!malformedRejected) throw fixtureFailure("malformed messages must be rejected by the adapter parser");

  const observedDelays: number[] = [];
  await retryWithBackoff(fixture.rateLimitAttempt, {
    sleep: async delayMs => {
      observedDelays.push(delayMs);
      await fixture.sleep?.(delayMs);
    },
  });
  if (!observedDelays.includes(fixture.expected.retryAfterMs)) {
    throw fixtureFailure("the adapter rate-limit path did not honor the expected Retry-After");
  }

  const captured = fixture.capture();
  for (const [name, values] of Object.entries(captured)) {
    if (containsCredential(values, fixture.credentialValues)) throw fixtureFailure(`credential leaked in captured ${name}`);
  }
}
