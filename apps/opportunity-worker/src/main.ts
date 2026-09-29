import { randomUUID } from "node:crypto";
import type { EventBus } from "@range/event-bus";
import { isCurrentAtRevision, type ObservationEnvelope, type Opportunity, type VenueHealth } from "@range/domain";
import { InstrumentRegistry } from "@range/instruments";
import { OrderBook, normalizeFunding, projectFunding, quoteAtNotional, type NormalizedFunding } from "@range/market-state";
import { activeLifecycle, evaluateOpportunityWithEvidence, type EvaluationInput, type EvaluationLeg, type Strategy } from "@range/opportunity";
import { createInMemoryRevisionAuthority, type RevisionAuthority } from "./revision-authority.js";

export interface WorkerPolicy {
  runtime?: "production" | "development";
  revisionAuthority?: RevisionAuthority;
  now?: () => number;
  debounceMs?: number;
  /** Inject a clock-aligned scheduler for deterministic event-log replay. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
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
  settle(): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  currentRevision(underlyingId: string): number;
  isCurrent(opportunity: Opportunity): boolean;
}

interface BookCursor {
  eventId: string;
  sourceTimestamp: number;
  receivedTimestamp: number;
  sequencePresent: boolean;
  sequence?: bigint;
  contiguous: boolean;
  gapped: boolean;
}

const DECIMAL_SEQUENCE = /^(?:0|[1-9]\d*)$/;
function bookSequence(value: ObservationEnvelope["sequence"]): bigint | undefined {
  if (value === undefined || typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  return DECIMAL_SEQUENCE.test(text) ? BigInt(text) : undefined;
}

/** Consumes normalized state and evaluates only affected underlyings after a bounded debounce. */
export async function startOpportunityWorker(bus: EventBus, registry: InstrumentRegistry, policy: WorkerPolicy): Promise<OpportunityWorker> {
  const runtime = policy.runtime ?? "production";
  const revisionAuthority = policy.revisionAuthority ??
    (runtime === "development" ? createInMemoryRevisionAuthority() : undefined);
  if (!revisionAuthority || runtime === "production" && revisionAuthority.kind !== "durable") {
    throw new Error("Production opportunity worker requires a durable revision authority");
  }
  const now = policy.now ?? Date.now;
  const scheduleTimer = policy.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  const debounceMs = Math.max(0, Math.min(25, policy.debounceMs ?? 25));
  const books = new Map<string, OrderBook>();
  const bookCursors = new Map<string, BookCursor>();
  const funding = new Map<string, ObservationEnvelope[]>();
  const health = new Map<string, VenueHealth>();
  const pending = new Map<string, () => void>();
  const generations = new Map<string, number>();
  for (const mapping of registry.listReviewedMappings()) {
    try {
      const revision = await revisionAuthority.read(mapping.underlyingId);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid revision");
      generations.set(mapping.underlyingId, revision);
    } catch {
      throw new Error("Revision authority unavailable");
    }
  }
  const expiryTimers = new Map<string, () => void>();
  const active = new Map<string, ReturnType<typeof activeLifecycle>>();
  const unsubscribe: Array<() => Promise<void>> = [];
  let publishing = Promise.resolve();
  let accepting = Promise.resolve();
  let authorityFailed = false;
  const assertAuthority = () => {
    if (authorityFailed) throw new Error("Revision authority unavailable");
  };
  const acceptInput = (operation: () => Promise<void>): Promise<void> => {
    const result = accepting.then(async () => {
      assertAuthority();
      await operation();
    });
    accepting = result.catch(() => {});
    return result;
  };
  const revisionOf = (underlyingId: string) => generations.get(underlyingId) ?? 0;
  const bump = async (underlyingId: string) => {
    let revision: number;
    try {
      revision = await revisionAuthority.advance(underlyingId);
      if (!Number.isSafeInteger(revision) || revision <= revisionOf(underlyingId)) {
        throw new Error(`Revision authority returned a non-increasing revision for ${underlyingId}`);
      }
    } catch (error) {
      authorityFailed = true;
      throw new Error("Revision authority unavailable");
    }
    generations.set(underlyingId, revision);
    return revision;
  };
  const bumpMany = async (underlyingIds: readonly string[]) => {
    if (!underlyingIds.length) return;
    let revisions: ReadonlyMap<string, number>;
    try {
      revisions = await revisionAuthority.advanceMany(underlyingIds);
      for (const underlyingId of underlyingIds) {
        const revision = revisions.get(underlyingId);
        if (revision === undefined || !Number.isSafeInteger(revision) || revision <= revisionOf(underlyingId)) {
          throw new Error(`Revision authority returned a non-increasing revision for ${underlyingId}`);
        }
      }
    } catch (error) {
      authorityFailed = true;
      throw new Error("Revision authority unavailable");
    }
    for (const underlyingId of underlyingIds) generations.set(underlyingId, revisions.get(underlyingId)!);
  };
  const publish = async (opportunity: Opportunity) => {
    await bus.publish("opportunity.v1", opportunity.underlyingId, opportunity);
  };
  const queuePublish = (opportunity: Opportunity) => {
    publishing = publishing.then(() => publish(opportunity));
  };
  const expireInstrument = (instrumentId: string, revision: number) => {
    for (const [id, lifecycle] of active) {
      const before = lifecycle.current(now());
      if (before.status !== "actionable") continue;
      const after = lifecycle.onCapabilityWithdrawal(instrumentId);
      if (after.status === "expired") {
        expiryTimers.get(id)?.(); expiryTimers.delete(id); active.delete(id);
        queuePublish({ ...after, stateRevision: revision });
      }
    }
  };
  const expireBook = (instrumentId: string, revision: number, reason: "STALE_INPUT" | "BOOK_SEQUENCE_GAP" = "STALE_INPUT") => {
    for (const [id, lifecycle] of active) {
      if (lifecycle.current(now()).status !== "actionable") continue;
      const after = reason === "BOOK_SEQUENCE_GAP"
        ? lifecycle.onSequenceGap(instrumentId) : lifecycle.onQuoteWithdrawal(instrumentId);
      if (after.status === "expired") {
        expiryTimers.get(id)?.(); expiryTimers.delete(id); active.delete(id);
        queuePublish({ ...after, stateRevision: revision });
      }
    }
  };
  const expireMapping = (underlyingId: string, revision: number) => {
    for (const [id, lifecycle] of active) {
      if (lifecycle.current(now()).status !== "actionable") continue;
      const after = lifecycle.onMappingWithdrawal(underlyingId);
      if (after.status === "expired") {
        expiryTimers.get(id)?.(); expiryTimers.delete(id); active.delete(id);
        queuePublish({ ...after, stateRevision: revision });
      }
    }
  };
  const evaluateUnlocked = async (underlyingId: string) => {
    await accepting;
    assertAuthority();
    const generation = revisionOf(underlyingId);
    const at = now();
    // Only members of a current reviewed mapping are paired. Any other pair can never be actionable
    // (UNKNOWN_INSTRUMENT_EQUIVALENCE); publishing those rejections swamped the worker and its history writers.
    const reviewed = new Set<string>(registry.resolveEquivalentInstruments(underlyingId).map(item => item.instrument.instrumentId));
    const instruments = [...books.keys()]
      .filter(id => reviewed.has(id) && registry.identityOf(id)?.underlyingId === underlyingId)
      .flatMap(id => { const current = registry.getCurrent(id)?.instrument; return current ? [current] : []; });
    for (let left = 0; left < instruments.length; left++) for (let right = left + 1; right < instruments.length; right++) {
      const a = instruments[left]!;
      const b = instruments[right]!;
      if (a.venue === b.venue) continue;
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
        await accepting;
        assertAuthority();
        if (revisionOf(underlyingId) !== generation) return;
        const versioned: Opportunity = { ...opportunity, stateRevision: generation };
        if (versioned.status === "actionable") {
          const lifecycle = activeLifecycle(versioned);
          active.set(versioned.opportunityId, lifecycle);
          const delay = Math.max(0, Date.parse(versioned.expiresAt) - now());
          expiryTimers.get(versioned.opportunityId)?.();
          const timer = scheduleTimer(() => {
            if (!active.has(versioned.opportunityId)) return;
            const expired = lifecycle.current(Date.parse(versioned.expiresAt));
            active.delete(versioned.opportunityId);
            expiryTimers.delete(versioned.opportunityId);
            queuePublish(expired);
          }, delay);
          expiryTimers.set(versioned.opportunityId, timer);
        }
        await publish(versioned);
        await accepting;
        assertAuthority();
        if (revisionOf(underlyingId) !== generation) return;
      }
    }
  };
  // Input acceptance completes only after the revision authority commits and
  // the handler applies the input. EventBus.publish may await callbacks
  // (in-memory) or only broker ack (Redpanda); output publication never owns
  // the input acceptance queue.
  const evaluate = evaluateUnlocked;
  const schedule = (underlyingId: string) => {
    if (pending.has(underlyingId)) return;
    pending.set(underlyingId, scheduleTimer(() => {
      pending.delete(underlyingId);
      publishing = publishing.then(() => evaluate(underlyingId));
    }, debounceMs));
  };
  unsubscribe.push(await bus.subscribe("book.state.v1", "opportunity-worker-books", event => acceptInput(async () => {
    const book = books.get(event.instrumentId) ?? new OrderBook();
    const current = bookCursors.get(event.instrumentId);
    const sequence = bookSequence(event.sequence);
    const sequencePresent = event.sequence !== undefined;
    const contiguous = event.sequencePolicy === "contiguous";
    const reset = event.sequenceReset === true && contiguous && sequence !== undefined;
    if (current) {
      if (event.eventId === current.eventId || event.sourceTimestamp < current.sourceTimestamp) return;
      if (reset && event.sourceTimestamp <= current.sourceTimestamp) return;
      if (current.gapped && !reset) {
        if (sequence !== undefined && (current.sequence === undefined || sequence > current.sequence)) {
          bookCursors.set(event.instrumentId, { ...current, eventId: event.eventId,
            sourceTimestamp: event.sourceTimestamp, receivedTimestamp: event.receivedTimestamp,
            sequencePresent, sequence });
        }
        return;
      }
      // A sequence regression is stale even if transport receive time advances.
      // Once a feed provides sequence, an unsequenced snapshot cannot silently
      // reset it; a new feed epoch needs an explicit version/reset contract.
      if (!reset && (current.sequencePresent && !sequencePresent ||
          current.sequence !== undefined && sequence !== undefined && sequence <= current.sequence)) return;
      if (!reset && event.sourceTimestamp === current.sourceTimestamp &&
          (current.sequencePresent !== sequencePresent ||
           current.sequencePresent && current.sequence === undefined && sequence !== undefined ||
           (current.sequence === undefined || sequence === undefined) &&
             event.receivedTimestamp < current.receivedTimestamp)) return;
      if (!reset && current.contiguous && contiguous && current.sequence !== undefined && sequence !== undefined &&
          sequence > current.sequence + 1n) {
        const underlying = registry.identityOf(event.instrumentId)?.underlyingId;
        const revision = underlying ? await bump(underlying) : undefined;
        if (revision !== undefined) expireBook(event.instrumentId, revision, "BOOK_SEQUENCE_GAP");
        books.delete(event.instrumentId);
        bookCursors.set(event.instrumentId, { eventId: event.eventId, sourceTimestamp: event.sourceTimestamp,
          receivedTimestamp: event.receivedTimestamp, sequencePresent, sequence, contiguous: true, gapped: true });
        if (underlying) schedule(underlying);
        return;
      }
    }
    const underlying = registry.identityOf(event.instrumentId)?.underlyingId;
    const revision = underlying ? await bump(underlying) : undefined;
    if (revision !== undefined) expireBook(event.instrumentId, revision);
    bookCursors.set(event.instrumentId, { eventId: event.eventId,
      sourceTimestamp: event.sourceTimestamp, receivedTimestamp: event.receivedTimestamp,
      // An opaque sequence invalidates the book but cannot erase the last
      // comparable sequence; otherwise a stale numeric snapshot could revive it.
      sequencePresent, sequence: sequence ?? current?.sequence, contiguous, gapped: false });
    book.applySnapshot(event);
    books.set(event.instrumentId, book);
    if (underlying) schedule(underlying);
  })));
  unsubscribe.push(await bus.subscribe("funding.observation.v1", "opportunity-worker-funding", event => acceptInput(async () => {
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
    const underlying = registry.identityOf(event.instrumentId)?.underlyingId;
    const revision = underlying ? await bump(underlying) : undefined;
    if (revision !== undefined) expireBook(event.instrumentId, revision);
    if (observations.length > 10_000) observations.shift();
    funding.set(event.instrumentId, observations);
    if (underlying) schedule(underlying);
  })));
  unsubscribe.push(await bus.subscribe("venue.health.v1", "opportunity-worker-health", event => acceptInput(async () => {
    health.set(event.venue, event);
    const affected = new Set<string>();
    for (const id of books.keys()) {
      const identity = registry.identityOf(id);
      if (identity?.venue === event.venue) affected.add(identity.underlyingId);
    }
    for (const lifecycle of active.values()) {
      const current = lifecycle.current(now());
      if (current.legs.some(leg => registry.identityOf(leg.instrumentId)?.venue === event.venue)) {
        affected.add(current.underlyingId);
      }
    }
    // One durable statement for the whole fan-out; a venue can carry thousands of underlyings.
    await bumpMany([...affected]);
    for (const underlying of affected) schedule(underlying);
    for (const [id, lifecycle] of active) {
      const before = lifecycle.current(now());
      if (before.status !== "actionable" || !before.legs.some(leg => registry.identityOf(leg.instrumentId)?.venue === event.venue)) continue;
      const after = lifecycle.onVenueHealth(event);
      if (after.status === "expired") {
        expiryTimers.get(id)?.(); expiryTimers.delete(id); active.delete(id);
        queuePublish({ ...after, stateRevision: revisionOf(before.underlyingId) });
      }
    }
  })));
  // The in-memory registry is rebuilt on every start: a fresh group replays the whole registry topic, where a
  // committed group would resume after instruments that only the previous process had consumed. The group is
  // deleted when the worker stops.
  unsubscribe.push(await bus.subscribe("instrument.registry.v1", `opportunity-worker-registry-${randomUUID()}`, event => acceptInput(async () => {
    if (event.kind === "upsert") {
      // Registry validation failures are deterministic for this event; retrying
      // the same record would block every later record in its Redpanda partition.
      let result: ReturnType<InstrumentRegistry["upsert"]>;
      try { result = registry.upsert(event.instrument); }
      catch { return; }
      if (result.status === "stale" || result.status === "unchanged") return;
      const revision = await bump(event.instrument.underlyingId);
      if (result.status === "versioned") {
        books.delete(event.instrument.instrumentId);
        funding.delete(event.instrument.instrumentId);
        expireInstrument(event.instrument.instrumentId, revision);
      }
      schedule(event.instrument.underlyingId);
    } else {
      // A rejected or replayed review is a no-op, not a poisoned consumer
      // offset that Redpanda retries forever.
      try { registry.addReviewedMapping(event.mapping); }
      catch { return; }
      const revision = await bump(event.mapping.underlyingId);
      expireMapping(event.mapping.underlyingId, revision);
      schedule(event.mapping.underlyingId);
    }
  }), { deleteGroupOnStop: true }));
  return {
    currentRevision(underlyingId) { assertAuthority(); return revisionOf(underlyingId); },
    isCurrent(opportunity) {
      if (authorityFailed) return false;
      if (!isCurrentAtRevision(opportunity, revisionOf(opportunity.underlyingId), now())) return false;
      const current = active.get(opportunity.opportunityId)?.current(now());
      return current?.status === "actionable" && current.stateRevision === opportunity.stateRevision &&
        current.evidenceHash === opportunity.evidenceHash;
    },
    async flush() {
      await accepting;
      assertAuthority();
      const affected = [...pending.keys()];
      for (const cancel of pending.values()) cancel();
      pending.clear();
      await publishing;
      for (const underlying of affected) await evaluate(underlying);
      await publishing;
    },
    async settle() {
      await accepting;
      assertAuthority();
      for (;;) {
        const snapshot = publishing;
        await snapshot;
        if (snapshot === publishing) return;
      }
    },
    async drain() {
      for (;;) {
        await accepting;
        assertAuthority();
        if (pending.size > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, debounceMs)));
          continue;
        }
        const publicationSnapshot = publishing;
        await publicationSnapshot;
        if (pending.size === 0 && publicationSnapshot === publishing) return;
      }
    },
    async stop() {
      for (const cancel of pending.values()) cancel();
      for (const cancel of expiryTimers.values()) cancel();
      pending.clear(); expiryTimers.clear();
      for (const stop of unsubscribe) await stop();
      await publishing;
    },
  };
}
