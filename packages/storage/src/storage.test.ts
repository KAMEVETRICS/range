import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import Redis from "ioredis-mock";
import { DataType, newDb } from "pg-mem";
import { CurrentStateStore, type RedisCommands } from "./current-state.js";
import { CitationPendingError, HistoryStore, PostgresRevisionAuthority } from "./history.js";
import { OpportunitySchema, type Opportunity } from "@range/domain";
import { InMemoryEventBus, parseEvent } from "@range/event-bus";
import { InstrumentRegistry } from "@range/instruments";
import { startPersistentOpportunityWorker } from "./bootstrap.js";

export async function database() {
  const memory = newDb();
  memory.public.registerOperator({ operator: "~", left: DataType.text, right: DataType.text,
    returns: DataType.bool, implementation: (text, pattern) => new RegExp(pattern).test(text) });
  // pg-mem checks SQL, indexes and relational constraints. The extension call
  // is stubbed: actual Timescale chunk/retention behavior requires Docker CI.
  memory.registerExtension("timescaledb", schema => {
    schema.registerFunction({ name: "create_hypertable", args: [DataType.text, DataType.text], returns: DataType.bool, implementation: () => true });
  });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  // 0003 only sets autovacuum storage parameters, which pg-mem cannot parse and has no use for.
  for (const migration of ["0001_initial.sql", "0002_history_retention.sql", "0004_result_retention.sql"]) {
    await pool.query(await readFile(new URL(`./migrations/${migration}`, import.meta.url), "utf8"));
  }
  return pool;
}

const value = (version: number, expiresAt: number) => ({ version, expiresAt, value: { price: `${version}` } });
function opportunity(revision: number, expiresAt: number): Opportunity {
  return OpportunitySchema.parse({ opportunityId: "opp_test", stateRevision: revision, underlyingId: "equity:TSLA", strategy: "perp_spread",
    legs: [], status: "rejected", rejectionReasons: ["INSUFFICIENT_DEPTH"], grossSpreadBps: "0", expectedFundingBps: "0",
    tradingFeesBps: "0", slippageBps: "0", financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0",
    uncertaintyBufferBps: "0", netEdgeBps: "0", capacityUsd: "0", expiresAt: new Date(expiresAt).toISOString(),
    freshness: { oldestInputMs: 0, synchronized: true, eligibility: "reference_only", qualityFlags: [] } });
}
function actionableOpportunity(id: string, revision: number, expiresAt: number): Opportunity {
  return OpportunitySchema.parse({
    ...opportunity(revision, expiresAt), opportunityId: id, status: "actionable",
    legs: [{ legId: "leg_a", instrumentId: "ins_a", side: "buy", executableQuote: {
      side: "buy", requestedNotional: "100", averagePrice: "100", worstPrice: "100",
      filledQuantity: "1", capacityUsd: "100", depthUtilization: "1", sourceBookEventId: "evt_a", ageMs: 0,
    } }],
    rejectionReasons: [], evidenceHash: `sha256:${"a".repeat(64)}`, capacityUsd: "100",
    freshness: { oldestInputMs: 0, synchronized: true, eligibility: "live", qualityFlags: [] },
  });
}

