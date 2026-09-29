import { z } from "zod";
import { Decimal } from "decimal.js";
import { FundingProjectionSchema, InstrumentSchema, ObservationEnvelopeSchema, OpportunitySchema, VenueHealthSchema, type Opportunity } from "@range/domain";
import { normalizeFunding, projectFunding } from "@range/market-state";
import { FundingCompareQuerySchema, InstrumentQuerySchema, MarketOverviewQuerySchema, MarketQuerySchema, OpportunityParamsSchema, PageQuerySchema,
  ScanQuerySchema, VenueViewSchema, type ApplicationQueries, type EventPageItem, type RequestContext } from "./queries.js";
import { buildMarketOverview, MarketOverviewRowSchema, type MarketOverviewRow } from "./market-overview.js";

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
const MAX_EVIDENCE_SOURCE_IDS = 1000;
/** Connectors republish unchanged venue health at least every 30 s while the venue sends events, so a health record
 * older than two of those intervals means its feed has stopped. Observations keep their own freshness budgets. */
const HEALTH_STALE_AFTER_MS = 60_000;
const QuoteTimestampSchema = z.object({ event_id: z.string().regex(/^evt_[A-Za-z0-9_.:-]+$/), source_timestamp_ms: z.number().int().nonnegative(),
  received_timestamp_ms: z.number().int().nonnegative() }).strict().refine(value => value.received_timestamp_ms >= value.source_timestamp_ms);
const FundingOutcomeSchema = z.union([FundingProjectionSchema,
  z.object({ status: z.literal("partial"), reason: z.literal("MISSING_SETTLEMENT_COVERAGE"), missingSettlementMs: z.number().int() }).strict(),
  z.object({ status: z.literal("no_settlement_due"), nextSettlementMs: z.number().int() }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string().max(100) }).strict()]);
export const responseSchemas = {
  venues: EnvelopeSchema.extend({ result: page(VenueViewSchema) }),
  instruments: EnvelopeSchema.extend({ result: page(PublicInstrumentSchema) }),
  markets: EnvelopeSchema.extend({ result: z.object({ underlying: z.string(), observations: z.array(PublicObservationSchema).max(1000) }).strict() }),
  funding: EnvelopeSchema.extend({ result: z.object({ underlying: z.string(), notional_usd: z.string(), holding_horizon_ms: z.number().int(),
    comparisons: z.array(z.object({ venue: z.string(), instrument_id: z.string(), long: FundingOutcomeSchema, short: FundingOutcomeSchema }).strict()).max(100) }).strict() }),
  opportunities: EnvelopeSchema.extend({ result: page(OpportunitySchema).extend({ quote_timestamps: z.array(QuoteTimestampSchema).max(1000) }).strict() }),
  opportunity: EnvelopeSchema.extend({ result: z.object({ opportunity: OpportunitySchema, rejection_history: z.array(HistorySummarySchema).max(100),
    quote_timestamps: z.array(QuoteTimestampSchema).max(1000) }).strict() }),
  invalidation: EnvelopeSchema.extend({ result: z.object({ opportunity_id: z.string(), current: z.literal(false) }).strict() }),
  health: EnvelopeSchema.extend({ result: VenueViewSchema }),
  marketOverview: EnvelopeSchema.extend({ result: z.object({ board_as_of_ms: z.number().int().nullable(),
    matching: z.literal("ticker_unreviewed"), rows: z.array(MarketOverviewRowSchema).max(2000) }).strict() }),
  error: EnvelopeSchema.extend({ result: z.object({ code: z.string() }).strict() }),
};
export class ApplicationError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}

