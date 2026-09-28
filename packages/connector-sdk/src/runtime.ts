import type { EventBus } from "@range/event-bus";
import { ObservationEnvelopeSchema, VenueHealthSchema } from "@range/domain";
import type { VenueHealth } from "@range/domain";
import { clockSkewMs, isEpochMilliseconds } from "./clock.js";
import {
  backoffDelayMs,
  ConnectorDiagnosticError,
  retryWithBackoff,
  toConnectorDiagnostic,
  waitForRetry,
  type RetryOptions,
} from "./retry.js";
import type { ConnectorAdapter, ConnectorHealth, DiscoveredInstrument, RawVenueEvent } from "./types.js";

export interface ConnectorRuntimeOptions {
  readonly adapter: ConnectorAdapter;
  readonly eventBus: EventBus;
  readonly nowMs?: () => number;
  readonly maxClockSkewMs?: number;
  readonly retry?: RetryOptions;
  readonly reconnect?: RetryOptions;
  readonly pollIntervalMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Unchanged health is republished at least this often while events flow, so a restarted consumer relearns it. */
  readonly healthHeartbeatMs?: number;
  /** market.raw.v1 has no reader until the raw archive exists, and publishing it doubled each event's broker writes. */
  readonly publishRawEvents?: boolean;
}

type ConnectionState = VenueHealth["connectionState"];

export class ConnectorRuntime {
  private readonly nowMs: () => number;
  private readonly maxClockSkewMs: number;
  private readonly retry: RetryOptions;
  private readonly reconnect: RetryOptions;
  private readonly pollIntervalMs: number;
  private instruments: DiscoveredInstrument[] = [];
  private connectionState: ConnectionState = "disconnected";
  private quarantined = false;
  private lastReceivedAtMs: number;
  private lastClockSkewMs = 0;
  private sequenceIntegrity: VenueHealth["sequenceIntegrity"] = "unknown";
  private rateLimit: VenueHealth["rateLimit"] = { state: "unknown" };
  private readonly errorCounters: Record<string, number> = {};
  private readonly sequences = new Map<string, number>();
  private lastPublishedMaterial = "";
  private lastHealthPublishedAtMs = Number.NEGATIVE_INFINITY;
  private readonly healthHeartbeatMs: number;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    this.retry = options.retry ?? {};
    this.reconnect = options.reconnect ?? {};
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.healthHeartbeatMs = options.healthHeartbeatMs ?? 30_000;
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

  /** Persistent production lifecycle. It reconnects and keeps REST polling until cancelled. */
  async start(signal: AbortSignal): Promise<void> {
    let reconnectAttempt = 0;
    while (!signal.aborted) {
      const outcome = await this.session(signal, true);
      if (signal.aborted) break;
      try { await this.waitForReconnect(reconnectAttempt, outcome, signal); }
      catch (error) {
        if (signal.aborted) break;
        throw toConnectorDiagnostic(error);
      }
      reconnectAttempt += 1;
    }
  }

