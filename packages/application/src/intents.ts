import { createHash } from "node:crypto";
import { z } from "zod";
import { UnsignedIntentSchema, DecimalStringSchema, ObservationEnvelopeSchema, InstrumentSchema, type Opportunity } from "@range/domain";
import { OrderBook, quoteAtNotional, normalizeFunding, projectFunding } from "@range/market-state";
import type { SqlClient } from "@range/storage";
import { ApplicationError, EnvelopeSchema, RangeApplication } from "./service.js";
import type { RequestContext } from "./queries.js";
import { CreateIntentRequestSchema, IntentParamsSchema, Exact, fail, policy } from "./intent-policy.js";

export const IntentSchema = UnsignedIntentSchema.extend({ intentId: IntentParamsSchema.shape.id,
  preflightEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  economics: z.object({ grossSpreadBps: DecimalStringSchema, expectedFundingBps: DecimalStringSchema, netEdgeBps: DecimalStringSchema }).strict(),
}).strict();
export type Intent = z.infer<typeof IntentSchema>;
export const IntentValidationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), intent: IntentSchema }).strict(),
  z.object({ status: z.literal("changed"), reason: z.literal("ECONOMICS_OR_EVIDENCE_CHANGED"), proposedIntent: IntentSchema }).strict(),
  z.object({ status: z.literal("expired"), reason: z.string() }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string() }).strict(),
]);
export const intentResponseSchemas = { create: EnvelopeSchema.extend({ result: IntentSchema }), validate: EnvelopeSchema.extend({ result: IntentValidationSchema }) };
export type IntentCaller = RequestContext & { scopes: readonly string[] };
type Record = { intent: Intent; fingerprint: string; clientId: string; sourceMs: number; sourceIds: string[]; opportunityDigest: string;
  audit: { clientId: string; traceId: string; action: "intent:create" | "intent:proposal"; recordedAtMs: number } };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fillAtQuantity(book: OrderBook, side: "buy" | "sell", quantity: InstanceType<typeof Exact>) {
  let remaining = quantity;
  let filledNotional = new Exact(0);
  for (const level of book.levels(side)) {
    if (remaining.isZero()) break;
    const taken = Exact.min(remaining, level.quantity);
    filledNotional = filledNotional.plus(taken.times(level.price));
    remaining = remaining.minus(taken);
  }
  if (!remaining.isZero()) fail("INSUFFICIENT_DEPTH");
  return { notional: filledNotional, averagePrice: filledNotional.div(quantity).toFixed() };
}

/** One INSERT persists the immutable intent and caller audit together. Scoped,
 * hashed keys fit the existing global PK without exposing client credentials. */