describe("Redis current state", () => {
  it("atomically rejects lower versions and keeps the version fence after TTL expiry", async () => {
    const redis = new Redis();
    let now = Date.now();
    const store = new CurrentStateStore(redis, { read: async () => 2 }, () => now);
    const newer = value(2, now + 50_000);
    expect(await store.put("book:a", newer)).toBe(true);
    expect(await store.put("book:a", value(1, now + 100_000))).toBe(false);
    expect(await store.get("book:a")).toEqual(newer);
    now += 60_000;
    expect(await store.get("book:a")).toBeUndefined();
    expect(await store.put("book:a", value(2, now + 100_000))).toBe(false);
    expect(await store.put("book:a", value(1, now + 100_000))).toBe(false);
    expect(await store.put("book:a", value(3, now + 100_000))).toBe(true);
    redis.disconnect();
  });

  it("uses indexed underlying queries and makes same-revision expiration terminal", async () => {
    const redis = new Redis();
    const now = Date.now();
    const store = new CurrentStateStore(redis, { read: async () => 7 }, () => now);
    await store.put("a", { ...value(7, now + 1000), underlyingId: "equity:A" });
    await store.put("b", { ...value(7, now + 1000), underlyingId: "equity:B" });
    expect((await store.query("equity:A")).map(item => item.key)).toEqual(["a"]);
    await store.put("a", { ...value(7, now + 1000), underlyingId: "equity:A", terminal: true });
    expect(await store.put("a", { ...value(7, now + 10000), underlyingId: "equity:A" })).toBe(false);
    expect(await store.get("a")).toBeUndefined();
    redis.disconnect();
  });

  it("does not promote rejected events, and a strict read fails closed when the authority is unavailable", async () => {
    const redis = new Redis();
    const now = Date.now();
    let failure = false;
    const store = new CurrentStateStore(redis, { read: async () => { if (failure) throw new Error("offline"); return 3; } }, () => now);
    await store.putOpportunity(opportunity(3, now + 1000));
    expect(await store.getOpportunity("opp_test")).toBeUndefined();
    await store.putOpportunity(actionableOpportunity("opp_live", 3, now + 1000));
    expect(await store.getOpportunity("opp_live")).toMatchObject({ status: "actionable" });
    failure = true;
    await expect(store.getOpportunity("opp_live")).rejects.toThrow("offline");
    redis.disconnect();
  });

  it("keeps every published result for display while strict reads still require the accepted revision", async () => {
    const redis = new Redis();
    const now = Date.now();
    const store = new CurrentStateStore(redis, { read: async () => 5 }, () => now, "display_test");
    const behind = actionableOpportunity("opp_behind", 3, now + 1_000);
    await store.putOpportunity(behind);
    expect(await store.getOpportunity("opp_behind")).toBeUndefined();
    expect(await store.queryOpportunities("equity:TSLA")).toEqual([]);
    expect(await store.queryLiveOpportunities("equity:TSLA")).toEqual([behind]);
    expect(await store.getRecentOpportunity("opp_behind")).toEqual(behind);
    // Ending it removes it from the live set; its last version stays inspectable.
    const ended = OpportunitySchema.parse({ ...behind, status: "expired", stateRevision: 5, rejectionReasons: ["STALE_INPUT"] });
    await store.putOpportunity(ended);
    expect(await store.queryLiveOpportunities("equity:TSLA")).toEqual([]);
    expect(await store.getRecentOpportunity("opp_behind")).toMatchObject({ status: "expired", stateRevision: 5 });
    redis.disconnect();
  });

  it("serves evidence and observation times until history records them", async () => {
    const redis = new Redis();
    const store = new CurrentStateStore(redis, { read: async () => 0 }, Date.now, "evidence_test");
    const bundle = { evidenceHash: `sha256:${"e".repeat(64)}`, calculationVersion: "calc.v1", sourceEventIds: ["evt_a"],
      canonicalMappingVersions: {}, assumptions: {}, intermediateValues: {}, warnings: [] };
    await store.putEvidence(bundle as never);
    expect(await store.getEvidence(bundle.evidenceHash)).toEqual(bundle);
    expect(await store.getEvidence(`sha256:${"f".repeat(64)}`)).toBeUndefined();
    await store.putObservationTimes([{ eventId: "evt_a", sourceTimestampMs: 10, receivedTimestampMs: 12 }]);
    expect(await store.getObservationTimes(["evt_a", "evt_missing"])).toEqual([{ eventId: "evt_a", sourceTimestampMs: 10, receivedTimestampMs: 12 }]);
    redis.disconnect();
  });

  it("drops index entries whose data has expired", async () => {
    const redis = new Redis();
    let now = Date.now();
    const store = new CurrentStateStore(redis, { read: async () => 0 }, () => now, "prune_test");
    await store.put("book:a", { version: 1, expiresAt: now + 1_000, underlyingId: "equity:TSLA", value: {} });
    now += 2_000;
    await store.put("book:b", { version: 1, expiresAt: now + 1_000, underlyingId: "equity:TSLA", value: {} });
    expect(await redis.zrange("{prune_test}:index:equity:TSLA", 0, -1)).toEqual(["book:b"]);
    redis.disconnect();
  });

  it("pages past stale earlier-expiring opportunities before applying the result limit", async () => {
    const redis = new Redis();
    const now = Date.now();
    const store = new CurrentStateStore(redis, { read: async () => 2 }, () => now);
    const old = actionableOpportunity("opp_old", 1, now + 1_000);
    const current = actionableOpportunity("opp_current", 2, now + 2_000);
    await store.put("opportunity:opp_old", { version: 1, expiresAt: now + 1_000, underlyingId: "equity:TSLA", value: old });
    await store.put("opportunity:opp_current", { version: 2, expiresAt: now + 2_000, underlyingId: "equity:TSLA", value: current });
    expect(await store.queryOpportunities("equity:TSLA", 1)).toEqual([current]);
    redis.disconnect();
  });

  it("keeps the index bound stable when stale entries expire between Redis pages", async () => {
    const redis = new Redis();
    let now = Date.now();
    const firstPageAt = now;
    let pageReads = 0;
    const clockedRedis: RedisCommands = {
      eval: redis.eval.bind(redis), get: redis.get.bind(redis), mget: redis.mget.bind(redis), set: redis.set.bind(redis),
      zrangebyscore: async (key, min, max, ...args) => {
        const keys = await redis.zrangebyscore(key, min, max, ...args);
        if (++pageReads === 1) now += 20_000;
        return keys;
      },
    };
    const store = new CurrentStateStore(clockedRedis, { read: async () => 2 }, () => now);
    for (let index = 0; index < 33; index++) {
      const id = `opp_stale_${index}`;
      await store.put(`opportunity:${id}`, { version: 1, expiresAt: firstPageAt + 10_000,
        underlyingId: "equity:TSLA", value: actionableOpportunity(id, 1, firstPageAt + 10_000) });
    }
    const current = actionableOpportunity("opp_current_after_pages", 2, firstPageAt + 60_000);
    await store.put("opportunity:opp_current_after_pages", { version: 2, expiresAt: firstPageAt + 60_000,
      underlyingId: "equity:TSLA", value: current });
    expect(await store.queryOpportunities("equity:TSLA", 1)).toEqual([current]);
    redis.disconnect();
  });
});

