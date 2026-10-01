import { InstrumentSchema } from "@range/domain";
import { isEpochMilliseconds } from "./clock.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import type { ConnectorAdapter, FixtureCapableConnectorAdapter, RawVenueEvent } from "./types.js";

/** Mandatory fixture-only outbound ports. Adapters must not bypass these ports with global fetch or console APIs. */
export interface AdapterFixturePorts {
  readonly http: { recordRequest(headers: unknown): void };
  readonly diagnostics: { log(entry: unknown): void; error(metadata: unknown): void };
  readonly clock: { nowMs(): number };
}

export type AdapterFixtureFactory = (
  ports: AdapterFixturePorts,
) => ConnectorAdapter & FixtureCapableConnectorAdapter;

export interface AdapterFixture {
  readonly factory: AdapterFixtureFactory;
  readonly expected: {
    readonly probe: { readonly available: boolean };
    readonly instrumentIds: readonly string[];
    readonly snapshots: readonly { readonly instrumentId: string; readonly sourceTimestampMs: number }[];
    readonly retryAfterMs: number;
    readonly malformedMessage: unknown;
  };
  readonly credentialValues: readonly string[];
  readonly sleep?: RetryOptions["sleep"];
}

type Captured = { logs: unknown[]; requestHeaders: unknown[]; errors: unknown[] };

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

function fixturePorts(captured: Captured): AdapterFixturePorts {
  return {
    http: { recordRequest: headers => { captured.requestHeaders.push(headers); } },
    diagnostics: {
      log: entry => { captured.logs.push(entry); },
      error: metadata => { captured.errors.push(metadata); },
    },
    clock: { nowMs: () => 1_000 },
  };
}

/**
 * Builds the adapter with harness-owned ports and runs its actual fixture
 * operations. Separately supplied parser, capture, and rate-limit callbacks
 * are intentionally not part of this contract.
 */
export async function assertAdapterFixture(fixture: AdapterFixture): Promise<void> {
  const signal = new AbortController().signal;
  const captured: Captured = { logs: [], requestHeaders: [], errors: [] };
  const adapter = fixture.factory(fixturePorts(captured));

  const probe = await adapter.probe(signal);
  if (probe.available !== fixture.expected.probe.available) throw fixtureFailure("probe result differs from expectation");

  const firstDiscovery = await adapter.discover(signal);
  const secondDiscovery = await adapter.discover(signal);
  const firstIds = firstDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  const secondIds = secondDiscovery.map(instrument => InstrumentSchema.parse(instrument).instrumentId);
  if (JSON.stringify(firstIds) !== JSON.stringify(secondIds) || JSON.stringify(firstIds) !== JSON.stringify(fixture.expected.instrumentIds)) {
    throw fixtureFailure("discovery IDs are not stable or do not match expectation");
  }
  if (firstDiscovery.length !== fixture.expected.snapshots.length) throw fixtureFailure("snapshot expectation count differs from discovery");
  for (const [index, instrument] of firstDiscovery.entries()) {
    assertNormalized(await adapter.snapshot(instrument, signal), fixture.expected.snapshots[index]!);
  }

  let malformedRejected = false;
  try { await adapter.parseFixtureMessage(fixture.expected.malformedMessage, signal); }
  catch { malformedRejected = true; }
  if (!malformedRejected) throw fixtureFailure("malformed messages must be rejected by the adapter parser");

  const observedDelays: number[] = [];
  await retryWithBackoff(() => adapter.exerciseFixtureRateLimit(signal), {
    sleep: async delayMs => {
      observedDelays.push(delayMs);
      await fixture.sleep?.(delayMs);
    },
  });
  if (!observedDelays.includes(fixture.expected.retryAfterMs)) {
    throw fixtureFailure("the adapter rate-limit path did not honor the expected Retry-After");
  }

  for (const [name, values] of Object.entries(captured)) {
    if (containsCredential(values, fixture.credentialValues)) throw fixtureFailure(`credential leaked in captured ${name}`);
  }
}
