import { EvidenceBundleSchema, isCurrentAtRevision, OpportunitySchema, type EvidenceBundle, type Opportunity } from "@range/domain";

export interface RedisCommands {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: "PX", milliseconds: number): Promise<unknown>;
  zrangebyscore(key: string, min: string | number, max: string | number, ...args: (string | number)[]): Promise<string[]>;
}
export type ObservationTime = { eventId: string; sourceTimestampMs: number; receivedTimestampMs: number };

/** How long a published result, its evidence and its sources' times stay readable after publication. */
const RECENT_MS = 300_000;
export interface VersionedState<T = unknown> {
  version: number;
  expiresAt: number;
  value: T;
  underlyingId?: string;
  terminal?: boolean;
}

// Persistent version fences deliberately outlive expiring data. An expired
// key is not permission to accept an older version or revive the same one.
const CAS = `
local old = redis.call('HGET', KEYS[2], 'version')
local incoming = tonumber(ARGV[4])
if old then
  if incoming < tonumber(old) then return 0 end
  if incoming == tonumber(old) and
    (redis.call('HGET', KEYS[2], 'terminal') == '1' or ARGV[5] ~= '1') then return 0 end
end
redis.call('HSET', KEYS[2], 'version', ARGV[4], 'terminal', ARGV[5])
if ARGV[5] == '1' or tonumber(ARGV[2]) <= 0 then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  redis.call('ZADD', KEYS[3], ARGV[6], ARGV[3])
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[7])
return 1
`;

export class CurrentStateStore {
  constructor(private readonly redis: RedisCommands,
    private readonly authority: { read(underlyingId: string): Promise<number> },
    private readonly now: () => number = Date.now,
    private readonly namespace = "range") {
    if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid Redis namespace");
  }

  private key(kind: string, id: string) { return `{${this.namespace}}:${kind}:${id}`; }

  async put<T>(key: string, record: VersionedState<T>): Promise<boolean> {
    if (!Number.isSafeInteger(record.version) || record.version < 0 || !Number.isSafeInteger(record.expiresAt)) {
      throw new Error("Invalid state version or expiry");
    }
    return Number(await this.redis.eval(CAS, 3, this.key("data", key), this.key("fence", key),
      this.key("index", record.underlyingId ?? "all"), JSON.stringify(record),
      Math.max(0, record.expiresAt - this.now()), key, record.version, record.terminal ? "1" : "0", record.expiresAt, this.now())) === 1;
  }

  async get<T = unknown>(key: string): Promise<VersionedState<T> | undefined> {
    const data = await this.redis.get(this.key("data", key));
    if (!data) return undefined;
    const record = JSON.parse(data) as VersionedState<T>;
    return record.terminal || record.expiresAt <= this.now() ? undefined : record;
  }

