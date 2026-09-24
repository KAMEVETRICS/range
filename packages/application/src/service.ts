import { z } from "zod";
import { Decimal } from "decimal.js";
import { InstrumentSchema, ObservationEnvelopeSchema, OpportunitySchema, type Opportunity } from "@range/domain";
import { InstrumentQuerySchema, MarketQuerySchema, OpportunityParamsSchema, PageQuerySchema, ScanQuerySchema, VenueViewSchema,
  type ApplicationQueries, type EventPageItem, type RequestContext } from "./queries.js";

// Deliberately omit free-form connector metadata and private raw-payload locators.
export const PublicInstrumentSchema = z.union([InstrumentSchema.options[0].omit({ metadata: true }), InstrumentSchema.options[1].omit({ metadata: true })]);
export const PublicObservationSchema = ObservationEnvelopeSchema.omit({ rawPayloadRefOrHash: true });
export const EnvelopeSchema = z.object({ status: z.enum(["ok", "partial", "rejected"]), as_of: z.iso.datetime(),
  freshness: z.object({ oldest_input_ms: z.number().int().nonnegative() }).strict(), result: z.unknown(),
  evidence: z.array(z.object({ event_id: z.string().regex(/^evt_[A-Za-z0-9_.:-]+$/) }).strict()),
  warnings: z.array(z.string()), trace_id: z.string().regex(/^rng_trace_[A-Za-z0-9-]+$/) }).strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;
const page = (items: z.ZodType) => z.object({ items: z.array(items).max(100), next_offset: z.number().int().nullable() }).strict();
const HistorySummarySchema = z.object({ state_revision: z.number().int(), status: z.string(), rejection_reasons: z.array(z.string()) }).strict();
export const responseSchemas = {
  venues: EnvelopeSchema.extend({ result: page(VenueViewSchema) }),
  instruments: EnvelopeSchema.extend({ result: page(PublicInstrumentSchema) }),
  markets: EnvelopeSchema.extend({ result: z.object({ underlying: z.string(), observations: z.array(PublicObservationSchema).max(1000) }).strict() }),
  opportunities: EnvelopeSchema.extend({ result: page(OpportunitySchema) }),
  opportunity: EnvelopeSchema.extend({ result: z.object({ opportunity: OpportunitySchema, rejection_history: z.array(HistorySummarySchema).max(100) }).strict() }),
  invalidation: EnvelopeSchema.extend({ result: z.object({ opportunity_id: z.string(), current: z.literal(false) }).strict() }),
  health: EnvelopeSchema.extend({ result: VenueViewSchema }),
  error: EnvelopeSchema.extend({ result: z.object({ code: z.string() }).strict() }),
};
export class ApplicationError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}

