import { z } from "zod";
import { EvidenceBundleSchema, InstrumentSchema, MarketBoardSnapshotSchema, ObservationEnvelopeSchema, OpportunitySchema, VenueHealthSchema,
  PairEvaluationSnapshotSchema, PositiveDecimalStringSchema, type EvidenceBundle, type Instrument, type MarketBoardSnapshot,
  type ObservationEnvelope, type Opportunity, type PairEvaluationSnapshot } from "@range/domain";
import type { CurrentStateStore, HistoryStore, SqlClient, StoredEvent } from "@range/storage";

export const VenueFilterSchema = z.enum(["bitget", "ondo_stocks", "ondo_perps", "hyperliquid_hip3", "bybit", "qfex", "lighter", "extended", "aster", "variational", "pacifica", "nado", "binance"]);
export const UnderlyingFilterSchema = z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/);
const boundedInt = (max: number) => z.coerce.number().int().min(0).max(max);
export const PageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: boundedInt(900).default(0) }).strict();
export const InstrumentQuerySchema = PageQuerySchema.extend({ underlying: UnderlyingFilterSchema.optional(), venue: VenueFilterSchema.optional() }).strict();
export const MarketQuerySchema = z.object({ underlying: UnderlyingFilterSchema, venue: VenueFilterSchema.optional() }).strict();
export const PairsQuerySchema = z.object({ underlying: UnderlyingFilterSchema.optional() }).strict();
export const FundingCompareQuerySchema = MarketQuerySchema.extend({
  notional_usd: PositiveDecimalStringSchema.and(z.string().max(128)),
  holding_horizon_ms: z.coerce.number().int().min(1).max(86_400_000),
}).strict();
export const MarketOverviewQuerySchema = z.object({}).strict();
export const ScanQuerySchema = PageQuerySchema.extend({ underlying: UnderlyingFilterSchema,
  strategy: z.enum(["perp_spread", "spot_perp_basis", "funding_differential"]).optional(), venue: VenueFilterSchema.optional(),
  min_edge_bps: z.string().max(32).regex(/^-?(0|[1-9]\d*)(\.\d+)?$/).optional(),
  min_capacity_usd: z.string().max(32).regex(/^(0|[1-9]\d*)(\.\d+)?$/).optional(), max_age_ms: boundedInt(86_400_000).optional(),
}).strict();
export const OpportunityParamsSchema = z.object({ id: z.string().max(200).regex(/^opp_[A-Za-z0-9_.:-]+$/) }).strict();
export const StreamQuerySchema = z.object({ underlying: UnderlyingFilterSchema.optional() }).strict();
export const ResumeIdSchema = z.string().max(24).regex(/^evt_(0|[1-9]\d*)$/).refine(value => Number.isSafeInteger(Number(value.slice(4))));
export type InstrumentQuery = z.infer<typeof InstrumentQuerySchema>;
export type ScanQuery = z.infer<typeof ScanQuerySchema>;
export type RequestContext = { traceId: string; clientId: string };
export const VenueViewSchema = z.object({ venue: VenueFilterSchema, capabilities: z.array(z.string()), freshnessBudgetMs: z.number().int().positive(),
  health: VenueHealthSchema.nullable(), asOfMs: z.number().int().nonnegative().nullable() }).strict();
export type VenueView = z.infer<typeof VenueViewSchema>;
export type EventPageItem = { ordinal: number; event: StoredEvent };
export type ObservationTimestamp = { eventId: string; sourceTimestampMs: number; receivedTimestampMs: number };

/** Every read carries its caller trace, including authoritative currentness reads.
 * Adapters must not replace inspectOpportunity with a cache of delivered events. */
export interface ApplicationQueries {
  listVenues(context: RequestContext): Promise<VenueView[]>;
  findInstruments(context: RequestContext, filter: InstrumentQuery): Promise<Instrument[]>;
  getMarketSnapshot(context: RequestContext, filter: z.infer<typeof MarketQuerySchema>): Promise<ObservationEnvelope[]>;
  scanOpportunities(context: RequestContext, filter: ScanQuery): Promise<Opportunity[]>;
  inspectOpportunity(context: RequestContext, id: string): Promise<Opportunity | undefined>;
  getEvidence(context: RequestContext, hash: string): Promise<EvidenceBundle | undefined>;
  getSourceTimestamps(context: RequestContext, eventIds: string[]): Promise<ObservationTimestamp[]>;
  getOpportunityHistory(context: RequestContext, id: string): Promise<Opportunity[]>;
  getAcceptedRevision(context: RequestContext, underlying: string): Promise<number | undefined>;
  readEvents(context: RequestContext, afterOrdinal: number, limit: number): Promise<EventPageItem[]>;
  latestEventOrdinal(context: RequestContext): Promise<number>;
  /** The display board the opportunity worker publishes: latest top of book and funding per instrument. */
  getMarketBoard(context: RequestContext): Promise<MarketBoardSnapshot | undefined>;
  /** The worker's latest evaluation of every reviewed pair, and the reviewed mappings behind them. */
  getPairEvaluations(context: RequestContext): Promise<PairEvaluationSnapshot | undefined>;
}

/** Storage-backed adapter; venue configuration is a public capability manifest,
 * never connector configuration (which may contain access credentials). */