describe("Postgres history and revision authority", () => {
  it("advances atomically across clients and preserves revisions across restart", async () => {
    const pool = await database();
    const first = new PostgresRevisionAuthority(pool);
    const second = new PostgresRevisionAuthority(pool);
    expect(await first.read("equity:A")).toBe(0);
    expect(await Promise.all([first.advance("equity:A"), second.advance("equity:A")])).toEqual([1, 2]);
    expect(await new PostgresRevisionAuthority(pool).read("equity:A")).toBe(2);
    expect(await second.advance("equity:B")).toBe(1);
    await pool.end();
  });

  it("advances every distinct underlying exactly once in one statement", async () => {
    const pool = await database();
    const authority = new PostgresRevisionAuthority(pool);
    await authority.advance("equity:A");
    const query = vi.spyOn(pool, "query");
    const advanced = await authority.advanceMany(["equity:B", "equity:A", "equity:B"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(advanced)).toEqual({ "equity:A": 2, "equity:B": 1 });
    expect(await authority.read("equity:A")).toBe(2);
    expect(await authority.read("equity:B")).toBe(1);
    expect(await authority.advanceMany([])).toEqual(new Map());
    await pool.end();
  });

  it("requires immutable archive and calculation parents, and indexes history by underlying/time", async () => {
    const pool = await database();
    const history = new HistoryStore(pool);
    const now = Date.now();
    const event = { eventId: "evt_opp", topic: "opportunity.v1" as const, key: "equity:TSLA", underlyingId: "equity:TSLA",
      acceptedAtMs: now, archiveId: "archive1", calculationVersion: "calc.v1", payload: opportunity(1, now + 1000) };
    await expect(history.append(event)).rejects.toThrow();
    await history.registerArchive({ archiveId: "archive1", uri: "s3://range/immutable.ndjson", contentHash: `sha256:${"a".repeat(64)}` });
    await expect(history.append(event)).rejects.toThrow();
    await history.registerCalculation("calc.v1");
    await history.append(event);
    await history.append(event);
    expect(await history.queryEvents({ underlyingId: "equity:TSLA", fromMs: now, toMs: now + 1 })).toEqual([event]);
    await expect(history.append({ ...event, key: "changed" })).rejects.toThrow(/immutable/i);
    await pool.end();
  });

  it("appends a batch in one transaction with consecutive ordinals, skipping duplicates", async () => {
    const pool = await database();
    const history = new HistoryStore(pool);
    await history.registerArchive({ archiveId: "archive1", uri: "s3://range/immutable.ndjson", contentHash: `sha256:${"a".repeat(64)}` });
    const health = (eventId: string, venue: string) => ({ eventId, topic: "venue.health.v1" as const, key: venue,
      acceptedAtMs: 1_790_000_000_000, archiveId: "archive1", payload: parseEvent("venue.health.v1", { venue, connectionState: "connected",
        lastEventAgeMs: 0, clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} }) });
    const log = async () => (await pool.query("SELECT event_id, ordinal FROM event_log ORDER BY ordinal")).rows
      .map((row: { event_id: string; ordinal: number | string }) => [row.event_id, Number(row.ordinal)]);
    await history.append(health("evt_0", "a"));

    await history.appendMany([health("evt_1", "a"), health("evt_0", "a"), health("evt_2", "b"), health("evt_1", "a")]);
    expect(await log()).toEqual([["evt_0", 1], ["evt_1", 2], ["evt_2", 3]]);

    await expect(history.appendMany([health("evt_3", "a"), { ...health("evt_0", "a"), key: "changed" }])).rejects.toThrow(/immutable/i);
    expect(await log()).toEqual([["evt_0", 1], ["evt_1", 2], ["evt_2", 3]]);
    await pool.end();
  });

  it("keeps the first receipt when the same venue observation is received again", async () => {
    const pool = await database();
    const history = new HistoryStore(pool);
    await history.registerArchive({ archiveId: "archive1", uri: "s3://range/immutable.ndjson", contentHash: `sha256:${"a".repeat(64)}` });
    const receipt = (receivedTimestamp: number, qualityFlags: string[], askPrice = "100.1") => {
      const payload = parseEvent("book.state.v1", {
        eventId: "evt_extended_ins_extended_SHOP-USD_order_book_1790345607814_a4c440186cbccd20", schemaVersion: 1,
        venue: "extended", instrumentId: "ins_extended_SHOP-USD", sequence: 1, sequencePolicy: "contiguous", sequenceReset: true,
        transport: "websocket", sourceTimestamp: 1_790_345_607_814, receivedTimestamp, freshnessBudgetMs: 5_000, qualityFlags,
        rawPayloadRefOrHash: "a4c440186cbccd20", eligibility: "reference_only",
        payload: { kind: "order_book", bids: [{ price: "100", quantity: "5" }], asks: [{ price: askPrice, quantity: "5" }], capacityUsd: "0" },
      });
      return { eventId: payload.eventId, topic: "book.state.v1" as const, key: payload.instrumentId,
        acceptedAtMs: receivedTimestamp, archiveId: "archive1", payload };
    };
    const logState = async () => (await pool.query("SELECT count(*)::int AS rows, max(ordinal)::int AS ordinal FROM event_log")).rows;
    const first = receipt(1_790_555_871_482, ["rfq_real_book"]);
    await history.append(first);
    const before = await logState();

    // A reconnect resends the unchanged book: same venue data, a later receive time and a receive-time flag.
    await history.append(receipt(1_790_557_888_480, ["rfq_real_book", "market_off_hours"]));

    expect(await logState()).toEqual(before);
    const stored = (await pool.query("SELECT record FROM event_log WHERE event_id = $1", [first.eventId])).rows[0].record;
    expect((typeof stored === "string" ? JSON.parse(stored) : stored).acceptedAtMs).toBe(first.acceptedAtMs);
    await expect(history.append(receipt(1_790_557_888_480, ["rfq_real_book"], "100.2"))).rejects.toThrow(/immutable/i);
    await pool.end();
  });
});