  async query(underlyingId: string, limit = 100): Promise<Array<{ key: string; state: VersionedState }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid query limit");
    const keys = await this.redis.zrangebyscore(this.key("index", underlyingId), `(${this.now()}`, "+inf", "LIMIT", 0, limit);
    const values = await Promise.all(keys.map(async key => ({ key, state: await this.get(key) })));
    return values.filter((item): item is { key: string; state: VersionedState } =>
      item.state !== undefined && item.state.underlyingId === underlyingId);
  }

  /**
   * Keeps every published result, current or not: the dashboard shows each pair's newest actionable result while it is
   * fresh, and any result stays inspectable for five minutes. Readers that need the accepted revision (getOpportunity,
   * and so intents) still check it on every read.
   */
  async putOpportunity(input: Opportunity): Promise<boolean> {
    const opportunity = OpportunitySchema.parse(input);
    await this.redis.set(this.key("recent", opportunity.opportunityId), JSON.stringify(opportunity), "PX", RECENT_MS);
    return this.put(`opportunity:${opportunity.opportunityId}`, {
      version: opportunity.stateRevision, expiresAt: Date.parse(opportunity.expiresAt),
      underlyingId: opportunity.underlyingId, terminal: opportunity.status === "expired", value: opportunity,
    });
  }

  async getOpportunity(opportunityId: string): Promise<Opportunity | undefined> {
    const state = await this.get<Opportunity>(`opportunity:${opportunityId}`);
    if (!state) return undefined;
    const opportunity = OpportunitySchema.parse(state.value);
    const revision = await this.authority.read(opportunity.underlyingId);
    return isCurrentAtRevision(opportunity, revision, this.now()) ? opportunity : undefined;
  }

  /** A published result's latest version, current or not, for five minutes after it was published. */
  async getRecentOpportunity(opportunityId: string): Promise<Opportunity | undefined> {
    const data = await this.redis.get(this.key("recent", opportunityId));
    return data ? OpportunitySchema.parse(JSON.parse(data)) : undefined;
  }

  /** Every stored result for an underlying that has neither expired nor ended, whatever the accepted revision. */
  async queryLiveOpportunities(underlyingId: string, limit = 1000): Promise<Opportunity[]> {
    return this.scanOpportunityIndex(underlyingId, limit, async id => {
      const state = await this.get<Opportunity>(`opportunity:${id}`);
      return state ? OpportunitySchema.parse(state.value) : undefined;
    });
  }

  async putEvidence(bundle: EvidenceBundle): Promise<void> {
    const evidence = EvidenceBundleSchema.parse(bundle);
    await this.redis.set(this.key("evidence", evidence.evidenceHash), JSON.stringify(evidence), "PX", RECENT_MS);
  }

  async getEvidence(evidenceHash: string): Promise<EvidenceBundle | undefined> {
    const data = await this.redis.get(this.key("evidence", evidenceHash));
    return data ? EvidenceBundleSchema.parse(JSON.parse(data)) : undefined;
  }

  /** Source and receive times of observations evidence may cite, readable before history records them. */
  async putObservationTimes(items: readonly ObservationTime[]): Promise<void> {
    await Promise.all(items.map(item => this.redis.set(this.key("observed", item.eventId),
      JSON.stringify([item.sourceTimestampMs, item.receivedTimestampMs]), "PX", RECENT_MS)));
  }

  async getObservationTimes(eventIds: readonly string[]): Promise<ObservationTime[]> {
    if (!eventIds.length) return [];
    const values = await this.redis.mget(...eventIds.map(id => this.key("observed", id)));
    return eventIds.flatMap((eventId, index) => {
      const value = values[index];
      if (!value) return [];
      const [sourceTimestampMs, receivedTimestampMs] = JSON.parse(value) as [number, number];
      return [{ eventId, sourceTimestampMs, receivedTimestampMs }];
    });
  }

  async queryOpportunities(underlyingId: string, limit = 100): Promise<Opportunity[]> {
    return this.scanOpportunityIndex(underlyingId, limit, id => this.getOpportunity(id));
  }

  private async scanOpportunityIndex(underlyingId: string, limit: number,
    read: (opportunityId: string) => Promise<Opportunity | undefined>): Promise<Opportunity[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid query limit");
    const result: Opportunity[] = [];
    const batchSize = Math.max(32, limit);
    // Offset pagination must use one score range. A moving lower bound would
    // shrink earlier pages and skip surviving entries at later offsets.
    const lowerBound = `(${this.now()}`;
    let offset = 0;
    while (result.length < limit) {
      const keys = await this.redis.zrangebyscore(this.key("index", underlyingId), lowerBound, "+inf",
        "LIMIT", offset, batchSize);
      if (keys.length === 0) break;
      offset += keys.length;
      for (const key of keys) {
        if (!key.startsWith("opportunity:")) continue;
        const opportunity = await read(key.slice("opportunity:".length));
        if (opportunity?.underlyingId === underlyingId) result.push(opportunity);
        if (result.length === limit) break;
      }
      if (keys.length < batchSize) break;
    }
    return result;
  }
}
