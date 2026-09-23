import type { EventBus } from "@range/event-bus";
import type { ObservationEnvelope, Opportunity, VenueHealth } from "@range/domain";
import { InstrumentRegistry } from "@range/instruments";
import { OrderBook, normalizeFunding, projectFunding, quoteAtNotional, type NormalizedFunding } from "@range/market-state";
import { activeLifecycle, evaluateOpportunityWithEvidence, type EvaluationInput, type EvaluationLeg, type Strategy } from "@range/opportunity";

export interface WorkerPolicy {
  now?: () => number;
  debounceMs?: number;
  requestedNotionalUsd: string;
  minimumNotionalUsd: string;
  holdingHorizonMs: number;
  feesBpsByVenue: Record<string, string>;
  slippageBpsByVenue: Record<string, string>;
  financingBps: string;
  gasAndTransferBps: string;
  fxConversionBps: string;
  uncertaintyBufferBps: string;
  borrowByInstrument?: Record<string, { costBps: string; capacityUsd: string; observedAtMs: number }>;
  minNetEdgeBps?: string;
  synchronizationBudgetMs?: number;
  maxClockSkewMs?: number;
  calculationVersion?: string;
}

export interface OpportunityWorker {
  flush(): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

/** Consumes normalized state and evaluates only affected underlyings after a bounded debounce. */
export async function startOpportunityWorker(bus: EventBus, registry: InstrumentRegistry, policy: WorkerPolicy): Promise<OpportunityWorker> {
  const now = policy.now ?? Date.now;
  const debounceMs = Math.max(0, Math.min(25, policy.debounceMs ?? 25));
  const books = new Map<string, OrderBook>();
  const funding = new Map<string, ObservationEnvelope[]>();
  const health = new Map<string, VenueHealth>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const generations = new Map<string, number>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const active = new Map<string, ReturnType<typeof activeLifecycle>>();
  const unsubscribe: Array<() => Promise<void>> = [];
  let publishing = Promise.resolve();
  let stateFence = Promise.resolve();
  const withStateFence = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const previous = stateFence;
    let release!: () => void;
    stateFence = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  };
  const publish = async (opportunity: Opportunity) => {
    await bus.publish("opportunity.v1", opportunity.underlyingId, opportunity);
  };
  const queuePublish = (opportunity: Opportunity) => {
    publishing = publishing.then(() => publish(opportunity));
  };
  const expireInstrument = (instrumentId: string) => {
    for (const [id, lifecycle] of active) {
      const before = lifecycle.current(now());
      if (before.status !== "actionable") continue;
      const after = lifecycle.onCapabilityWithdrawal(instrumentId);
      if (after.status === "expired") {
        clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id); active.delete(id); queuePublish(after);
      }
    }
  };
  const expireBook = (instrumentId: string) => {
    for (const [id, lifecycle] of active) {
      if (lifecycle.current(now()).status !== "actionable") continue;
      const after = lifecycle.onQuoteWithdrawal(instrumentId);
      if (after.status === "expired") {
        clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id); active.delete(id); queuePublish(after);
      }
    }
  };
  const expireMapping = (underlyingId: string) => {
    for (const [id, lifecycle] of active) {
      if (lifecycle.current(now()).status !== "actionable") continue;
      const after = lifecycle.onMappingWithdrawal(underlyingId);
      if (after.status === "expired") {
        clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id); active.delete(id); queuePublish(after);
      }
    }
  };
  const bump = (underlyingId: string) => generations.set(underlyingId, (generations.get(underlyingId) ?? 0) + 1);
  const removeWithdrawal = registry.onCapabilityWithdrawal(event => {
    const underlyingId = registry.getCurrent(event.instrumentId)?.instrument.underlyingId;
    books.delete(event.instrumentId);
    funding.delete(event.instrumentId);
    if (underlyingId) bump(underlyingId);
    expireInstrument(event.instrumentId);
  });

  const evaluateUnlocked = async (underlyingId: string) => {
    const generation = generations.get(underlyingId) ?? 0;
    const at = now();
    const instrumentIds = [...books.keys()].filter(id => registry.getCurrent(id)?.instrument.underlyingId === underlyingId);
    for (let left = 0; left < instrumentIds.length; left++) for (let right = left + 1; right < instrumentIds.length; right++) {
      const a = registry.getCurrent(instrumentIds[left]!)?.instrument;
      const b = registry.getCurrent(instrumentIds[right]!)?.instrument;
      if (!a || !b || a.venue === b.venue) continue;
      const pair = [a, b] as const;
      const strategies: Strategy[] = a.productType === "perpetual" && b.productType === "perpetual"
        ? ["perp_spread", "funding_differential"]
        : a.productType !== b.productType ? ["spot_perp_basis"] : [];
      for (const strategy of strategies) for (const buyIndex of [0, 1]) {
        const legs: EvaluationLeg[] = pair.map((instrument, index) => {
          const side = index === buyIndex ? "buy" : "sell";
          const result = quoteAtNotional(books.get(instrument.instrumentId)!, side, policy.requestedNotionalUsd, at);
          const quote = result.status === "executable" ? (({ status: _status, ...value }) => value)(result) : undefined;
          let projection;
          let fundingSourceExpiresAtMs: number | undefined;
          if (instrument.productType === "perpetual") {
            const observations = funding.get(instrument.instrumentId) ?? [];
            const normalized: NormalizedFunding[] = observations.flatMap(item => {
              const value = normalizeFunding(item, at);
              return value.status === "normalized" ? [value] : [];
            });
            const projected = projectFunding({ side: side === "buy" ? "long" : "short", notionalUsd: policy.requestedNotionalUsd },
              { startMs: at, endMs: at + policy.holdingHorizonMs }, normalized, at);
            if (projected.status === "projected") {
              projection = projected;
              fundingSourceExpiresAtMs = Math.min(...normalized
                .filter(item => projected.sourceObservationIds.includes(item.sourceObservationId as never))
                .map(item => item.sourceTimestampMs + item.freshnessBudgetMs));
            }
          }
          const metadata = books.get(instrument.instrumentId)?.metadata();
          return {
            instrumentId: instrument.instrumentId, side,
            eligibility: quote ? "live" : "reference_only",
            quote, health: health.get(instrument.venue), qualityFlags: metadata ? [...metadata.qualityFlags] : [],
            tradingFeeBps: policy.feesBpsByVenue[instrument.venue],
            slippageBps: policy.slippageBpsByVenue[instrument.venue],
            funding: projection, fundingEvaluatedAtMs: projection ? at : undefined,
            fundingSourceExpiresAtMs,
          };
        });
        const input: EvaluationInput = {
          registry, strategy, underlyingId, nowMs: at,
          requestedNotionalUsd: policy.requestedNotionalUsd,
          minimumNotionalUsd: policy.minimumNotionalUsd,
          minNetEdgeBps: policy.minNetEdgeBps ?? "0",
          synchronizationBudgetMs: policy.synchronizationBudgetMs ?? 2_000,
          maxClockSkewMs: policy.maxClockSkewMs ?? 500,
          calculationVersion: policy.calculationVersion ?? "calc.v1",
          holdingHorizonMs: policy.holdingHorizonMs,
          costs: { financingBps: policy.financingBps, gasAndTransferBps: policy.gasAndTransferBps,
            fxConversionBps: policy.fxConversionBps, uncertaintyBufferBps: policy.uncertaintyBufferBps },
          borrow: policy.borrowByInstrument?.[pair.find(item => item.productType === "tokenized_spot")?.instrumentId ?? ""],
          legs,
        };
        const { opportunity, evidence } = evaluateOpportunityWithEvidence(input);
        if (evidence) await bus.publish("evidence.bundle.v1", opportunity.underlyingId, evidence);
        if ((generations.get(underlyingId) ?? 0) !== generation) return;
        await publish(opportunity);
        if ((generations.get(underlyingId) ?? 0) !== generation) return;
        if (opportunity.status === "actionable") {
          const lifecycle = activeLifecycle(opportunity);
          active.set(opportunity.opportunityId, lifecycle);
          const delay = Math.max(0, Date.parse(opportunity.expiresAt) - now());
          const timer = setTimeout(() => {
            const expired = lifecycle.current(Date.parse(opportunity.expiresAt));
            active.delete(opportunity.opportunityId);
            expiryTimers.delete(opportunity.opportunityId);
            queuePublish(expired);
          }, delay);
          expiryTimers.set(opportunity.opportunityId, timer);
        }
      }
    }
  };
  // Publication/promotion and invalidation acceptance share this fence. If an
  // actionable publish is already in flight, a concurrent invalidation waits;
  // publication and lifecycle registration finish first, then invalidation
  // expires that lifecycle and queues the later event in topic order.
  const evaluate = (underlyingId: string) => withStateFence(() => evaluateUnlocked(underlyingId));
  const schedule = (underlyingId: string) => {
    if (pending.has(underlyingId)) return;
    pending.set(underlyingId, setTimeout(() => {
      pending.delete(underlyingId);
      publishing = publishing.then(() => evaluate(underlyingId));
    }, debounceMs));
  };
  unsubscribe.push(await bus.subscribe("book.state.v1", "opportunity-worker-books", event => withStateFence(async () => {
    const book = books.get(event.instrumentId) ?? new OrderBook();
    const current = book.metadata();
    if (current && (event.eventId === current.eventId || event.sourceTimestamp < current.sourceTimestamp ||
        event.sourceTimestamp === current.sourceTimestamp && event.receivedTimestamp < current.receivedTimestamp)) return;
    expireBook(event.instrumentId);
    book.applySnapshot(event);
    books.set(event.instrumentId, book);
    const underlying = registry.getCurrent(event.instrumentId)?.instrument.underlyingId;
    if (underlying) { bump(underlying); schedule(underlying); }
  })));
  unsubscribe.push(await bus.subscribe("funding.observation.v1", "opportunity-worker-funding", event => withStateFence(async () => {
    const observations = funding.get(event.instrumentId) ?? [];
    let accepted = false;
    if (event.payload.rateType !== "realized") {
      const previous = observations.findIndex(item => item.payload.kind === "funding" &&
        item.payload.nextSettlementMs === event.payload.nextSettlementMs);
      if (previous >= 0) {
        const old = observations[previous]!;
        if (event.sourceTimestamp > old.sourceTimestamp ||
            event.sourceTimestamp === old.sourceTimestamp && event.receivedTimestamp > old.receivedTimestamp) {
          observations[previous] = event;
          accepted = true;
        }
      } else { observations.push(event); accepted = true; }
    }
    if (!accepted) return;
    expireBook(event.instrumentId);
    if (observations.length > 10_000) observations.shift();
    funding.set(event.instrumentId, observations);
    const underlying = registry.getCurrent(event.instrumentId)?.instrument.underlyingId;
    if (underlying) { bump(underlying); schedule(underlying); }
  })));
  unsubscribe.push(await bus.subscribe("venue.health.v1", "opportunity-worker-health", event => withStateFence(async () => {
    health.set(event.venue, event);
    for (const [id, lifecycle] of active) {
      const before = lifecycle.current(now());
      if (before.status !== "actionable" || !before.legs.some(leg => registry.getCurrent(leg.instrumentId)?.instrument.venue === event.venue)) continue;
      const after = lifecycle.onVenueHealth(event);
      if (after.status === "expired") {
        clearTimeout(expiryTimers.get(id)); expiryTimers.delete(id); active.delete(id); queuePublish(after);
      }
    }
    for (const id of books.keys()) {
      const instrument = registry.getCurrent(id)?.instrument;
      if (instrument?.venue === event.venue) { bump(instrument.underlyingId); schedule(instrument.underlyingId); }
    }
  })));
  unsubscribe.push(await bus.subscribe("instrument.registry.v1", "opportunity-worker-registry", event => withStateFence(async () => {
    if (event.kind === "upsert") {
      registry.upsert(event.instrument);
      bump(event.instrument.underlyingId);
      schedule(event.instrument.underlyingId);
    } else {
      expireMapping(event.mapping.underlyingId);
      registry.addReviewedMapping(event.mapping);
      bump(event.mapping.underlyingId);
      schedule(event.mapping.underlyingId);
    }
  })));
  return {
    async flush() {
      const affected = [...pending.keys()];
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await publishing;
      for (const underlying of affected) await evaluate(underlying);
      await publishing;
    },
    async drain() {
      for (;;) {
        if (pending.size > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, debounceMs)));
          continue;
        }
        const publicationSnapshot = publishing;
        await publicationSnapshot;
        await stateFence;
        if (pending.size === 0 && publicationSnapshot === publishing) return;
      }
    },
    async stop() {
      for (const timer of pending.values()) clearTimeout(timer);
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      pending.clear(); expiryTimers.clear(); removeWithdrawal();
      for (const stop of unsubscribe) await stop();
      await publishing;
    },
  };
}
