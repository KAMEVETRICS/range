import type { EventBus } from "@range/event-bus";
import { ObservationEnvelopeSchema, VenueHealthSchema } from "@range/domain";
import type { VenueHealth } from "@range/domain";
import { clockSkewMs, isEpochMilliseconds } from "./clock.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import type { ConnectorAdapter, ConnectorHealth, DiscoveredInstrument, RawVenueEvent } from "./types.js";

export interface ConnectorRuntimeOptions {
  readonly adapter: ConnectorAdapter;
  readonly eventBus: EventBus;
  readonly nowMs?: () => number;
  readonly maxClockSkewMs?: number;
  readonly retry?: RetryOptions;
}

type ConnectionState = VenueHealth["connectionState"];

export class ConnectorRuntime {
  private readonly nowMs: () => number;
  private readonly maxClockSkewMs: number;
  private readonly retry: RetryOptions;
  private instruments: DiscoveredInstrument[] | undefined;
  private connectionState: ConnectionState = "disconnected";
  private quarantined = false;
  private lastReceivedAtMs: number;
  private lastClockSkewMs = 0;
  private sequenceIntegrity: VenueHealth["sequenceIntegrity"] = "unknown";
  private rateLimit: VenueHealth["rateLimit"] = { state: "unknown" };
  private readonly errorCounters: Record<string, number> = {};
  private readonly sequences = new Map<string, number>();

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    this.retry = options.retry ?? {};
    this.lastReceivedAtMs = this.nowMs();
  }

  health(): ConnectorHealth {
    return VenueHealthSchema.parse({
      venue: this.options.adapter.venue,
      connectionState: this.connectionState,
      lastEventAgeMs: Math.max(0, this.nowMs() - this.lastReceivedAtMs),
      clockSkewMs: this.lastClockSkewMs,
      sequenceIntegrity: this.sequenceIntegrity,
      rateLimit: this.rateLimit,
      capabilityChanges: [],
      errorCounters: { ...this.errorCounters },
      ...(this.quarantined ? { quarantineReason: "CLOCK_SKEW_EXCEEDED" as const } : {}),
    });
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.runUntilDisconnected(signal);
  }

  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<void> {
    const instruments = await this.ensureConnected(signal);
    if (!instruments) return;
    for (const instrument of instruments) {
      try {
        await this.handleEvent(await this.call(() => this.options.adapter.snapshot(instrument, signal)));
      } catch (error) {
        await this.degrade(error);
        return;
      }
    }
  }

  async runUntilDisconnected(signal: AbortSignal = new AbortController().signal): Promise<void> {
    const instruments = await this.ensureConnected(signal);
    if (!instruments) return;
    if (!this.options.adapter.stream) {
      await this.pollOnce(signal);
      return;
    }
    try {
      for await (const event of this.options.adapter.stream(instruments, signal)) await this.handleEvent(event);
      if (!signal.aborted) await this.degrade();
    } catch (error) {
      await this.degrade(error);
    }
  }

  private async ensureConnected(signal: AbortSignal): Promise<DiscoveredInstrument[] | undefined> {
    await this.transition("connecting");
    try {
      const probe = await this.call(() => this.options.adapter.probe(signal));
      if (!probe.available) {
        await this.degrade();
        return undefined;
      }
      this.instruments ??= await this.call(() => this.options.adapter.discover(signal));
      this.rateLimit = { state: "healthy" };
      await this.transition("connected");
      return this.instruments;
    } catch (error) {
      await this.degrade(error);
      return undefined;
    }
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    return retryWithBackoff(operation, this.retry);
  }

  private async handleEvent(event: RawVenueEvent): Promise<void> {
    const receivedTimestamp = this.nowMs();
    if (!isEpochMilliseconds(event.sourceTimestampMs)) {
      await this.degrade(new Error("invalid source timestamp"));
      return;
    }
    this.lastReceivedAtMs = receivedTimestamp;
    this.lastClockSkewMs = clockSkewMs(event.sourceTimestampMs, receivedTimestamp);
    this.trackSequence(event);
    if (this.lastClockSkewMs > this.maxClockSkewMs) {
      this.quarantined = true;
      await this.transition("quarantined");
      return;
    }
    if (this.quarantined) return;

    const observation = ObservationEnvelopeSchema.parse({
      eventId: event.eventId,
      schemaVersion: 1,
      venue: this.options.adapter.venue,
      instrumentId: event.instrumentId,
      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
      transport: event.transport,
      sourceTimestamp: event.sourceTimestampMs,
      receivedTimestamp,
      freshnessBudgetMs: event.freshnessBudgetMs,
      qualityFlags: [...event.qualityFlags],
      rawPayloadRefOrHash: event.rawPayloadRefOrHash,
      eligibility: event.eligibility,
      payload: event.payload,
    });
    const { payload: _payload, ...rawEvent } = observation;
    await this.options.eventBus.publish("market.raw.v1", `${this.options.adapter.venue}:${event.instrumentId}`, rawEvent);
    await this.options.eventBus.publish("market.observation.v1", `${this.options.adapter.venue}:${event.instrumentId}`, observation);
  }

  private trackSequence(event: RawVenueEvent): void {
    if (typeof event.sequence !== "number") return;
    const prior = this.sequences.get(event.instrumentId);
    if (prior !== undefined && event.sequence > prior + 1) this.sequenceIntegrity = "gap";
    else if (this.sequenceIntegrity === "unknown") this.sequenceIntegrity = "consistent";
    this.sequences.set(event.instrumentId, event.sequence);
  }

  private async degrade(error?: unknown): Promise<void> {
    if (error instanceof Error) {
      const code = error.name || "Error";
      this.errorCounters[code] = (this.errorCounters[code] ?? 0) + 1;
    }
    await this.transition("degraded");
  }

  private async transition(next: ConnectionState): Promise<void> {
    if (this.connectionState === next) return;
    this.connectionState = next;
    await this.options.eventBus.publish("venue.health.v1", this.options.adapter.venue, this.health());
  }
}