export class SqlIntentStore {
  constructor(private readonly sql: SqlClient) {}
  async get(key: string): Promise<Record | undefined> {
    const result = await this.sql.query("SELECT payload FROM intents WHERE idempotency_key=$1", [key]);
    return result.rows[0]?.payload;
  }
  async insert(key: string, record: Record): Promise<Record> {
    await this.sql.query(`INSERT INTO intents(idempotency_key, opportunity_id, evidence_hash, expires_at, payload)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, record.intent.opportunityId, record.intent.evidenceHash, record.intent.expiresAt, JSON.stringify(record)]);
    const persisted = await this.get(key);
    if (!persisted) throw new ApplicationError(503, "INTENT_PERSISTENCE_FAILED");
    return persisted;
  }
}

export class IntentService {
  constructor(private readonly application: RangeApplication, private readonly store: SqlIntentStore, private readonly now: () => number = Date.now) {}
  private authorize(caller: IntentCaller) {
    if (!caller.scopes.includes("intent:create")) throw new ApplicationError(403, "INSUFFICIENT_SCOPE");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(caller.clientId) || !/^rng_trace_[A-Za-z0-9-]+$/.test(caller.traceId)) throw new ApplicationError(400, "INVALID_CALLER");
  }
  private async authority(opportunity: Opportunity, caller: IntentCaller) {
    const current = await this.application.queries.inspectOpportunity(caller, opportunity.opportunityId);
    const revision = await this.application.queries.getAcceptedRevision(caller, opportunity.underlyingId);
    if (!current || current.status !== "actionable" || revision !== opportunity.stateRevision ||
        digest(current) !== digest(opportunity) || this.now() >= Date.parse(opportunity.expiresAt)) fail("OPPORTUNITY_NOT_CURRENT");
  }
  private async derive(input: z.infer<typeof CreateIntentRequestSchema>, caller: IntentCaller, key: string) {
    const queries = this.application.queries;
    const opportunity = await queries.inspectOpportunity(caller, input.opportunityId);
    if (!opportunity || opportunity.status !== "actionable") fail("OPPORTUNITY_NOT_CURRENT");
    const evidence = await queries.getEvidence(caller, opportunity.evidenceHash);
    if (!evidence || evidence.evidenceHash !== opportunity.evidenceHash) fail("EVIDENCE_UNAVAILABLE");
    const limits = policy(opportunity, evidence);
    // A reviewed pair's member can be filed under its venue's own underlying (Bitget's bitget:TSLA), and only the reviewed
    // mapping makes it the same stock. Reading the stock's underlying alone left out every Bitget leg.
    const members = (await this.application.reviewedMembers(caller, opportunity.underlyingId))
      .filter(member => opportunity.legs.some(leg => leg.instrumentId === member.instrumentId));
    const underlyings = [...new Set([opportunity.underlyingId, ...members.map(member => member.underlyingId)])];
    const [snapshots, instrumentLists, venues] = await Promise.all([
      Promise.all(underlyings.map(underlying => queries.getMarketSnapshot(caller, { underlying }))),
      Promise.all(underlyings.map(underlying => queries.findInstruments(caller, { underlying, limit: 100, offset: 0 }))),
      queries.listVenues(caller),
    ]);
    if (snapshots.some(items => items.length >= 1000) || instrumentLists.some(items => items.length >= 100)) fail("PREFLIGHT_COVERAGE_INCOMPLETE");
    const observations = snapshots.flat().map(item => ObservationEnvelopeSchema.parse(item));
    const instruments = instrumentLists.flat().map(item => InstrumentSchema.parse(item));
    const now = this.now();
    let deadline = Math.min(now + limits.ttl, Date.parse(opportunity.expiresAt));
    const times: number[] = [];
    const bookTimes: number[] = [];
    const sourceIds = [...evidence.sourceEventIds];
    const sourceFingerprints: unknown[] = [];
    const notional = Exact.min(input.requestedNotionalUsd, opportunity.capacityUsd).toFixed();
    let fundingBps = new Exact(0);
    const prices: { side: string; price: string }[] = [];
    const legs = opportunity.legs.map(leg => {
      const instrument = instruments.find(item => item.instrumentId === leg.instrumentId);
      const member = members.find(item => item.instrumentId === leg.instrumentId);
      if (!instrument || (instrument.underlyingId !== opportunity.underlyingId && instrument.underlyingId !== member?.underlyingId) ||
        ["extended", "variational"].includes(instrument.venue)) fail("UNKNOWN_INSTRUMENT_EQUIVALENCE");
      // A reviewed member was reviewed as an order-book perpetual. Bitget's instruments don't list the capability, and
      // adding it would change the metadata hash their review pins; the venue's capability and a live book are checked below.
      if (!member && !instrument.capabilities.includes("orderbook")) fail("CAPABILITY_WITHDRAWN");
      const venue = venues.find(item => item.venue === instrument.venue);
      if (!venue?.health || venue.health.connectionState !== "connected" || venue.health.sequenceIntegrity !== "consistent" ||
        venue.health.rateLimit.state !== "healthy" || !venue.capabilities.includes("orderbook")) fail("VENUE_DEGRADED");
      if (Math.abs(venue.health.clockSkewMs) > limits.skewBudget) fail("CLOCK_SKEW_EXCEEDED");
      // Venues report health every 30 seconds, so the report's own age says nothing about the books, which are checked
      // below. As in the evaluator, the venue must have heard an event within the quote budget when it reported.
      if (venue.asOfMs === null || venue.asOfMs > now || venue.health.lastEventAgeMs >= Math.min(venue.freshnessBudgetMs, limits.ttl)) fail("STALE_INPUT");
      const used = observations.filter(item => item.instrumentId === instrument.instrumentId);
      const books = used.filter(item => item.payload.kind === "order_book");
      if (books.length !== 1) fail("PREFLIGHT_COVERAGE_INCOMPLETE");
      for (const item of used) {
        // A book must be as fresh as the result's quote; funding keeps its own budget, often minutes, as in the evaluator.
        const budget = item.payload.kind === "order_book" ? Math.min(item.freshnessBudgetMs, limits.ttl) : item.freshnessBudgetMs;
        if (item.venue !== instrument.venue || item.eligibility !== "live" || item.transport === "replay" || item.qualityFlags.length ||
            item.sourceTimestamp > item.receivedTimestamp || item.receivedTimestamp > now || now - item.sourceTimestamp >= budget) fail("STALE_INPUT");
        times.push(item.sourceTimestamp);
        if (item.payload.kind === "order_book") bookTimes.push(item.sourceTimestamp);
        sourceIds.push(item.eventId);
        deadline = Math.min(deadline, item.sourceTimestamp + budget);
        const { rawPayloadRefOrHash: _raw, ...publicSource } = item;
        sourceFingerprints.push(publicSource);
      }
      // Worker canonical order_book events are complete snapshots. Unknown
      // flags (including delta/sequence gaps) fail before reconstruction.
      const book = new OrderBook(); book.applySnapshot(books[0]);
      if (book.levels(leg.side).some(level => !new Exact(level.price).mod(instrument.tickSize).isZero())) fail("INVALID_PRICE_INCREMENT");
      const quote = quoteAtNotional(book, leg.side, notional, now);
      if (quote.status !== "executable" && quote.status !== "partial_fill") fail("INSUFFICIENT_DEPTH");
      if (new Exact(notional).gt(leg.executableQuote.capacityUsd)) fail("INSUFFICIENT_DEPTH");
      const best = book.levels(leg.side)[0].price;
      const maximumPrice = Exact.max(best, quote.worstPrice);
      // Even a fill at the least favorable allowed price stays inside the cap.
      const boundedQuantity = Exact.min(quote.filledQuantity, new Exact(notional).div(maximumPrice));
      const quantity = boundedQuantity.div(instrument.contractMultiplier).div(instrument.lotSize).floor().times(instrument.lotSize);
      if (quantity.lte(0)) fail("INSUFFICIENT_DEPTH");
      const baseQuantity = quantity.times(instrument.contractMultiplier);
      const filled = fillAtQuantity(book, leg.side, baseQuantity);
      if (baseQuantity.times(Exact.min(best, quote.worstPrice)).lt(instrument.minimumNotional) ||
          filled.notional.lt(instrument.minimumNotional)) fail("INSUFFICIENT_DEPTH");
      prices.push({ side: leg.side, price: filled.averagePrice });
      if (instrument.productType === "perpetual") {
        if (!venue.capabilities.some(capability => ["funding", "funding_current", "funding_predicted"].includes(capability))) fail("CAPABILITY_WITHDRAWN");
        const funding = used.filter(item => item.payload.kind === "funding").map(item => normalizeFunding(item, now));
        const projected = projectFunding({ side: leg.side === "buy" ? "long" : "short", notionalUsd: notional },
          { startMs: now, endMs: now + limits.horizon }, funding, now);
        if (projected.status !== "projected" && projected.status !== "no_settlement_due") fail("FUNDING_SEMANTICS_UNKNOWN");
        if (projected.status === "projected") fundingBps = fundingBps.plus(projected.expectedCashflowBps);
        deadline = Math.min(deadline, projected.nextSettlementMs);
      }
      return { legId: leg.legId, instrumentId: leg.instrumentId, side: leg.side, quantity: quantity.toFixed(),
        priceBounds: { minimum: Exact.min(best, quote.worstPrice).toFixed(), maximum: Exact.max(best, quote.worstPrice).toFixed() } };
    });
    // As in the evaluator, the books must agree in time; funding updates on its own schedule.
    if (Math.max(...bookTimes) - Math.min(...bookTimes) > limits.syncBudget) fail("UNSYNCHRONIZED_INPUTS");
    const buy = prices.find(item => item.side === "buy")!.price, sell = prices.find(item => item.side === "sell")!.price;
    const gross = new Exact(sell).minus(buy).div(buy).times(10000);
    const costs = [opportunity.tradingFeesBps, opportunity.slippageBps, opportunity.financingBps, opportunity.gasAndTransferBps, opportunity.fxConversionBps, opportunity.uncertaintyBufferBps];
    const net = costs.reduce((value, cost) => value.minus(cost), gross.plus(fundingBps));
    if (net.lte(limits.minEdge)) fail("NET_EDGE_BELOW_THRESHOLD");
    const economics = { grossSpreadBps: gross.toDecimalPlaces(12).toFixed(), expectedFundingBps: fundingBps.toDecimalPlaces(12).toFixed(), netEdgeBps: net.toDecimalPlaces(12).toFixed() };
    const preflightEvidenceHash = `sha256:${digest([opportunity.evidenceHash, sourceFingerprints, notional, legs, economics, costs])}`;
    const intent = IntentSchema.parse({ opportunityId: opportunity.opportunityId, intentId: `intent_${key}`, constrainedNotionalUsd: notional,
      derivedLegs: legs, createdAt: new Date(now).toISOString(), expiresAt: new Date(deadline).toISOString(), nonAtomicWarning: true,
      preflightChecks: ["fresh_books_and_funding", "current_authoritative_revision", "venue_health_and_capabilities", "price_bounds_and_capacity", "non_atomic_fills"],
      evidenceHash: opportunity.evidenceHash, preflightEvidenceHash, economics, idempotencyKey: input.idempotencyKey });
    await this.authority(opportunity, caller);
    if (this.now() >= deadline) fail("STALE_INPUT");
    return { intent, opportunity, sourceMs: Math.min(...times), sourceIds: [...new Set(sourceIds)] };
  }
  async createUnsignedIntent(input: unknown, caller: IntentCaller): Promise<Intent> {
    this.authorize(caller);
    if (input && typeof input === "object" && "legs" in input) throw new ApplicationError(400, "legs are derived by Range");
    const request = CreateIntentRequestSchema.parse(input);
    const key = digest([caller.clientId, request.idempotencyKey]);
    const fingerprint = digest([request.opportunityId, new Exact(request.requestedNotionalUsd).toFixed()]);
    const prior = await this.store.get(key);
    if (prior) { if (prior.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT"); return IntentSchema.parse(prior.intent); }
    const derived = await this.derive(request, caller, key);
    const record = await this.store.insert(key, { intent: derived.intent, fingerprint, clientId: caller.clientId, sourceMs: derived.sourceMs, sourceIds: derived.sourceIds,
      opportunityDigest: digest(derived.opportunity),
      audit: { clientId: caller.clientId, traceId: caller.traceId, action: "intent:create", recordedAtMs: this.now() } });
    if (record.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
    await this.authority(derived.opportunity, caller);
    if (this.now() >= Date.parse(record.intent.expiresAt)) fail("STALE_INPUT");
    return IntentSchema.parse(record.intent);
  }
  private async owned(id: string, caller: IntentCaller) {
    this.authorize(caller); IntentParamsSchema.parse({ id });
    const record = await this.store.get(id.slice(7));
    if (!record || record.clientId !== caller.clientId) throw new ApplicationError(404, "INTENT_NOT_FOUND");
    return record;
  }
  async validateUnsignedIntent(id: string, caller: IntentCaller): Promise<z.infer<typeof IntentValidationSchema>> {
    const original = await this.owned(id, caller);
    if (this.now() >= Date.parse(original.intent.expiresAt)) return { status: "expired", reason: "TTL_EXPIRED" };
    try {
      const request = CreateIntentRequestSchema.parse({ opportunityId: original.intent.opportunityId, requestedNotionalUsd: original.intent.constrainedNotionalUsd, idempotencyKey: original.intent.idempotencyKey });
      const fresh = await this.derive(request, caller, id.slice(7));
      if (this.now() >= Date.parse(original.intent.expiresAt)) return { status: "expired", reason: "TTL_EXPIRED" };
      const identity = (intent: Intent) => intent.derivedLegs.map(leg => [leg.legId, leg.instrumentId, leg.side]);
      if (digest(identity(fresh.intent)) !== digest(identity(original.intent))) fail("OPPORTUNITY_LEGS_CHANGED");
      if (fresh.intent.preflightEvidenceHash === original.intent.preflightEvidenceHash) return { status: "valid", intent: IntentSchema.parse(original.intent) };
      const key = digest([caller.clientId, id, fresh.intent.preflightEvidenceHash]);
      const proposal = await this.store.insert(key, { ...original, intent: IntentSchema.parse({ ...fresh.intent, intentId: `intent_${key}` }),
        sourceMs: fresh.sourceMs, sourceIds: fresh.sourceIds, opportunityDigest: digest(fresh.opportunity),
        audit: { clientId: caller.clientId, traceId: caller.traceId, action: "intent:proposal", recordedAtMs: this.now() } });
      await this.authority(fresh.opportunity, caller);
      if (this.now() >= Date.parse(proposal.intent.expiresAt)) return { status: "expired", reason: "STALE_INPUT" };
      return { status: "changed", reason: "ECONOMICS_OR_EVIDENCE_CHANGED", proposedIntent: IntentSchema.parse(proposal.intent) };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.statusCode >= 500) throw error;
      return { status: error.code === "STALE_INPUT" ? "expired" : "rejected", reason: error.code };
    }
  }
  async response(result: Intent | z.infer<typeof IntentValidationSchema>, caller: IntentCaller, id: string) {
    const record = await this.owned(id, caller);
    let final = result;
    const warnings = ["non_atomic_fills", "mandatory_preflight_before_handoff"];
    // Idempotent create replays the original object even after its TTL. Surface
    // that object as non-actionable without changing the validation contract.
    if (!("status" in result) && this.now() >= Date.parse(result.expiresAt)) {
      warnings.push("intent_expired_no_handoff");
    } else if (!("status" in result) || result.status === "valid" || result.status === "changed") {
      const active = "status" in result ? result.status === "valid" ? result.intent : result.proposedIntent : result;
      const current = await this.application.queries.inspectOpportunity(caller, active.opportunityId);
      const revision = current && await this.application.queries.getAcceptedRevision(caller, current.underlyingId);
      const currentAuthority = current?.status === "actionable" && revision === current.stateRevision &&
        digest(current) === record.opportunityDigest && current.evidenceHash === active.evidenceHash &&
        this.now() < Date.parse(current.expiresAt);
      if (this.now() >= Date.parse(active.expiresAt)) {
        if (!("status" in result)) warnings.push("intent_expired_no_handoff");
        else final = { status: "expired", reason: "TTL_EXPIRED" };
      } else if (!currentAuthority) {
        if (!("status" in result)) warnings.push("intent_not_current_no_handoff");
        else final = { status: "rejected", reason: "OPPORTUNITY_NOT_CURRENT" };
      }
    }
    const status = "status" in final ? final.status === "valid" ? "ok" : "partial" : warnings.length > 2 ? "partial" : "ok";
    return this.application.envelope(caller, final, record.sourceMs, record.sourceIds, warnings, status);
  }
}
