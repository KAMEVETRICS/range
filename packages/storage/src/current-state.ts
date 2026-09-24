import { isCurrentAtRevision, OpportunitySchema, type Opportunity } from "@range/domain";

export interface RedisCommands {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  zrangebyscore(key: string, min: string | number, max: string | number, ...args: (string | number)[]): Promise<string[]>;
}
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
      Math.max(0, record.expiresAt - this.now()), key, record.version, record.terminal ? "1" : "0", record.expiresAt)) === 1;
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

  async putOpportunity(input: Opportunity): Promise<boolean> {
    const opportunity = OpportunitySchema.parse(input);
    const revision = await this.authority.read(opportunity.underlyingId);
    if (revision !== opportunity.stateRevision) return false;
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

  async queryOpportunities(underlyingId: string, limit = 100): Promise<Opportunity[]> {
    const entries = await this.query(underlyingId, limit);
    const candidates = entries.filter(entry => entry.key.startsWith("opportunity:"));
    const result = await Promise.all(candidates.map(entry => this.getOpportunity(entry.key.slice("opportunity:".length))));
    return result.filter((entry): entry is Opportunity => entry !== undefined);
  }
}
