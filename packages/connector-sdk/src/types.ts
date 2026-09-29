import type {
  DataEligibility,
  Instrument,
  VenueHealth,
} from "@range/domain";
import { CanonicalObservationPayloadSchema } from "@range/domain";
import type { z } from "zod";

/** The result of a lightweight venue availability check. */
export interface ProbeResult {
  readonly available: boolean;
  readonly retryAfterMs?: number;
  readonly capabilities?: readonly string[];
}

/** Connectors return the reviewed canonical instrument model, not a local copy. */
export type DiscoveredInstrument = Instrument;

/**
 * Canonical market data before the runtime assigns its receive timestamp and
 * applies the common safety checks. All timestamps are epoch milliseconds.
 */
export interface RawVenueEvent {
  readonly eventId: string;
  readonly instrumentId: string;
  readonly sourceTimestampMs: number;
  readonly sequence?: string | number;
  /** Declared only by adapters whose stream contract proves adjacent values. */
  readonly sequencePolicy?: "contiguous";
  readonly transport: "websocket" | "rest" | "replay";
  readonly freshnessBudgetMs: number;
  readonly qualityFlags: readonly string[];
  readonly rawPayloadRefOrHash: string;
  readonly eligibility: DataEligibility;
  readonly payload: z.input<typeof CanonicalObservationPayloadSchema>;
}

export type RawSnapshot = RawVenueEvent;

/** Optional adapter fixture surface used only by connector contract tests. */
export interface FixtureCapableConnectorAdapter {
  parseFixtureMessage(input: unknown, signal: AbortSignal): Promise<RawVenueEvent>;
  exerciseFixtureRateLimit(signal: AbortSignal): Promise<void>;
}

export interface ConnectorAdapter {
  readonly venue: string;
  probe(signal: AbortSignal): Promise<ProbeResult>;
  discover(signal: AbortSignal): Promise<DiscoveredInstrument[]>;
  snapshot(instrument: DiscoveredInstrument, signal: AbortSignal): Promise<RawSnapshot>;
  stream?(
    instruments: DiscoveredInstrument[],
    signal: AbortSignal,
  ): AsyncIterable<RawVenueEvent>;
  /**
   * Periodic REST data that complements the stream or snapshot polling, such as funding rates. The runtime fetches
   * it when a session starts and then every supplementIntervalMs (default 60 s); a failed fetch is counted in
   * health as SUPPLEMENT_<code> and tried again at the next interval.
   */
  supplement?(instruments: DiscoveredInstrument[], signal: AbortSignal): Promise<RawVenueEvent[]>;
  supplementIntervalMs?: number;
}

export type ConnectorHealth = VenueHealth;