  /** Bounded helper for deterministic snapshot tests. */
  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.prepareSession(signal);
  }

  /** Bounded helper that consumes exactly one streaming session. */
  async runUntilDisconnected(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.session(signal, false);
  }

  private async session(signal: AbortSignal, persistent: boolean): Promise<ConnectorDiagnosticError | undefined> {
    const instruments = await this.prepareSession(signal);
    if (!instruments.length || signal.aborted) return undefined;
    if (!this.options.adapter.stream) return persistent ? this.pollUntilAborted(instruments, signal) : undefined;
    try {
      for await (const event of this.options.adapter.stream(instruments, signal)) {
        if (signal.aborted) break;
        await this.handleEvent(event);
      }
      if (signal.aborted) return undefined;
      const diagnostic = new ConnectorDiagnosticError("ADAPTER_FAILURE");
      await this.degrade(diagnostic);
      return diagnostic;
    } catch (error) {
      const diagnostic = toConnectorDiagnostic(error);
      if (!signal.aborted) await this.degrade(diagnostic);
      return diagnostic;
    }
  }

  private async pollUntilAborted(instruments: DiscoveredInstrument[], signal: AbortSignal): Promise<ConnectorDiagnosticError | undefined> {
    while (!signal.aborted) {
      try {
        await this.snapshotAll(instruments, signal);
        if (signal.aborted) return undefined;
        await waitForRetry(this.pollIntervalMs, { signal, sleep: this.options.sleep });
      } catch (error) {
        const diagnostic = toConnectorDiagnostic(error);
        if (!signal.aborted) await this.degrade(diagnostic);
        return diagnostic;
      }
    }
    return undefined;
  }

  private async prepareSession(signal: AbortSignal): Promise<DiscoveredInstrument[]> {
    await this.transition("connecting");
    try {
      const probe = await this.call(() => this.options.adapter.probe(signal), signal);
      if (!probe.available) {
        await this.degrade(new ConnectorDiagnosticError("ADAPTER_FAILURE", probe.retryAfterMs));
        return [];
      }
      this.instruments = await this.call(() => this.options.adapter.discover(signal), signal);
      for (const instrument of this.instruments) {
        await this.options.eventBus.publish("instrument.registry.v1", instrument.instrumentId, { kind: "upsert", instrument });
      }
      this.resetRecoveredSession();
      await this.markHealthy();
      await this.snapshotAll(this.instruments, signal);
      return this.instruments;
    } catch (error) {
      const diagnostic = toConnectorDiagnostic(error);
      if (!signal.aborted) await this.degrade(diagnostic);
      return [];
    }
  }

  private resetRecoveredSession(): void {
    this.quarantined = false;
    this.lastClockSkewMs = 0;
    if (this.sequenceIntegrity !== "gap") this.sequenceIntegrity = "unknown";
    this.sequences.clear();
  }

  private async snapshotAll(instruments: DiscoveredInstrument[], signal: AbortSignal): Promise<void> {
    for (const instrument of instruments) {
      await this.handleEvent(await this.call(() => this.options.adapter.snapshot(instrument, signal), signal));
    }
  }

  private async call<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previousOnRetry = this.retry.onRetry;
    const result = await retryWithBackoff(operation, {
      ...this.retry,
      signal,
      onRetry: async context => {
        this.rateLimit = context.code === "RATE_LIMITED"
          ? { state: "limited", ...(context.retryAfterMs && context.retryAfterMs > 0 ? { retryAfterMs: context.retryAfterMs } : {}) }
          : { state: "backing_off" };
        await this.transition("degraded");
        await previousOnRetry?.(context);
      },
    });
    await this.markHealthy();
    return result;
  }

  private async markHealthy(): Promise<void> {
    this.rateLimit = { state: "healthy" };
    await this.transition("connected");
  }

  private async waitForReconnect(attempt: number, error: ConnectorDiagnosticError | undefined, signal: AbortSignal): Promise<void> {
    const retryAfterMs = error?.retryAfterMs;
    const delayMs = backoffDelayMs(attempt, this.reconnect, retryAfterMs);
    this.rateLimit = error?.code === "RATE_LIMITED"
      ? { state: "limited", ...(retryAfterMs && retryAfterMs > 0 ? { retryAfterMs } : {}) }
      : { state: "backing_off" };
    await this.transition("degraded");
    await waitForRetry(delayMs, { signal, sleep: this.reconnect.sleep ?? this.options.sleep });
  }

  private async handleEvent(event: RawVenueEvent): Promise<void> {
    const receivedTimestamp = this.nowMs();
    if (!isEpochMilliseconds(event.sourceTimestampMs)) {
      await this.degrade(new ConnectorDiagnosticError("ADAPTER_FAILURE"));
      return;
    }
    this.lastReceivedAtMs = receivedTimestamp;
    this.lastClockSkewMs = clockSkewMs(event.sourceTimestampMs, receivedTimestamp);
    const sequenceReset = this.trackSequence(event);
    if (this.lastClockSkewMs > this.maxClockSkewMs) {
      this.quarantined = true;
      await this.transition("quarantined");
      return;
    }
    if (this.quarantined) return;
    await this.publishMaterialHealth();

    const observation = ObservationEnvelopeSchema.parse({
      eventId: event.eventId,
      schemaVersion: 1,
      venue: this.options.adapter.venue,
      instrumentId: event.instrumentId,
      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
      ...(event.sequencePolicy === undefined ? {} : { sequencePolicy: event.sequencePolicy }),
      ...(sequenceReset ? { sequenceReset: true as const } : {}),
      transport: event.transport,
      sourceTimestamp: event.sourceTimestampMs,
      receivedTimestamp,
      freshnessBudgetMs: event.freshnessBudgetMs,
      qualityFlags: [...event.qualityFlags],
      rawPayloadRefOrHash: event.rawPayloadRefOrHash,
      eligibility: event.eligibility,
      payload: event.payload,
    });
    if (this.options.publishRawEvents) {
      const { payload: _payload, ...rawEvent } = observation;
      await this.options.eventBus.publish("market.raw.v1", `${this.options.adapter.venue}:${event.instrumentId}`, rawEvent);
    }
    await this.options.eventBus.publish("market.observation.v1", `${this.options.adapter.venue}:${event.instrumentId}`, observation);
  }

  private trackSequence(event: RawVenueEvent): boolean {
    if (event.sequencePolicy !== "contiguous" || typeof event.sequence !== "number") return false;
    const prior = this.sequences.get(event.instrumentId);
    if (prior === undefined) {
      // Only a session's first validated snapshot clears a gap retained across reconnect.
      if (this.sequenceIntegrity !== "gap" || this.sequences.size === 0) this.sequenceIntegrity = "consistent";
    } else if (event.sequence !== prior + 1) this.sequenceIntegrity = "gap";
    else if (this.sequenceIntegrity === "unknown") this.sequenceIntegrity = "consistent";
    this.sequences.set(event.instrumentId, event.sequence);
    return prior === undefined;
  }

  private async degrade(error: unknown): Promise<void> {
    const diagnostic = toConnectorDiagnostic(error);
    if (diagnostic.code === "SEQUENCE_GAP") this.sequenceIntegrity = "gap";
    this.errorCounters[diagnostic.code] = (this.errorCounters[diagnostic.code] ?? 0) + 1;
    await this.transition("degraded");
  }

  private async transition(next: ConnectionState): Promise<void> {
    this.connectionState = next;
    await this.publishMaterialHealth();
  }

  private async publishMaterialHealth(): Promise<void> {
    const health = this.health();
    const material = JSON.stringify({
      connectionState: health.connectionState,
      clockSkewMs: health.clockSkewMs,
      sequenceIntegrity: health.sequenceIntegrity,
      rateLimit: health.rateLimit,
      errorCounters: health.errorCounters,
      quarantineReason: health.quarantineReason,
    });
    const now = this.nowMs();
    if (material === this.lastPublishedMaterial && now - this.lastHealthPublishedAtMs < this.healthHeartbeatMs) return;
    this.lastPublishedMaterial = material;
    this.lastHealthPublishedAtMs = now;
    await this.options.eventBus.publish("venue.health.v1", this.options.adapter.venue, health);
  }
}