export class RangeApplication {
  constructor(readonly queries: ApplicationQueries, private readonly now: () => number = Date.now) {}
  private overview?: { readAtMs: number; asOfMs: number | null; rows: MarketOverviewRow[] };
  envelope(context: RequestContext, result: unknown, sourceMs = this.now(), evidence: string[] = [], warnings: string[] = [], status: Envelope["status"] = "ok"): Envelope {
    if (!Number.isFinite(sourceMs) || sourceMs > this.now()) throw new ApplicationError(503, "INVALID_SOURCE_TIME");
    return EnvelopeSchema.parse({ status, as_of: new Date(sourceMs).toISOString(), freshness: { oldest_input_ms: Math.max(0, this.now() - sourceMs) },
      result, evidence: [...new Set(evidence)].map(event_id => ({ event_id })), warnings: [...new Set(warnings)], trace_id: context.traceId });
  }
  error(context: RequestContext, code: string) { return this.envelope(context, { code }, this.now(), [], [], "rejected"); }
  /**
   * Latest prices and funding per stock across venues, matched by ticker without a reviewed mapping: display only,
   * never an opportunity. The worker republishes the board every 2 s; one read serves every caller for a second, and
   * rows are rebuilt only for a new board, with ages measured at the board's own time.
   */
  async getMarketOverview(input: unknown, context: RequestContext) {
    MarketOverviewQuerySchema.parse(input);
    const now = this.now();
    if (!this.overview || now - this.overview.readAtMs >= 1_000) {
      const board = await this.queries.getMarketBoard(context);
      const rows = !board ? [] : board.asOfMs === this.overview?.asOfMs ? this.overview.rows : buildMarketOverview(board, board.asOfMs);
      this.overview = { readAtMs: now, asOfMs: board?.asOfMs ?? null, rows };
    }
    const { asOfMs, rows } = this.overview;
    const warnings = asOfMs === null ? ["market board unavailable"] : now - asOfMs > 30_000 ? ["market board stale"] : [];
    return responseSchemas.marketOverview.parse(this.envelope(context, { board_as_of_ms: asOfMs, matching: "ticker_unreviewed", rows },
      Math.min(now, asOfMs ?? now), [], warnings, warnings.length ? "partial" : "ok"));
  }
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
    return venues.flatMap(venue => {
      if (!venue.health) return [`${venue.venue}: venue missing`];
      const warnings: string[] = [];
      if (venue.health.connectionState !== "connected" || venue.health.sequenceIntegrity !== "consistent" ||
        venue.health.rateLimit.state !== "healthy") warnings.push(`${venue.venue}: venue degraded`);
      if (venue.asOfMs === null || venue.asOfMs > this.now() || this.now() - venue.asOfMs > HEALTH_STALE_AFTER_MS ||
        venue.health.lastEventAgeMs > venue.freshnessBudgetMs) warnings.push(`${venue.venue}: venue stale`);
      return warnings;
    });
  }
  private async marketCoverage(context: RequestContext, underlying: string, selectedVenue?: z.infer<typeof MarketQuerySchema>["venue"]) {
    const [observations, allVenues] = await Promise.all([
      this.queries.getMarketSnapshot(context, { underlying, venue: selectedVenue }), this.queries.listVenues(context),
    ]);
    const venues = allVenues.filter(venue => !selectedVenue || venue.venue === selectedVenue);
    const warnings = this.venueWarnings(venues);
    if (selectedVenue && !venues.length) warnings.push(`${selectedVenue}: venue missing`);
    if (!selectedVenue && !venues.length) warnings.push("venue coverage unavailable");
    const live = observations.filter(item => {
      const age = this.now() - item.sourceTimestamp;
      if (age < 0 || age > item.freshnessBudgetMs || item.eligibility !== "live") {
        warnings.push(`${item.venue}: stale or reference input excluded`); return false;
      }
      return true;
    });
    for (const venue of venues) if (!live.some(item => item.venue === venue.venue)) warnings.push(`${venue.venue}: market data missing`);
    if (observations.length === 1000) warnings.push("market result truncated at 1000 inputs");
    const sourceMs = Math.min(this.now(), ...observations.map(item => item.sourceTimestamp).filter(time => time <= this.now()),
      ...venues.flatMap(venue => venue.asOfMs !== null && venue.asOfMs <= this.now() ? [venue.asOfMs] : []));
    return { live, warnings, sourceMs };
  }
  async getMarketSnapshot(input: unknown, context: RequestContext) {
    const query = MarketQuerySchema.parse(input);
    const { live, warnings, sourceMs } = await this.marketCoverage(context, query.underlying, query.venue);
    return responseSchemas.markets.parse(this.envelope(context, { underlying: query.underlying, observations: live.map(({ rawPayloadRefOrHash: _raw, ...item }) => item) },
      sourceMs, live.map(item => item.eventId), warnings, warnings.length ? "partial" : "ok"));
  }
  async compareFunding(input: unknown, context: RequestContext) {
    const query = FundingCompareQuerySchema.parse(input);
    const now = this.now();
    const coverage = await this.marketCoverage(context, query.underlying, query.venue);
    const warnings = [...coverage.warnings];
    const groups = new Map<string, ReturnType<typeof normalizeFunding>[]>();
    for (const observation of coverage.live.filter(item => item.payload.kind === "funding")) {
      const normalized = normalizeFunding(observation, now);
      if (normalized.status === "rejected") { warnings.push(`${observation.venue}: ${normalized.reason}`); continue; }
      const key = `${normalized.venue}:${normalized.instrumentId}`;
      groups.set(key, [...(groups.get(key) ?? []), normalized]);
    }
    if (groups.size > 100) warnings.push("funding comparison truncated at 100 instruments");
    if (!groups.size) warnings.push("funding coverage unavailable");
    const comparisons = [...groups.values()].slice(0, 100).map(records => {
      const valid = records.filter(item => item.status === "normalized");
      const first = valid[0]!;
      const window = { startMs: now, endMs: now + query.holding_horizon_ms };
      const long = projectFunding({ side: "long", notionalUsd: query.notional_usd }, window, valid, now);
      const short = projectFunding({ side: "short", notionalUsd: query.notional_usd }, window, valid, now);
      if (long.status === "rejected" || long.status === "partial") warnings.push(`${first.venue}: ${long.reason}`);
      return { venue: first.venue, instrument_id: first.instrumentId, long, short };
    });
    const sources = [...groups.values()].flat().filter(item => item.status === "normalized");
    return responseSchemas.funding.parse(this.envelope(context, { underlying: query.underlying, notional_usd: query.notional_usd,
      holding_horizon_ms: query.holding_horizon_ms, comparisons }, Math.min(coverage.sourceMs, ...sources.map(item => item.sourceTimestampMs)),
    sources.map(item => item.sourceObservationId), warnings, warnings.length ? "partial" : "ok"));
  }
  private async details(context: RequestContext, opportunity: Opportunity) {
    if (!opportunity.evidenceHash) throw new ApplicationError(503, "EVIDENCE_UNAVAILABLE");
    const evidence = await this.queries.getEvidence(context, opportunity.evidenceHash);
    if (!evidence || evidence.evidenceHash !== opportunity.evidenceHash) throw new ApplicationError(503, "EVIDENCE_UNAVAILABLE");
    const sourceIds = [...new Set(evidence.sourceEventIds)];
    if (sourceIds.length > MAX_EVIDENCE_SOURCE_IDS) throw new ApplicationError(503, "SOURCE_TIMES_UNAVAILABLE");
    const times = await this.queries.getSourceTimestamps(context, sourceIds);
    if (times.length !== sourceIds.length || times.some(item => !sourceIds.includes(item.eventId)) || new Set(times.map(item => item.eventId)).size !== sourceIds.length) {
      throw new ApplicationError(503, "SOURCE_TIMES_UNAVAILABLE");
    }
    const quoteIds = new Set<string>(opportunity.legs.map(leg => leg.executableQuote.sourceBookEventId));
    const quoteTimes = times.filter(item => quoteIds.has(item.eventId));
    if (quoteTimes.length !== quoteIds.size) throw new ApplicationError(503, "SOURCE_TIMES_UNAVAILABLE");
    const now = this.now();
    if (times.some(item => !Number.isSafeInteger(item.sourceTimestampMs) || item.sourceTimestampMs < 0 ||
      !Number.isSafeInteger(item.receivedTimestampMs) || item.receivedTimestampMs < item.sourceTimestampMs || item.receivedTimestampMs > now)) {
      throw new ApplicationError(503, "INVALID_SOURCE_TIME");
    }
    const sourceMs = Math.min(...times.map(item => item.sourceTimestampMs));
    if (!Number.isFinite(sourceMs)) throw new ApplicationError(503, "INVALID_SOURCE_TIME");
    const quoteTimestamps = quoteTimes.map(item => ({ event_id: item.eventId, source_timestamp_ms: item.sourceTimestampMs, received_timestamp_ms: item.receivedTimestampMs }));
    return { sourceMs, evidence, quoteTimestamps, opportunity: OpportunitySchema.parse({ ...opportunity, freshness: { ...opportunity.freshness, oldestInputMs: this.now() - sourceMs } }) };
  }
  private async current(context: RequestContext, candidate: Opportunity) {
    const current = await this.queries.inspectOpportunity(context, candidate.opportunityId);
    return current && current.status === "actionable" && current.stateRevision === candidate.stateRevision &&
      current.evidenceHash === candidate.evidenceHash && this.now() < Date.parse(current.expiresAt) ? OpportunitySchema.parse(current) : undefined;
  }
  async scanOpportunities(input: unknown, context: RequestContext) {
    const query = ScanQuerySchema.parse(input);
    const [candidates, coverage] = await Promise.all([this.queries.scanOpportunities(context, query),
      this.marketCoverage(context, query.underlying, query.venue)]);
    const instruments = query.venue ? await this.queries.findInstruments(context, { underlying: query.underlying, venue: query.venue, limit: 100, offset: 0 }) : [];
    const warnings: string[] = [...coverage.warnings, ...(candidates.length >= 1000 ? ["scan truncated at 1000 current candidates"] : [])];
    const selected = candidates.filter(item => item.underlyingId === query.underlying && (!query.strategy || item.strategy === query.strategy) &&
      (!query.min_edge_bps || new Decimal(item.netEdgeBps).gte(query.min_edge_bps)) && (!query.min_capacity_usd || new Decimal(item.capacityUsd).gte(query.min_capacity_usd)) &&
      (!query.venue || item.legs.some(leg => instruments.some(instrument => instrument.instrumentId === leg.instrumentId))));
    const valid = [];
    for (const item of selected) {
      const detail = await this.details(context, item);
      if (query.max_age_ms !== undefined && this.now() - detail.sourceMs > query.max_age_ms) {
        warnings.push(`${item.opportunityId}: stale opportunity excluded`); continue;
      }
      valid.push(detail);
    }
    const page = valid.slice(query.offset, query.offset + query.limit);
    const checked: typeof page = [];
    for (const detail of page) {
      if (!await this.current(context, detail.opportunity)) { warnings.push("opportunity changed during read; excluded"); continue; }
      checked.push(detail);
    }
    let verified = checked;
    if (checked.length) {
      const revision = await this.queries.getAcceptedRevision(context, query.underlying);
      if (revision === undefined) throw new ApplicationError(503, "REVISION_UNAVAILABLE");
      verified = checked.filter(detail => detail.opportunity.stateRevision === revision);
      if (verified.length !== checked.length) warnings.push("opportunity changed during read; excluded");
    }
    const items = verified.map(detail => detail.opportunity);
    const evidence = verified.flatMap(detail => detail.evidence.sourceEventIds);
    const times = verified.map(detail => detail.sourceMs);
    warnings.push(...verified.flatMap(detail => detail.evidence.warnings));
    const quote_timestamps = [...new Map(verified.flatMap(detail => detail.quoteTimestamps).map(item => [item.event_id, item])).values()];
    return responseSchemas.opportunities.parse(this.envelope(context, { items, quote_timestamps, next_offset: query.offset + query.limit < valid.length && query.offset + query.limit <= 900 ? query.offset + query.limit : null },
      Math.min(coverage.sourceMs, ...times), evidence, warnings,
      coverage.warnings.length || warnings.some(warning => /excluded|truncated/.test(warning)) ? "partial" : "ok"));
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
    return responseSchemas.opportunity.parse(this.envelope(context, { opportunity: detail.opportunity, rejection_history, quote_timestamps: detail.quoteTimestamps }, detail.sourceMs, detail.evidence.sourceEventIds,
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
      const health = VenueHealthSchema.parse(item.event.payload);
      const venue = (await this.queries.listVenues(context)).find(venue => venue.venue === health.venue);
      if (!venue) return undefined;
      const historical = { ...venue, health, asOfMs: item.event.acceptedAtMs };
      const warnings = this.venueWarnings([historical]);
      return { event: "health", body: responseSchemas.health.parse(this.envelope(context, historical, item.event.acceptedAtMs,
        [item.event.eventId], warnings, warnings.length ? "partial" : "ok")) };
    }
    return undefined;
  }
}
