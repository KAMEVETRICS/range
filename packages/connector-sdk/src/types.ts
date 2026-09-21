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
  readonly transport: "websocket" | "rest" | "replay";
  readonly freshnessBudgetMs: number;
  readonly qualityFlags: readonly string[];
  readonly rawPayloadRefOrHash: string;
  readonly eligibility: DataEligibility;
  readonly payload: z.input<typeof CanonicalObservationPayloadSchema>;
}

export type RawSnapshot = RawVenueEvent;

export interface ConnectorAdapter {
  readonly venue: string;
  probe(signal: AbortSignal): Promise<ProbeResult>;
  discover(signal: AbortSignal): Promise<DiscoveredInstrument[]>;
  snapshot(instrument: DiscoveredInstrument, signal: AbortSignal): Promise<RawSnapshot>;
  stream?(
    instruments: DiscoveredInstrument[],
    signal: AbortSignal,
  ): AsyncIterable<RawVenueEvent>;
}

export type ConnectorHealth = VenueHealth;
