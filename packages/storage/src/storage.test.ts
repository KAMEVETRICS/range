import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import Redis from "ioredis-mock";
import { DataType, newDb } from "pg-mem";
import { CurrentStateStore, type RedisCommands } from "./current-state.js";
import { HistoryStore, PostgresRevisionAuthority } from "./history.js";
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
  await pool.query(await readFile(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8"));
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

  it("does not promote rejected events and fails closed when the authority is unavailable", async () => {
    const redis = new Redis();
    const now = Date.now();
    let failure = false;
    const store = new CurrentStateStore(redis, { read: async () => { if (failure) throw new Error("offline"); return 3; } }, () => now);
    await store.putOpportunity(opportunity(3, now + 1000));
    expect(await store.getOpportunity("opp_test")).toBeUndefined();
    failure = true;
    await expect(store.putOpportunity(opportunity(3, now + 1000))).rejects.toThrow("offline");
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
      eval: redis.eval.bind(redis), get: redis.get.bind(redis),
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
