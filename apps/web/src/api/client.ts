import { subscribeToRangeStream } from "./sse.js";

export type EnvelopeStatus = "ok" | "partial" | "rejected";
export type OpportunityStatus = "actionable" | "rejected" | "observed" | "validated" | "intent_ready" | "expired";
export type Eligibility = "live" | "delayed" | "stale" | "reference_only";

export interface ExecutableQuote {
  side: "buy" | "sell";
  requestedNotional: string;
  averagePrice: string;
  worstPrice: string;
  filledQuantity: string;
  filledNotionalUsd?: string;
  capacityUsd: string;
  depthUtilization: string;
  sourceBookEventId: string;
  sourceEventIds?: string[];
  ageMs: number;
}

export interface Opportunity {
  opportunityId: string;
  stateRevision: number;
  strategy: string;
  underlyingId: string;
  legs: Array<{ legId: string; instrumentId: string; side: "buy" | "sell"; executableQuote: ExecutableQuote }>;
  grossSpreadBps: string;
  expectedFundingBps: string;
  tradingFeesBps: string;
  slippageBps: string;
  financingBps: string;
  gasAndTransferBps: string;
  fxConversionBps: string;
  uncertaintyBufferBps: string;
  netEdgeBps: string;
  capacityUsd: string;
  freshness: { oldestInputMs: number; synchronized: boolean; eligibility: Eligibility; qualityFlags: string[] };
  expiresAt: string;
  rejectionReasons: string[];
  status: OpportunityStatus;
  evidenceHash?: string;
}

export interface MarketObservation {
  eventId: string;
  schemaVersion: number;
  venue: string;
  instrumentId: string;
  sequence?: string | number;
  transport: "websocket" | "rest" | "replay";
  freshnessBudgetMs: number;
  qualityFlags: string[];
  eligibility: Eligibility;
  sourceTimestamp: number;
  receivedTimestamp: number;
  payload: {
    kind: "order_book" | "funding" | "index_price";
    [key: string]: unknown;
  };
}

export interface VenueView {
  venue: string;
  capabilities: string[];
  freshnessBudgetMs: number;
  asOfMs: number | null;
  health: null | {
    venue: string;
    connectionState: "connected" | "connecting" | "reconnecting" | "disconnected" | "degraded" | "quarantined";
    lastEventAgeMs: number;
    clockSkewMs: number;
    sequenceIntegrity: "consistent" | "gap" | "unknown";
    rateLimit: { state: "healthy" | "limited" | "backing_off" | "unknown"; retryAfterMs?: number };
    capabilityChanges: Array<{ capability: string; change: "added" | "removed"; observedAt: string }>;
    errorCounters: Record<string, number>;
    quarantineReason?: string;
  };
}

export interface Envelope<TResult> {
  status: EnvelopeStatus;
  as_of: string;
  freshness: { oldest_input_ms: number };
  result: TResult;
  evidence: Array<{ event_id: string }>;
  warnings: string[];
  trace_id: string;
}

export type OpportunityEnvelope = Envelope<{ items: Opportunity[]; next_offset: number | null }>;
export type MarketSnapshotEnvelope = Envelope<{ underlying: string; observations: MarketObservation[] }>;
export type OpportunityDetailEnvelope = Envelope<{
  opportunity: Opportunity;
  rejection_history: Array<{ state_revision: number; status: string; rejection_reasons: string[] }>;
}>;
export type VenueEnvelope = Envelope<{ items: VenueView[]; next_offset: number | null }>;

export interface OpportunityFilters {
  underlying: string;
  strategy?: string;
  min_edge_bps?: string;
  min_capacity_usd?: string;
  max_age_ms?: number;
}

export type DashboardStreamEvent =
  | { kind: "opportunity"; detail: OpportunityDetailEnvelope; message: string }
  | { kind: "invalidation"; opportunityId: string; message: string }
  | { kind: "health"; venue: VenueView; message: string }
  | { kind: "connection"; state: "connected" | "reconnecting"; message: string };

export interface DashboardApi {
  scanOpportunities(filters: OpportunityFilters): Promise<OpportunityEnvelope>;
  getMarketSnapshot(underlying: string): Promise<MarketSnapshotEnvelope>;
  inspectOpportunity(id: string): Promise<OpportunityDetailEnvelope>;
  listVenues(): Promise<VenueEnvelope>;
  subscribe(underlying: string, handler: (event: DashboardStreamEvent) => void | Promise<void>): () => void;
  intentPreviewCapability: { available: false; reason: string };
}

export class RangeApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function createDashboardApi(options: { baseUrl?: string; readToken?: string } = {}): DashboardApi {
  const baseUrl = options.baseUrl ?? "";
  const headers = (): HeadersInit => options.readToken ? { Authorization: `Bearer ${options.readToken}` } : {};
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: headers(), credentials: "same-origin" });
    const body = await response.json() as T & { result?: { code?: string } };
    if (!response.ok) throw new RangeApiError(response.status, body.result?.code ?? "REQUEST_FAILED");
    return body;
  };
  return {
    scanOpportunities: (filters) => {
      const query = new URLSearchParams({ underlying: filters.underlying, limit: "100", offset: "0" });
      if (filters.strategy) query.set("strategy", filters.strategy);
      if (filters.min_edge_bps) query.set("min_edge_bps", filters.min_edge_bps);
      if (filters.min_capacity_usd) query.set("min_capacity_usd", filters.min_capacity_usd);
      if (filters.max_age_ms !== undefined) query.set("max_age_ms", String(filters.max_age_ms));
      return request<OpportunityEnvelope>(`/v1/opportunities?${query}`);
    },
    getMarketSnapshot: (underlying) => request<MarketSnapshotEnvelope>(`/v1/markets/snapshot?underlying=${encodeURIComponent(underlying)}`),
    inspectOpportunity: (id) => request<OpportunityDetailEnvelope>(`/v1/opportunities/${encodeURIComponent(id)}`),
    listVenues: () => request<VenueEnvelope>("/v1/venues?limit=100&offset=0"),
    subscribe: (underlying, handler) => subscribeToRangeStream({ url: `${baseUrl}/v1/stream?underlying=${encodeURIComponent(underlying)}`, headers: headers(), handler }),
    intentPreviewCapability: {
      available: false,
      reason: "Intent preview requires a server-side intent:create scope; no privileged token is exposed to this browser.",
    },
  };
}