export class StorageQueries implements ApplicationQueries {
  constructor(private readonly current: Pick<CurrentStateStore, "get" | "query" | "queryOpportunities" | "getOpportunity">,
    private readonly history: Pick<HistoryStore, "getEvidence" | "readPage">, private readonly sql: SqlClient,
    private readonly venues: Array<Pick<VenueView, "venue" | "capabilities" | "freshnessBudgetMs">>,
    private readonly trace: (entry: { trace_id: string; operation: string }) => void = () => {}) {
    for (const venue of venues) VenueViewSchema.parse({ ...venue, health: null, asOfMs: null });
  }
  private audit(context: RequestContext, operation: string) {
    if (!/^rng_trace_[A-Za-z0-9-]+$/.test(context.traceId)) throw new Error("Invalid trace ID");
    this.trace({ trace_id: context.traceId, operation });
  }
  async listVenues(context: RequestContext) {
    this.audit(context, "storage.venues");
    return Promise.all(this.venues.map(async venue => {
      const record = await this.current.get<{ health: unknown; asOfMs: number }>(`health:${venue.venue}`);
      return VenueViewSchema.parse({ ...venue, health: record ? VenueHealthSchema.parse(record.value.health) : null,
        asOfMs: record?.value.asOfMs ?? null });
    }));
  }
  async findInstruments(context: RequestContext, filter: InstrumentQuery) {
    this.audit(context, "storage.instruments");
    // Apply pagination after selecting each instrument's latest version.
    const rows = await this.sql.query(`SELECT payload FROM (
      SELECT DISTINCT ON (instrument_id) instrument_id, underlying_id, payload FROM instruments
      ORDER BY instrument_id, metadata_version DESC) latest
      WHERE ($1::text IS NULL OR underlying_id=$1) AND ($2::text IS NULL OR payload->>'venue'=$2)
      ORDER BY instrument_id LIMIT $3 OFFSET $4`, [filter.underlying ?? null, filter.venue ?? null, filter.limit, filter.offset]);
    return rows.rows.map(row => InstrumentSchema.parse(row.payload));
  }
  async getMarketSnapshot(context: RequestContext, filter: z.infer<typeof MarketQuerySchema>) {
    this.audit(context, "storage.market");
    const records = await this.current.query(filter.underlying, 1000);
    return records.filter(item => item.key.startsWith("book:") || item.key.startsWith("funding:"))
      .map(item => ObservationEnvelopeSchema.parse(item.state.value)).filter(item => !filter.venue || item.venue === filter.venue);
  }
  async scanOpportunities(context: RequestContext, filter: ScanQuery) {
    this.audit(context, "storage.scan");
    return this.current.queryOpportunities(filter.underlying, 1000);
  }
  async inspectOpportunity(context: RequestContext, id: string) {
    this.audit(context, "storage.currentness");
    return this.current.getOpportunity(id);
  }
  async getEvidence(context: RequestContext, hash: string) {
    this.audit(context, "storage.evidence");
    const evidence = await this.history.getEvidence(hash);
    return evidence ? EvidenceBundleSchema.parse(evidence) : undefined;
  }
  async getSourceTimestamps(context: RequestContext, ids: string[]) {
    this.audit(context, "storage.source-times");
    const boundedIds = z.array(z.string().max(200).regex(/^evt_[A-Za-z0-9_.:-]+$/)).max(1000).parse([...new Set(ids)]);
    const result = await this.sql.query(`SELECT event_id, source_time, payload->>'receivedTimestamp' AS received_timestamp
      FROM observations WHERE event_id = ANY($1::text[]) ORDER BY event_id LIMIT 1000`, [boundedIds]);
    return result.rows.map(row => {
      const timestamp = { eventId: row.event_id, sourceTimestampMs: new Date(row.source_time).getTime(), receivedTimestampMs: Number(row.received_timestamp) };
      if (!Number.isSafeInteger(timestamp.sourceTimestampMs) || timestamp.sourceTimestampMs < 0 ||
        !Number.isSafeInteger(timestamp.receivedTimestampMs) || timestamp.receivedTimestampMs < timestamp.sourceTimestampMs) {
        throw new Error("Invalid observation timestamps");
      }
      return timestamp;
    });
  }
  async getOpportunityHistory(context: RequestContext, id: string) {
    this.audit(context, "storage.opportunity-history");
    const result = await this.sql.query("SELECT payload FROM opportunities WHERE opportunity_id=$1 ORDER BY state_revision DESC, accepted_at_ms DESC LIMIT 100", [id]);
    return result.rows.map(row => OpportunitySchema.parse(row.payload));
  }
  async getAcceptedRevision(context: RequestContext, underlying: string) {
    this.audit(context, "storage.accepted-revision");
    const result = await this.sql.query("SELECT revision FROM accepted_revisions WHERE underlying_id=$1", [underlying]);
    if (result.rows.length === 0) return undefined;
    const revision = Number(result.rows[0].revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid accepted revision");
    return revision;
  }
  async readEvents(context: RequestContext, afterOrdinal: number, limit: number) {
    this.audit(context, "storage.events");
    return this.history.readPage({ afterOrdinal, limit });
  }
  async getMarketBoard(context: RequestContext) {
    this.audit(context, "storage.market-board");
    const state = await this.current.get("market-board");
    return state ? MarketBoardSnapshotSchema.parse(state.value) : undefined;
  }
  async getPairEvaluations(context: RequestContext) {
    this.audit(context, "storage.pair-evaluations");
    const state = await this.current.get("pair-evaluations");
    return state ? PairEvaluationSnapshotSchema.parse(state.value) : undefined;
  }
  async latestEventOrdinal(context: RequestContext) {
    this.audit(context, "storage.event-cursor");
    const result = await this.sql.query("SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM event_log");
    const ordinal = Number(result.rows[0]?.ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid event cursor");
    return ordinal;
  }
}