describe("history retention", () => {
  const hour = 3_600_000;
  const now = 1_790_600_000_000;
  const book = (eventId: string, acceptedAtMs: number) => {
    const payload = parseEvent("book.state.v1", { eventId, schemaVersion: 1, venue: "extended", instrumentId: "ins_extended_SHOP-USD",
      transport: "websocket", sourceTimestamp: acceptedAtMs - 50, receivedTimestamp: acceptedAtMs, freshnessBudgetMs: 5_000,
      qualityFlags: [], rawPayloadRefOrHash: eventId, eligibility: "reference_only",
      payload: { kind: "order_book", bids: [{ price: "100", quantity: "5" }], asks: [{ price: "100.1", quantity: "5" }], capacityUsd: "0" } });
    return { eventId, topic: "book.state.v1" as const, key: payload.instrumentId, acceptedAtMs, archiveId: "archive1", payload };
  };
  const funding = (eventId: string, acceptedAtMs: number) => {
    const payload = parseEvent("funding.observation.v1", { eventId, schemaVersion: 1, venue: "extended", instrumentId: "ins_extended_SHOP-USD",
      transport: "rest", sourceTimestamp: acceptedAtMs - 50, receivedTimestamp: acceptedAtMs, freshnessBudgetMs: 60_000,
      qualityFlags: [], rawPayloadRefOrHash: eventId, eligibility: "reference_only",
      payload: { kind: "funding", rateType: "current", rate: "0.0001", positiveRatePayer: "long", intervalMs: hour, nextSettlementMs: acceptedAtMs + hour } });
    return { eventId, topic: "funding.observation.v1" as const, key: payload.instrumentId, acceptedAtMs, archiveId: "archive1", payload };
  };
  const health = (eventId: string, acceptedAtMs: number) => ({ eventId, topic: "venue.health.v1" as const, key: "extended", acceptedAtMs,
    archiveId: "archive1", payload: parseEvent("venue.health.v1", { venue: "extended", connectionState: "connected", lastEventAgeMs: 0,
      clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} }) });
  const evidence = (sourceEventIds: string[], acceptedAtMs: number) => {
    const payload = parseEvent("evidence.bundle.v1", { evidenceHash: `sha256:${"b".repeat(64)}`, calculationVersion: "calc.v1", sourceEventIds,
      canonicalMappingVersions: {}, assumptions: {}, intermediateValues: {}, warnings: [] });
    return { eventId: "evt_evidence", topic: "evidence.bundle.v1" as const, key: payload.evidenceHash, acceptedAtMs,
      archiveId: "archive1", calculationVersion: "calc.v1", payload };
  };
  async function store() {
    const pool = await database();
    const history = new HistoryStore(pool);
    await history.registerArchive({ archiveId: "archive1", uri: "s3://range/immutable.ndjson", contentHash: `sha256:${"a".repeat(64)}` });
    await history.registerCalculation("calc.v1");
    const ids = async (table: "event_log" | "observations") => (await pool.query(`SELECT event_id FROM ${table} ORDER BY event_id`)).rows
      .map((row: { event_id: string }) => row.event_id);
    return { pool, history, ids };
  }

  it("deletes book and funding history accepted before the cutoff, keeping evidence sources and other topics", async () => {
    const { pool, history, ids } = await store();
    await history.appendMany([book("evt_book_old", now - 10 * hour), book("evt_book_cited", now - 10 * hour),
      funding("evt_funding_old", now - 9 * hour), health("evt_health_old", now - 10 * hour), book("evt_book_new", now - hour)]);
    await history.append(evidence(["evt_book_cited"], now - 10 * hour));
    const ordinals = async () => (await pool.query("SELECT event_id, ordinal FROM event_log ORDER BY ordinal")).rows
      .map((row: { event_id: string; ordinal: number | string }) => [row.event_id, Number(row.ordinal)]);

    expect(await history.pruneObservations(now - 5 * hour)).toBe(2);

    expect(await ids("event_log")).toEqual(["evt_book_cited", "evt_book_new", "evt_evidence", "evt_health_old"]);
    expect(await ids("observations")).toEqual(["evt_book_cited", "evt_book_new"]);
    expect(await ordinals()).toEqual([["evt_book_cited", 2], ["evt_health_old", 4], ["evt_book_new", 5], ["evt_evidence", 6]]);
    await history.append(book("evt_book_later", now));
    expect((await ordinals()).at(-1)).toEqual(["evt_book_later", 7]);
    expect(await history.pruneObservations(now - 5 * hour)).toBe(0);
    await pool.end();
  });

  it("deletes oldest first in bounded batches, one transaction each", async () => {
    const { pool, history, ids } = await store();
    await history.appendMany([5, 4, 3, 2, 1].map(age => book(`evt_book_${age}h`, now - age * hour)));

    expect(await history.pruneObservations(now, { batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await ids("event_log")).toEqual(["evt_book_1h", "evt_book_2h", "evt_book_3h"]);

    const connect = vi.spyOn(pool, "connect");
    expect(await history.pruneObservations(now, { batchSize: 2 })).toBe(3);
    expect(connect).toHaveBeenCalledTimes(3); // two book batches, then one empty funding batch
    expect(await ids("event_log")).toEqual([]);
    expect(await ids("observations")).toEqual([]);
    await pool.end();
  });

  it("starts no batch once its signal aborts", async () => {
    const { pool, history, ids } = await store();
    await history.append(book("evt_book_old", now - hour));
    expect(await history.pruneObservations(now, { signal: AbortSignal.abort() })).toBe(0);
    expect(await ids("event_log")).toEqual(["evt_book_old"]);
    await pool.end();
  });

  it("stores an observation once: its time-series row keeps only the receive time", async () => {
    const { pool, history } = await store();
    const event = book("evt_book_once", now);
    await history.append(event);
    const row = (await pool.query("SELECT source_time, instrument_id, venue, payload FROM observations WHERE event_id = $1", [event.eventId])).rows[0];
    expect(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload).toEqual({ receivedTimestamp: now });
    expect([new Date(row.source_time).getTime(), row.instrument_id, row.venue]).toEqual([now - 50, "ins_extended_SHOP-USD", "extended"]);
    const record = (await pool.query("SELECT record FROM event_log WHERE event_id = $1", [event.eventId])).rows[0].record;
    expect((typeof record === "string" ? JSON.parse(record) : record).payload).toEqual(event.payload);
    await pool.end();
  });

  it("writes a batch's observation rows in one statement", async () => {
    const { pool, history, ids } = await store();
    const statements: string[] = [];
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = ((sql: string, values?: unknown[]) => { statements.push(sql); return query(sql, values); }) as typeof client.query;
      return client;
    });
    await history.appendMany([1, 2, 3].map(index => book(`evt_book_${index}`, now - index)));
    expect(await ids("observations")).toEqual(["evt_book_1", "evt_book_2", "evt_book_3"]);
    expect(statements.filter(sql => sql.includes("INSERT INTO observations"))).toHaveLength(1);
    await pool.end();
  });

  it("writes a batch's evidence and all its sources in one statement each", async () => {
    const { pool, history } = await store();
    await history.appendMany([book("evt_source_1", now), book("evt_source_2", now)]);
    const statements: string[] = [];
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = ((sql: string, values?: unknown[]) => { statements.push(sql); return query(sql, values); }) as typeof client.query;
      return client;
    });
    const bundle = (index: number) => {
      const payload = parseEvent("evidence.bundle.v1", { evidenceHash: `sha256:${String(index).repeat(64)}`, calculationVersion: "calc.v1",
        sourceEventIds: ["evt_source_1", "evt_source_2"], canonicalMappingVersions: {}, assumptions: {}, intermediateValues: {}, warnings: [] });
      return { eventId: `evt_evidence_${index}`, topic: "evidence.bundle.v1" as const, key: payload.evidenceHash, acceptedAtMs: now,
        archiveId: "archive1", calculationVersion: "calc.v1", payload };
    };
    await history.appendMany([1, 2, 3].map(bundle));
    expect((await pool.query("SELECT evidence_hash FROM evidence_sources")).rows).toHaveLength(6);
    expect(statements.filter(sql => sql.includes("INSERT INTO evidence("))).toHaveLength(1);
    expect(statements.filter(sql => sql.includes("INSERT INTO evidence_sources"))).toHaveLength(1);
    await pool.end();
  });

  it("refuses evidence until its sources are recorded, without taking the event-log cursor", async () => {
    const { pool, history } = await store();
    const statements: string[] = [];
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = ((sql: string, values?: unknown[]) => { statements.push(sql); return query(sql, values); }) as typeof client.query;
      return client;
    });
    await expect(history.append(evidence(["evt_book_later"], now))).rejects.toBeInstanceOf(CitationPendingError);
    expect(statements.some(sql => sql.includes("event_log_cursor"))).toBe(false);
    await history.append(book("evt_book_later", now));
    await history.append(evidence(["evt_book_later"], now));
    expect((await pool.query("SELECT evidence_hash FROM evidence")).rows).toHaveLength(1);
    await pool.end();
  });

  const evidenceFor = (hashDigit: string, eventId: string, sourceEventIds: string[], acceptedAtMs: number) => {
    const payload = parseEvent("evidence.bundle.v1", { evidenceHash: `sha256:${hashDigit.repeat(64)}`, calculationVersion: "calc.v1",
      sourceEventIds, canonicalMappingVersions: {}, assumptions: {}, intermediateValues: {}, warnings: [] });
    return { eventId, topic: "evidence.bundle.v1" as const, key: payload.evidenceHash, acceptedAtMs,
      archiveId: "archive1", calculationVersion: "calc.v1", payload };
  };
  const resultFor = (eventId: string, opportunityId: string, hashDigit: string, acceptedAtMs: number) => ({
    eventId, topic: "opportunity.v1" as const, key: "equity:TSLA", underlyingId: "equity:TSLA", acceptedAtMs,
    archiveId: "archive1", calculationVersion: "calc.v1",
    payload: OpportunitySchema.parse({ ...opportunity(1, acceptedAtMs + 1000), opportunityId, evidenceHash: `sha256:${hashDigit.repeat(64)}` }) });
  const column = async (pool: Awaited<ReturnType<typeof database>>, sql: string) =>
    (await pool.query(sql)).rows.map((row: Record<string, unknown>) => String(Object.values(row)[0]));

  it("deletes results recorded before the cutoff with evidence nothing else cites, leaving what it cited to the book trim", async () => {
    const { pool, history, ids } = await store();
    await history.appendMany([book("evt_book_a", now - 10 * hour), book("evt_book_b", now - 10 * hour), book("evt_book_c", now - hour)]);
    await history.append(evidenceFor("c", "evt_evidence_old", ["evt_book_a"], now - 10 * hour));
    await history.append(resultFor("evt_result_old", "opp_old", "c", now - 10 * hour));
    await history.append(evidenceFor("d", "evt_evidence_new", ["evt_book_c"], now - hour));
    await history.append(resultFor("evt_result_new", "opp_new", "d", now - hour));

    expect(await history.pruneResults(now - 5 * hour)).toBe(3);

    expect(await column(pool, "SELECT opportunity_id FROM opportunities")).toEqual(["opp_new"]);
    expect(await column(pool, "SELECT evidence_hash FROM evidence")).toEqual([`sha256:${"d".repeat(64)}`]);
    expect(await column(pool, "SELECT source_event_id FROM evidence_sources")).toEqual(["evt_book_c"]);
    expect(await ids("event_log")).toEqual(["evt_book_a", "evt_book_b", "evt_book_c", "evt_evidence_new", "evt_result_new"]);
    // The old book is no longer cited, so the book and funding trim removes it with the book nothing ever cited.
    expect(await history.pruneObservations(now - 5 * hour)).toBe(2);
    expect(await ids("event_log")).toEqual(["evt_book_c", "evt_evidence_new", "evt_result_new"]);
    expect(await history.pruneResults(now - 5 * hour)).toBe(0);
    await pool.end();
  });

  it("keeps old evidence that a newer result or an intent still cites", async () => {
    const { pool, history } = await store();
    await history.appendMany([book("evt_book_a", now - 10 * hour), book("evt_book_b", now - 10 * hour)]);
    await history.append(evidenceFor("e", "evt_evidence_intent", ["evt_book_a"], now - 10 * hour));
    await history.append(resultFor("evt_result_intent", "opp_intent", "e", now - 10 * hour));
    await pool.query(`INSERT INTO intents(idempotency_key, opportunity_id, evidence_hash, expires_at, payload)
      VALUES ('idem_1', 'opp_intent', 'sha256:${"e".repeat(64)}', now(), '{}')`);
    await history.append(evidenceFor("f", "evt_evidence_shared", ["evt_book_b"], now - 10 * hour));
    await history.append(resultFor("evt_result_later", "opp_later", "f", now - hour));

    expect(await history.pruneResults(now - 5 * hour)).toBe(2);

    expect(await column(pool, "SELECT opportunity_id FROM opportunities")).toEqual(["opp_later"]);
    expect((await column(pool, "SELECT evidence_hash FROM evidence ORDER BY evidence_hash"))).toEqual(
      [`sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`]);
    expect(await history.pruneObservations(now - 5 * hour)).toBe(0);
    await pool.end();
  });

  it("prunes results in bounded batches and starts none once its signal aborts", async () => {
    const { pool, history } = await store();
    await history.append(book("evt_book_a", now - 10 * hour));
    for (const [index, digit] of ["1", "2", "3"].entries()) {
      await history.append(evidenceFor(digit, `evt_evidence_${digit}`, ["evt_book_a"], now - (10 - index) * hour));
      await history.append(resultFor(`evt_result_${digit}`, `opp_${digit}`, digit, now - (10 - index) * hour));
    }
    expect(await history.pruneResults(now, { signal: AbortSignal.abort() })).toBe(0);
    expect(await history.pruneResults(now, { batchSize: 2, maxBatches: 1 })).toBe(6);
    expect(await column(pool, "SELECT opportunity_id FROM opportunities")).toEqual(["opp_3"]);
    expect(await history.pruneResults(now)).toBe(3);
    expect(await column(pool, "SELECT evidence_hash FROM evidence")).toEqual([]);
    await expect(history.pruneResults(Number.NaN)).rejects.toThrow(/cutoff/i);
    await expect(history.pruneResults(now, { batchSize: 0 })).rejects.toThrow(/batch/i);
    await pool.end();
  });

  it("refuses a result until the evidence it cites is recorded", async () => {
    const { pool, history } = await store();
    const result = { eventId: "evt_result", topic: "opportunity.v1" as const, key: "equity:TSLA", underlyingId: "equity:TSLA",
      acceptedAtMs: now, archiveId: "archive1", calculationVersion: "calc.v1",
      payload: OpportunitySchema.parse({ ...opportunity(1, now + 1000), evidenceHash: `sha256:${"b".repeat(64)}` }) };
    await expect(history.append(result)).rejects.toBeInstanceOf(CitationPendingError);
    await history.append(book("evt_book_cited", now));
    await history.append(evidence(["evt_book_cited"], now));
    await history.append(result);
    expect((await pool.query("SELECT opportunity_id FROM opportunities")).rows).toHaveLength(1);
    await pool.end();
  });

  it("rejects an invalid cutoff or batch bound", async () => {
    const { pool, history } = await store();
    await expect(history.pruneObservations(Number.NaN)).rejects.toThrow(/cutoff/i);
    await expect(history.pruneObservations(now, { batchSize: 0 })).rejects.toThrow(/batch/i);
    await expect(history.pruneObservations(now, { maxBatches: 1.5 })).rejects.toThrow(/batch/i);
    await pool.end();
  });
});