export class RangeApplication {
  constructor(readonly queries: ApplicationQueries, private readonly now: () => number = Date.now) {}
  envelope(context: RequestContext, result: unknown, sourceMs = this.now(), evidence: string[] = [], warnings: string[] = [], status: Envelope["status"] = "ok"): Envelope {
    if (!Number.isFinite(sourceMs) || sourceMs > this.now()) throw new ApplicationError(503, "INVALID_SOURCE_TIME");
    return EnvelopeSchema.parse({ status, as_of: new Date(sourceMs).toISOString(), freshness: { oldest_input_ms: Math.max(0, this.now() - sourceMs) },
      result, evidence: [...new Set(evidence)].map(event_id => ({ event_id })), warnings: [...new Set(warnings)], trace_id: context.traceId });
  }
  error(context: RequestContext, code: string) { return this.envelope(context, { code }, this.now(), [], [], "rejected"); }
  async listVenues(input: unknown, context: RequestContext) {
    const query = PageQuerySchema.parse(input);
    const venues = await this.queries.listVenues(context);
    const items = venues.slice(query.offset, query.offset + query.limit);
    const warnings = this.venueWarnings(items);
    return responseSchemas.venues.parse(this.envelope(context, { items, next_offset: query.offset + query.limit < venues.length ? query.offset + query.limit : null },
      Math.min(this.now(), ...items.flatMap(item => item.asOfMs === null ? [] : [item.asOfMs])), [], warnings, warnings.length ? "partial" : "ok"));
  }
  async findInstruments(input: unknown, context: RequestContext) {
    const query = InstrumentQuerySchema.parse(input);
    const instruments = await this.queries.findInstruments(context, query);
    const items = instruments.map(({ metadata: _metadata, ...instrument }) => instrument);
    return responseSchemas.instruments.parse(this.envelope(context, { items, next_offset: items.length === query.limit && query.offset + query.limit <= 900 ? query.offset + query.limit : null },
      Math.min(this.now(), ...instruments.map(item => Date.parse(item.effectiveFrom)))));
  }
  private venueWarnings(venues: Awaited<ReturnType<ApplicationQueries["listVenues"]>>) {
    return venues.flatMap(venue => !venue.health ? [`${venue.venue}: venue missing`] :
      venue.health.connectionState !== "connected" || venue.health.sequenceIntegrity !== "consistent" || venue.health.rateLimit.state !== "healthy"
        ? [`${venue.venue}: venue degraded`] : []);
  }
  async getMarketSnapshot(input: unknown, context: RequestContext) {
    const query = MarketQuerySchema.parse(input);
    const [observations, venues] = await Promise.all([this.queries.getMarketSnapshot(context, query), this.queries.listVenues(context)]);
    const warnings = this.venueWarnings(venues.filter(venue => !query.venue || venue.venue === query.venue));
    const live = observations.filter(item => {
      const age = this.now() - item.sourceTimestamp;
      if (age < 0 || age > item.freshnessBudgetMs || item.eligibility !== "live") { warnings.push(`${item.venue}: stale or reference input excluded`); return false; }
      return true;
    });
    for (const venue of venues.filter(item => !query.venue || item.venue === query.venue)) {
      if (!live.some(item => item.venue === venue.venue)) warnings.push(`${venue.venue}: market data missing`);
    }
    if (observations.length === 1000) warnings.push("market result truncated at 1000 inputs");
    return responseSchemas.markets.parse(this.envelope(context, { underlying: query.underlying, observations: live.map(({ rawPayloadRefOrHash: _raw, ...item }) => item) },
      Math.min(this.now(), ...live.map(item => item.sourceTimestamp)), live.map(item => item.eventId), warnings, warnings.length ? "partial" : "ok"));
  }
  private async details(context: RequestContext, opportunity: Opportunity) {
    if (!opportunity.evidenceHash) throw new ApplicationError(503, "EVIDENCE_UNAVAILABLE");
    const evidence = await this.queries.getEvidence(context, opportunity.evidenceHash);
    if (!evidence || evidence.evidenceHash !== opportunity.evidenceHash) throw new ApplicationError(503, "EVIDENCE_UNAVAILABLE");
    const sourceIds = [...new Set(evidence.sourceEventIds)];
    const times = await this.queries.getSourceTimestamps(context, sourceIds);
    if (times.length !== sourceIds.length) throw new ApplicationError(503, "SOURCE_TIMES_UNAVAILABLE");
    const sourceMs = Math.min(...times);
    if (sourceMs > this.now() || !Number.isFinite(sourceMs)) throw new ApplicationError(503, "INVALID_SOURCE_TIME");
    return { sourceMs, evidence, opportunity: OpportunitySchema.parse({ ...opportunity, freshness: { ...opportunity.freshness, oldestInputMs: this.now() - sourceMs } }) };
  }
  private async current(context: RequestContext, candidate: Opportunity) {
    const current = await this.queries.inspectOpportunity(context, candidate.opportunityId);
    return current && current.status === "actionable" && current.stateRevision === candidate.stateRevision &&
      current.evidenceHash === candidate.evidenceHash && this.now() < Date.parse(current.expiresAt) ? OpportunitySchema.parse(current) : undefined;
  }
  async scanOpportunities(input: unknown, context: RequestContext) {
    const query = ScanQuerySchema.parse(input);
    const candidates = await this.queries.scanOpportunities(context, query);
    const instruments = query.venue ? await this.queries.findInstruments(context, { underlying: query.underlying, venue: query.venue, limit: 100, offset: 0 }) : [];
    const warnings: string[] = candidates.length >= 1000 ? ["scan truncated at 1000 current candidates"] : [];
    const selected = candidates.filter(item => item.underlyingId === query.underlying && (!query.strategy || item.strategy === query.strategy) &&
      (!query.min_edge_bps || new Decimal(item.netEdgeBps).gte(query.min_edge_bps)) && (!query.min_capacity_usd || new Decimal(item.capacityUsd).gte(query.min_capacity_usd)) &&
      (!query.venue || item.legs.some(leg => instruments.some(instrument => instrument.instrumentId === leg.instrumentId))));
    const valid = [];
    for (const item of selected) {
      const detail = await this.details(context, item);
      if (query.max_age_ms !== undefined && this.now() - detail.sourceMs > query.max_age_ms) continue;
      valid.push(detail);
    }
    const page = valid.slice(query.offset, query.offset + query.limit);
    const items: Opportunity[] = [];
    const evidence: string[] = [], times: number[] = [];
    for (const detail of page) {
      if (!await this.current(context, detail.opportunity)) { warnings.push("opportunity changed during read; excluded"); continue; }
      items.push(detail.opportunity); times.push(detail.sourceMs); evidence.push(...detail.evidence.sourceEventIds); warnings.push(...detail.evidence.warnings);
    }
    return responseSchemas.opportunities.parse(this.envelope(context, { items, next_offset: query.offset + query.limit < valid.length && query.offset + query.limit <= 900 ? query.offset + query.limit : null },
      Math.min(this.now(), ...times), evidence, warnings, warnings.some(warning => /excluded|truncated/.test(warning)) ? "partial" : "ok"));
  }
  async inspectOpportunity(input: unknown, context: RequestContext) {
    const { id } = OpportunityParamsSchema.parse(input);
    const current = await this.queries.inspectOpportunity(context, id);
    const history = await this.queries.getOpportunityHistory(context, id);
    // Rejected calculations remain inspectable for research. Only the durable
    // current-state path can supply an actionable calculation.
    const opportunity = current ?? (history[0]?.status === "rejected" ? history[0] : undefined);
    if (!opportunity) throw new ApplicationError(404, "OPPORTUNITY_NOT_CURRENT");
    const detail = await this.details(context, opportunity);
    if (opportunity.status === "actionable" && !await this.current(context, opportunity)) throw new ApplicationError(404, "OPPORTUNITY_NOT_CURRENT");
    const rejection_history = history.map(item => ({ state_revision: item.stateRevision, status: item.status === "actionable" ? "historical" : item.status, rejection_reasons: item.rejectionReasons }));
    return responseSchemas.opportunity.parse(this.envelope(context, { opportunity: detail.opportunity, rejection_history }, detail.sourceMs, detail.evidence.sourceEventIds,
      detail.evidence.warnings, opportunity.status === "rejected" ? "rejected" : "ok"));
  }
  async streamEvent(item: EventPageItem, context: RequestContext): Promise<{ event: "opportunity" | "health"; body: Envelope } | undefined> {
    if (item.event.topic === "opportunity.v1") {
      const candidate = OpportunitySchema.parse(item.event.payload);
      const current = await this.current(context, candidate);
      if (!current) return { event: "opportunity", body: responseSchemas.invalidation.parse(this.envelope(context,
        { opportunity_id: candidate.opportunityId, current: false }, this.now(), [], ["historical or expired opportunity; not current"], "partial")) };
      // Reuse REST inspection, including a second currentness check after evidence reads.
      try { return { event: "opportunity", body: await this.inspectOpportunity({ id: current.opportunityId }, context) }; }
      catch (error) {
        if (!(error instanceof ApplicationError) || error.statusCode !== 404) throw error;
        return { event: "opportunity", body: this.envelope(context, { opportunity_id: candidate.opportunityId, current: false }, this.now(), [], ["opportunity changed during read"], "partial") };
      }
    }
    if (item.event.topic === "venue.health.v1") {
      const payload = item.event.payload as { venue: string };
      const venue = (await this.queries.listVenues(context)).find(venue => venue.venue === payload.venue);
      if (!venue) return undefined;
      const warnings = this.venueWarnings([venue]);
      return { event: "health", body: responseSchemas.health.parse(this.envelope(context, venue, venue.asOfMs ?? this.now(), [item.event.eventId], warnings, warnings.length ? "partial" : "ok")) };
    }
    return undefined;
  }
}