describe("production worker bootstrap", () => {
  it("hydrates the committed revision after a worker restart", async () => {
    const pool = await database();
    const redis = new Redis();
    const registry = new InstrumentRegistry();
    for (const venue of ["a", "b"]) registry.upsert({
      instrumentId: `ins_${venue}`, underlyingId: "equity:DEMO", venue, venueSymbol: venue,
      productType: "perpetual", quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD",
      contractMultiplier: "1", tickSize: "0.01", lotSize: "0.001", minimumNotional: "10",
      capabilities: ["orderbook"], metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
      fundingInterval: 28_800_000,
      tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5], opensAt: "00:00", closesAt: "23:59" }] },
    });
    const members = ["a", "b"].map(venue => registry.getCurrent(`ins_${venue}`)!);
    registry.addReviewedMapping({
      underlyingId: "equity:DEMO", mappingVersion: 1, compatibleExposure: "one share",
      reviewer: "reviewer", reviewedAt: "2026-09-20T00:00:00.000Z",
      members: members.map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
      proof: { contractMultiplier: "checked", settlementAsset: "checked", collateralAsset: "checked",
        tradingSchedule: "checked", economicExposure: "checked" },
    });
    const bus = new InMemoryEventBus();
    const now = 1_790_000_000_000;
    const policy = { requestedNotionalUsd: "100", minimumNotionalUsd: "10", holdingHorizonMs: 1_000,
      feesBpsByVenue: { a: "0", b: "0" }, slippageBpsByVenue: { a: "0", b: "0" },
      financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "0", debounceMs: 0 };
    const first = await startPersistentOpportunityWorker(bus, registry, policy, pool, redis, () => now);
    expect(first.worker.currentRevision("equity:DEMO")).toBe(0);
    await bus.publish("book.state.v1", "ins_a", parseEvent("book.state.v1", {
      eventId: "evt_book_a", schemaVersion: 1, venue: "a", instrumentId: "ins_a", transport: "replay",
      sourceTimestamp: now - 10, receivedTimestamp: now, freshnessBudgetMs: 1_000, qualityFlags: [],
      rawPayloadRefOrHash: "sha256:synthetic", eligibility: "live",
      payload: { kind: "order_book", bids: [{ price: "100", quantity: "10" }],
        asks: [{ price: "101", quantity: "10" }], capacityUsd: "1000" },
    }));
    expect(first.worker.currentRevision("equity:DEMO")).toBe(1);
    await first.stop();
    const second = await startPersistentOpportunityWorker(bus, registry, policy, pool, redis, () => now);
    expect(second.worker.currentRevision("equity:DEMO")).toBe(1);
    await second.stop();
    redis.disconnect();
    await pool.end();
  });
});
